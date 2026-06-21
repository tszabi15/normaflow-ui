import { setGlobalOptions } from "firebase-functions/v2";
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import { OpenAI } from "openai";
import * as nodemailer from "nodemailer";
import express from "express";
import cors from "cors";
import * as crypto from "crypto";
import rateLimit from "express-rate-limit";
import Stripe from "stripe";
import { ImapFlow } from "imapflow";
import { Readable } from "stream";

// Set global options for the functions (max instances for budget/cost control)
setGlobalOptions({ maxInstances: 10 });

// Initialize Firebase Admin
admin.initializeApp();
const db = getFirestore();

// Initialize Stripe Node SDK
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");

// Application-layer Rate Limiter (Anti-Denial of Wallet)
// Throttle requests per window Ms per unique target IP
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // Limit each IP to 60 requests per minute
  standardHeaders: true, // Return rate limit info in standard headers
  legacyHeaders: false, // Disable legacy X-RateLimit headers
  message: {
    error: "Too Many Requests",
    message: "Túllépte a megengedett kérelmek számát. Kérjük próbálja meg később!"
  }
});

// ─── Interfaces ──────────────────────────────────────────────────────────────

interface FeedbackSubmitRequest {
  title: string;
  category: string;
  description?: string;
  user_email: string;
}

interface EmailConfig {
  email: string;
  password?: string;
  smtp_host?: string;
  smtp_port?: number | string;
  connected_at?: string;
}

interface SendAiReplyRequest {
  taskId: string;
  replyBody: string;
  recipientEmail: string;
}

interface UserQuota {
  tier: 'none' | 'basic' | 'pro' | 'ultra';
  processedEmailsThisMonth: number;
  subscriptionStatus: string;
}


/** Extract and verify JWT from Authorization header */
async function verifyAuthToken(req: any): Promise<{ email: string; uid: string } | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const idToken = authHeader.split("Bearer ")[1];
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    return decoded.email ? { email: decoded.email, uid: decoded.uid } : null;
  } catch {
    return null;
  }
}


/** AES-256-GCM encryption for SMTP passwords */
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 32;
const TAG_LENGTH = 16;
const TAG_POSITION = SALT_LENGTH + IV_LENGTH;
const ENCRYPTED_POSITION = TAG_POSITION + TAG_LENGTH;

function getKey(salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(process.env.ENCRYPTION_KEY || '', salt, 100000, 32, 'sha256');
}

export function encrypt(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = getKey(salt);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, Buffer.from(encrypted, 'hex')]).toString('base64');
}

export function decrypt(encryptedData: string): string {
  const buffer = Buffer.from(encryptedData, 'base64');
  const salt = buffer.subarray(0, SALT_LENGTH);
  const iv = buffer.subarray(SALT_LENGTH, TAG_POSITION);
  const tag = buffer.subarray(TAG_POSITION, ENCRYPTED_POSITION);
  const encrypted = buffer.subarray(ENCRYPTED_POSITION);
  const key = getKey(salt);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encrypted);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString('utf8');
}

/** Check if a user has an active subscription */
async function checkSubscription(userEmail: string): Promise<boolean> {
  const userDoc = await db.collection("users").doc(userEmail).get();
  return userDoc.exists && userDoc.data()?.subscriptionStatus === "active";
}

/** Get user quota information for tier enforcement */
async function getUserQuota(userId: string): Promise<UserQuota | null> {
  try {
    const userQuery = await db.collection("users").where("uid", "==", userId).limit(1).get();
    if (userQuery.empty) return null;
    const userDoc = userQuery.docs[0];
    const data = userDoc.data();
    return {
      tier: data?.tier || 'none',
      processedEmailsThisMonth: data?.processedEmailsThisMonth || 0,
      subscriptionStatus: data?.subscriptionStatus || 'none'
    };
  } catch (err) {
    logger.error("Failed to fetch user quota:", err);
    return null;
  }
}

/** Check if user has exceeded their tier limit */
function hasExceededQuota(quota: UserQuota): boolean {
  const TIER_LIMITS: Record<string, number> = {
    none: 0,
    basic: 500,
    pro: 1500,
    ultra: 5000
  };
  const limit = TIER_LIMITS[quota.tier] || 0;
  return quota.processedEmailsThisMonth >= limit;
}

async function resolveSmtpConfig(userEmail: string, preferredEmail?: string): Promise<EmailConfig | null> {
  let config: EmailConfig | null = null;
  
  if (preferredEmail) {
    const connSnap = await db.collection("users").doc(userEmail).collection("email_connections")
      .where("email", "==", preferredEmail)
      .limit(1)
      .get();
    if (!connSnap.empty) {
      config = connSnap.docs[0].data() as EmailConfig;
    }
  }

  if (!config) {
    const connsSnap = await db.collection("users").doc(userEmail).collection("email_connections").limit(1).get();
    if (!connsSnap.empty) {
      config = connsSnap.docs[0].data() as EmailConfig;
    }
  }

  if (!config) {
    const legacyDoc = await db.doc(`users/${userEmail}/tokens/email_config`).get();
    if (legacyDoc.exists) {
      config = legacyDoc.data() as EmailConfig;
    }
  }

  if (config && config.password) {
    try {
      config.password = decrypt(config.password);
    } catch (err) {
      logger.error("Failed to decrypt SMTP password:", err);
      return null;
    }
  }

  return config;
}

/**
 * Ingress Channel 1: Cloudflare Email Workers Webhook
 * Hardened endpoint: `/webhook/cloudflare-inbound`
 * Authenticates request using X-Normaflow-Signature header against CLOUDFLARE_WORKER_SECRET.
 * Input: POST JSON payload: { extractedUid, sender, subject, textContent }
 */
interface CloudflareInboundRequest {
  extractedUid: string;
  sender: string;
  subject: string;
  textContent: string;
}

const cloudflareInboundWebhookLogic: express.RequestHandler = async (req, res): Promise<void> => {
  try {
    if (req.method !== "POST") {
      logger.warn(`cloudflareInboundWebhook: Method Not Allowed: ${req.method}`);
      res.status(405).json({ error: "Method Not Allowed" });
      return;
    }

    // Secure the route with header validation handshake
    const signature = req.headers["x-normaflow-signature"];
    const secret = process.env.CLOUDFLARE_WORKER_SECRET || "";
    if (!secret || signature !== secret) {
      logger.warn("cloudflareInboundWebhook: Unauthorized request signature.");
      res.status(401).json({ error: "Unauthorized: Invalid signature" });
      return;
    }

    const { extractedUid, sender, subject, textContent } = req.body as CloudflareInboundRequest;
    if (!extractedUid || !sender || !subject || !textContent) {
      logger.warn("cloudflareInboundWebhook: Missing required payload properties");
      res.status(400).json({ error: "Bad Request: Missing parameters" });
      return;
    }

    // Map extractedUid to registered email address
    const userQuery = await db.collection("users").where("uid", "==", extractedUid).limit(1).get();
    if (userQuery.empty) {
      logger.warn(`cloudflareInboundWebhook: User with UID ${extractedUid} not found`);
      res.status(404).json({ error: "User not found" });
      return;
    }
    const userDoc = userQuery.docs[0];
    const userEmail = userDoc.id;

    logger.info(`cloudflareInboundWebhook: Ingesting email for UID ${extractedUid} (${userEmail})`);
    
    let cleanSender = sender.trim();
    if (cleanSender.includes("<")) {
      const match = cleanSender.match(/<([^>]+)>/);
      if (match && match[1]) cleanSender = match[1].trim();
    }
    cleanSender = cleanSender.toLowerCase().trim();

    // Slice input to a strict maximum of 6000 characters
    const slicedText = textContent.slice(0, 6000);

    const emailDocRef = await db.collection("emails").add({
      user_id: extractedUid,
      sender: cleanSender,
      subject: subject || "Nincs tárgy",
      textContent: slicedText,
      received_at: new Date().toISOString(),
      status: "unread",
      received_via: "cloudflare_worker"
    });

    // Autonomous Trigger Hook (Transactional Quota Verification and AI Processing)
    try {
      const aiConfigDoc = await db.doc(`users/${extractedUid}/settings/ai_configuration`).get();
      if (aiConfigDoc.exists && aiConfigDoc.data()?.globalAutomationEnabled === true) {
        logger.info(`cloudflareInboundWebhook: Auto-processing email ${emailDocRef.id} for user UID ${extractedUid}`);
        await processEmailInternally(emailDocRef.id, userEmail);
      } else {
        logger.info(`cloudflareInboundWebhook: Automation disabled for user UID ${extractedUid}, email saved without AI processing`);
      }
    } catch (autoErr: unknown) {
      const autoErrMsg = autoErr instanceof Error ? autoErr.message : String(autoErr);
      logger.error(`cloudflareInboundWebhook: Autonomous processing check failed for email ${emailDocRef.id}:`, autoErrMsg);
    }

    res.status(200).json({
      status: "success",
      emailId: emailDocRef.id
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Error in cloudflareInboundWebhook:", errorMessage);
    res.status(500).json({
      error: "Internal Server Error",
      message: errorMessage,
    });
  }
};

async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Ingress Channel 2: Distributed IMAP Polling (Cron Framework)
 * Scheduled Cloud Function running every 5 minutes.
 * Scans active users' Gmail inboxes for unseen messages, commits them, and flags them as read.
 */
export const scheduledImapPolling = onSchedule({
  schedule: "every 5 minutes",
  secrets: ["OPENAI_API_KEY", "ENCRYPTION_KEY"],
  maxInstances: 1, // Avoid overlapping runs
}, async (event): Promise<void> => {
  logger.info("scheduledImapPolling: Starting distributed IMAP poll loop.");

  try {
    const usersSnapshot = await db.collection("users")
      .where("subscriptionStatus", "==", "active")
      .get();

    logger.info(`scheduledImapPolling: Found ${usersSnapshot.size} active users to poll.`);

    for (const userDoc of usersSnapshot.docs) {
      const userEmail = userDoc.id;
      const userData = userDoc.data();
      const userId = userData.uid || userDoc.id;

      try {
        const connsSnapshot = await db.collection("users").doc(userEmail).collection("email_connections").get();
        if (connsSnapshot.empty) {
          logger.info(`scheduledImapPolling: No email connections found for user ${userEmail}`);
          continue;
        }

        for (const connDoc of connsSnapshot.docs) {
          const connData = connDoc.data();
          const emailAddress = connData.email;
          const encryptedPassword = connData.password;

          if (!emailAddress || !encryptedPassword) {
            logger.warn(`scheduledImapPolling: Missing email or password for connection ${connDoc.id} under ${userEmail}`);
            continue;
          }

          let decryptedPassword = "";
          try {
            decryptedPassword = decrypt(encryptedPassword);
          } catch (decryptErr: unknown) {
            const decryptErrMsg = decryptErr instanceof Error ? decryptErr.message : String(decryptErr);
            logger.error(`scheduledImapPolling: Failed to decrypt password for connection ${emailAddress} of user ${userEmail}`, decryptErrMsg);
            continue;
          }

          const client = new ImapFlow({
            host: "imap.gmail.com",
            port: 993,
            secure: true,
            auth: {
              user: emailAddress,
              pass: decryptedPassword,
            },
            logger: false,
          });

          try {
            await client.connect();
            logger.info(`scheduledImapPolling: Connected to IMAP for ${emailAddress}`);

            const lock = await client.getMailboxLock("INBOX");
            try {
              const sequenceNumbers = await client.search({ seen: false });
              if (sequenceNumbers && sequenceNumbers.length > 0) {
                logger.info(`scheduledImapPolling: Found ${sequenceNumbers.length} unseen messages for ${emailAddress}`);

                for (const seq of sequenceNumbers) {
                  const message = await client.fetchOne(String(seq), { envelope: true });
                  if (!message) continue;

                  let textContent = "";
                  try {
                    const downloadResult = await client.download(String(seq), "TEXT");
                    if (downloadResult && downloadResult.content) {
                      textContent = await streamToString(downloadResult.content);
                    }
                  } catch (downloadErr: unknown) {
                    const downloadErrMsg = downloadErr instanceof Error ? downloadErr.message : String(downloadErr);
                    logger.warn(`scheduledImapPolling: Could not download TEXT part for message ${seq}, trying full download`, downloadErrMsg);
                    try {
                      const downloadSource = await client.download(String(seq));
                      if (downloadSource && downloadSource.content) {
                        textContent = await streamToString(downloadSource.content);
                      }
                    } catch (sourceErr: unknown) {
                      const sourceErrMsg = sourceErr instanceof Error ? sourceErr.message : String(sourceErr);
                      logger.error(`scheduledImapPolling: Failed to download source for message ${seq}`, sourceErrMsg);
                    }
                  }

                  let cleanSender = "";
                  if (message.envelope && message.envelope.from && message.envelope.from.length > 0) {
                    const fromObj = message.envelope.from[0];
                    const address = fromObj.address || "";
                    cleanSender = address.toLowerCase().trim();
                  } else {
                    cleanSender = "unknown@inbound.normaflow.hu";
                  }

                  const subject = message.envelope?.subject || "Nincs tárgy";
                  const textContentSliced = textContent.slice(0, 6000);

                  const emailDocRef = await db.collection("emails").add({
                    user_id: userId,
                    sender: cleanSender,
                    subject: subject,
                    textContent: textContentSliced,
                    received_at: new Date().toISOString(),
                    status: "unread",
                    received_via: "imap"
                  });

                  try {
                    const aiConfigDoc = await db.doc(`users/${userId}/settings/ai_configuration`).get();
                    if (aiConfigDoc.exists && aiConfigDoc.data()?.globalAutomationEnabled === true) {
                      logger.info(`scheduledImapPolling: Auto-processing email ${emailDocRef.id} for user ${userEmail}`);
                      await processEmailInternally(emailDocRef.id, userEmail);
                    }
                  } catch (autoErr: unknown) {
                    const autoErrMsg = autoErr instanceof Error ? autoErr.message : String(autoErr);
                    logger.error(`scheduledImapPolling: Automatic processing failed for email ${emailDocRef.id}:`, autoErrMsg);
                  }

                  await client.messageFlagsAdd(String(seq), ["\\Seen"]);
                }
              } else {
                logger.info(`scheduledImapPolling: No unseen messages for ${emailAddress}`);
              }
            } finally {
              lock.release();
            }
          } catch (imapErr: unknown) {
            const imapErrMsg = imapErr instanceof Error ? imapErr.message : String(imapErr);
            logger.error(`scheduledImapPolling: IMAP error for connection ${emailAddress}:`, imapErrMsg);
          } finally {
            try {
              await client.logout();
            } catch (logoutErr: unknown) {
              const logoutErrMsg = logoutErr instanceof Error ? logoutErr.message : String(logoutErr);
              logger.error(`scheduledImapPolling: Logout failed for client:`, logoutErrMsg);
            }
          }
        }
      } catch (userErr: unknown) {
        const userErrMsg = userErr instanceof Error ? userErr.message : String(userErr);
        logger.error(`scheduledImapPolling: Failed to process connections for user ${userEmail}:`, userErrMsg);
      }
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Error in scheduledImapPolling main loop:", errorMessage);
  }
});

/**
 * SUBSYSTEM 2: handleFeedbackSubmit
 * Replaces Make.com webhook for the client-side Feedback Box.
 * Input: POST JSON payload: { title, category, description }
 * Authentication: Enforced ID Token validation via Authorization header
 */
const handleFeedbackSubmitLogic: express.RequestHandler = async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'GET, POST');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.status(204).send('');
      return;
    }

    // Validate Method
    if (req.method !== "POST") {
      logger.warn(`Method Not Allowed: ${req.method}`);
      res.status(405).json({ error: "Method Not Allowed" });
      return;
    }

    const { title, category, description } = req.body as Partial<FeedbackSubmitRequest>;

    // Step A: Validation
    if (!title || typeof title !== "string" || title.trim() === "" || !category || typeof category !== "string" || category.trim() === "") {
      logger.warn("Validation failed: missing or empty title or category");
      res.status(400).json({ error: "Bad Request" });
      return;
    }

    // Verify JWT ID Token from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      logger.warn("Unauthorized request to handleFeedbackSubmit: missing or invalid authorization header");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const idToken = authHeader.split("Bearer ")[1];
    if (!idToken || idToken.trim() === "") {
      logger.warn("Unauthorized request to handleFeedbackSubmit: empty token payload");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(idToken);
    } catch (err: any) {
      logger.error("Token verification failed:", err);
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const verifiedUserEmail = decodedToken.email;
    if (!verifiedUserEmail) {
      logger.warn("Unauthorized request to handleFeedbackSubmit: token contains no email");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    // Subscription check: verify user has an active subscription
    const userDoc = await admin.firestore().collection('users').doc(verifiedUserEmail).get();
    if (!userDoc.exists || userDoc.data()?.subscriptionStatus !== 'active') {
      logger.warn(`Forbidden request to handleFeedbackSubmit: user ${verifiedUserEmail} does not have an active subscription`);
      res.status(403).json({ error: "Forbidden: Active subscription required to submit feedback" });
      return;
    }

    // Step B: Firestore Ingestion using the cryptographically verified user email
    const feedbackPayload = {
      title,
      type: category, // category string maps to type field
      description: description || "",
      user_email: verifiedUserEmail,
      created_at: new Date().toISOString(),
    };

    logger.info("Saving feedback to Firestore...");
    const feedbackDocRef = await db.collection("feedbacks").add(feedbackPayload);
    logger.info(`Successfully saved feedback with ID: ${feedbackDocRef.id}`);

    res.status(200).json({
      status: "success",
      feedbackId: feedbackDocRef.id,
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Error in handleFeedbackSubmit:", errorMessage);
    res.status(500).json({
      error: "Internal Server Error",
      message: errorMessage,
    });
  }
};



// ─── SUBSYSTEM 5: sendAiReply (SMTP Email Sender) ───────────────────────────

/**
 * Sends the AI-generated reply as a real email via the accountant's
 * corporate SMTP server. JWT-authenticated + subscription-gated.
 * Input: { taskId, replyBody, recipientEmail }
 */
const sendAiReplyLogic: express.RequestHandler = async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Access-Control-Allow-Methods", "POST");
      res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.status(204).send("");
      return;
    }

    const { taskId, replyBody, recipientEmail } = req.body as Partial<SendAiReplyRequest>;
    if (!taskId || !replyBody || !recipientEmail) {
      res.status(400).json({ error: "Bad Request" });
      return;
    }

    // Auth
    const authResult = await verifyAuthToken(req);
    if (!authResult) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    // Subscription check
    if (!(await checkSubscription(authResult.email))) {
      res.status(403).send("Forbidden: Active subscription required");
      return;
    }

    // Load original task for subject threading
    const taskDoc = await db.collection("tasks").doc(taskId).get();
    const taskData = taskDoc.exists ? taskDoc.data() : null;
    const originalSubject = taskData?.subject || "Nincs tárgy";
    const sourceEmail = taskData?.source_email;

    // Load email config
    const config = await resolveSmtpConfig(authResult.email, sourceEmail);
    if (!config || !config.password || !config.smtp_host || !config.smtp_port) {
      res.status(400).json({ error: "Nincs beállítva kimenő SMTP fiók. Kérjük, adja meg a kapcsolatok beállításainál." });
      return;
    }

    const smtpPortNum = parseInt(String(config.smtp_port)) || 587;

    // Create nodemailer transport
    const transporter = nodemailer.createTransport({
      host: config.smtp_host,
      port: smtpPortNum,
      secure: smtpPortNum === 465,
      auth: {
        user: config.email,
        pass: config.password,
      },
    });

    // Send email
    await transporter.sendMail({
      from: config.email,
      to: recipientEmail,
      subject: `Re: ${originalSubject}`,
      text: replyBody,
    });

    // Update task status
    await db.collection("tasks").doc(taskId).update({
      ai_status: "sent",
      sent_at: new Date().toISOString(),
    });

    logger.info(`sendAiReply: Email sent by ${authResult.email} to ${recipientEmail} for task ${taskId}`);

    res.status(200).json({
      status: "success",
      message: "E-mail sikeresen elküldve.",
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("sendAiReply error:", errorMessage);
    res.status(500).json({ error: "Internal Server Error", message: errorMessage });
  }
};

/**
 * SUBSYSTEM 5: sendManualEmail
 * Authenticated POST endpoint to compose and send manual SMTP replies.
 */
const sendManualEmailLogic: express.RequestHandler = async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.status(204).send('');
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method Not Allowed" });
      return;
    }

    const { taskId, recipient, subject, body } = req.body as {
      taskId: string;
      recipient: string;
      subject: string;
      body: string;
    };

    if (!taskId || typeof taskId !== "string" || taskId.trim() === "" ||
        !recipient || typeof recipient !== "string" || recipient.trim() === "" ||
        !subject || typeof subject !== "string" || subject.trim() === "" ||
        !body || typeof body !== "string" || body.trim() === "") {
      res.status(400).json({ error: "Bad Request" });
      return;
    }

    // Auth header structure check
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const authResult = await verifyAuthToken(req);
    if (!authResult) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const userEmail = authResult.email;
    const isSubscribed = await checkSubscription(userEmail);
    if (!isSubscribed) {
      res.status(403).json({ error: "Forbidden: Active subscription required" });
      return;
    }

    let sourceMailbox: string | undefined;
    if (taskId) {
      const taskDoc = await db.collection("tasks").doc(taskId).get();
      if (taskDoc.exists) {
        const data = taskDoc.data();
        sourceMailbox = data?.source_mailbox || data?.source_email;
      }
    }

    if (!sourceMailbox) {
      sourceMailbox = userEmail;
    }

    // Query email_connections subcollection matching this email address, or fallback to any
    const config = await resolveSmtpConfig(userEmail, sourceMailbox);

    if (!config || !config.password || !config.smtp_host || !config.smtp_port) {
      res.status(400).json({
        error: "SMTP_NOT_CONFIGURED",
        message: `Nincs beállítva kimenő SMTP fiók ehhez a címhez: ${sourceMailbox}`
      });
      return;
    }

    const smtpPortNum = parseInt(String(config.smtp_port)) || 587;

    // Setup nodemailer
    const transporter = nodemailer.createTransport({
      host: config.smtp_host,
      port: smtpPortNum,
      secure: smtpPortNum === 465,
      auth: {
        user: config.email,
        pass: config.password,
      },
    });

    await transporter.sendMail({
      from: `"${userEmail}" <${config.email}>`,
      to: recipient,
      subject: subject,
      text: body,
    });

    // Update task status in Firestore to completed
    await db.collection("tasks").doc(taskId).update({
      status: "completed",
      ai_status: "sent",
      ai_reply: body,
      replied_at: new Date().toISOString(),
    });

    res.status(200).json({ status: "success", message: "Email sent manually and task updated." });
  } catch (err: any) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error("Error in sendManualEmail:", errMsg);
    res.status(500).json({ error: "Internal Server Error", message: errMsg });
  }
};

/**
 * SUBSYSTEM 6: improveEmailDraft
 * Authenticated POST endpoint to professionalize draft content using AI.
 */
const improveEmailDraftLogic: express.RequestHandler = async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.status(204).send('');
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method Not Allowed" });
      return;
    }

    const { text } = req.body as { text: string };
    if (!text || typeof text !== "string" || text.trim() === "") {
      res.status(400).json({ error: "Bad Request" });
      return;
    }

    // Auth header structure check
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const authResult = await verifyAuthToken(req);
    if (!authResult) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const userEmail = authResult.email;
    const isSubscribed = await checkSubscription(userEmail);
    if (!isSubscribed) {
      res.status(403).json({ error: "Forbidden: Active subscription required" });
      return;
    }

    // Hardening: Resolve the user's specific billing account tracking document using getUserQuota
    const userQuota = await getUserQuota(authResult.uid);
    if (!userQuota) {
      res.status(403).json({ error: "Forbidden: Failed to resolve billing account tracking" });
      return;
    }

    // Run the quota consumption check
    if (hasExceededQuota(userQuota)) {
      res.status(403).json({ error: "Forbidden: Monthly email quota limit exceeded" });
      return;
    }

    if (!process.env.OPENAI_API_KEY) {
      res.status(500).json({ error: "OpenAI API key not configured" });
      return;
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are an expert business assistant. Refine, professionalize, and fix grammatical mistakes for the following Hungarian email draft. Keep the format clean and polite. Return ONLY the enhanced message text.",
        },
        { role: "user", content: text },
      ],
      max_tokens: 600,
    });

    const enhancedText = response.choices[0]?.message?.content?.trim() || text;
    res.status(200).json({ status: "success", text: enhancedText });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error("Error in improveEmailDraft:", errMsg);
    res.status(500).json({ error: "Internal Server Error", message: errMsg });
  }
};

interface VerifySubscriptionRequest {
  tier: string;
  stripeSessionId: string;
}

const verifySubscriptionLogic: express.RequestHandler = async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.status(204).send('');
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method Not Allowed" });
      return;
    }

    const authResult = await verifyAuthToken(req);
    if (!authResult) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { tier, stripeSessionId } = req.body as Partial<VerifySubscriptionRequest>;
    if (!tier || !["basic", "pro", "ultra"].includes(tier)) {
      res.status(400).json({ error: "Bad Request", message: "Invalid or missing tier" });
      return;
    }

    // Harden against payment fraud by validating the stripeSessionId payment receipt token placeholder
    if (!stripeSessionId || typeof stripeSessionId !== "string" || stripeSessionId.trim() === "") {
      res.status(402).json({ error: "Payment Required", message: "Payment receipt token (stripeSessionId) is missing or blank" });
      return;
    }

    logger.info(`verifySubscriptionLogic: Updating user ${authResult.email} to tier ${tier} (session: ${stripeSessionId})`);

    const userRef = db.collection("users").doc(authResult.email);
    await userRef.set({
      subscriptionStatus: "active",
      tier: tier,
      processedEmailsThisMonth: 0,
    }, { merge: true });

    res.status(200).json({ status: "success", message: `Előfizetés sikeresen aktiválva: ${tier}` });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error("Error in verifySubscription:", errMsg);
    res.status(500).json({ error: "Internal Server Error", message: errMsg });
  }
};

/**
 * Automated Monthly Quota Reset Cron Job
 * Runs deterministically at midnight (00:00) on the 1st of every month.
 * Resets processedEmailsThisMonth counter back to 0 for all user profiles.
 */
export const resetMonthlyQuota = onSchedule({ schedule: "0 0 1 * *" }, async () => {
  logger.info("Starting resetMonthlyQuota cron job...");
  try {
    const usersSnapshot = await db.collection("users").get();
    if (usersSnapshot.empty) {
      logger.info("No users found to reset quota.");
      return;
    }

    let batch = db.batch();
    let count = 0;
    let totalCount = 0;

    for (const doc of usersSnapshot.docs) {
      batch.update(doc.ref, {
        processedEmailsThisMonth: 0
      });
      count++;
      totalCount++;

      // Commit batches of 500 operations to satisfy Firestore write limits
      if (count === 500) {
        await batch.commit();
        batch = db.batch();
        count = 0;
      }
    }

    if (count > 0) {
      await batch.commit();
    }
    logger.info(`Successfully reset monthly quota for ${totalCount} users.`);
  } catch (err: any) {
    logger.error("Error in resetMonthlyQuota cron job:", err);
  }
});

/**
 * Automated Daily Task Cleanup Cron Job
 * Runs daily at midnight.
 * Deletes tasks in status "archived" where archivedAt is older than 30 days.
 */
export const cleanupExpiredTasks = onSchedule({ schedule: "0 0 * * *" }, async () => {
  logger.info("Starting cleanupExpiredTasks job...");
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  try {
    const expiredTasksQuery = await db.collection("tasks")
      .where("status", "==", "archived")
      .get();

    if (expiredTasksQuery.empty) {
      logger.info("No archived tasks found.");
      return;
    }

    const batch = db.batch();
    let count = 0;

    expiredTasksQuery.docs.forEach((doc) => {
      const data = doc.data();
      const archivedAt = data.archivedAt;
      if (archivedAt) {
        const archivedDate = archivedAt.toDate ? archivedAt.toDate() : new Date(archivedAt);
        if (archivedDate < thirtyDaysAgo) {
          logger.info(`Adding task ID ${doc.id} to deletion batch.`);
          batch.delete(doc.ref);
          count++;
        }
      }
    });

    if (count > 0) {
      await batch.commit();
      logger.info(`Successfully deleted ${count} expired archived tasks.`);
    } else {
      logger.info("No expired archived tasks older than 30 days found.");
    }
  } catch (err: any) {
    logger.error("Error in cleanupExpiredTasks:", err);
  }
});

/**
 * Archive Task (Soft Delete)
 * Marks a task as status: "archived" and sets archivedAt timestamp.
 */
const archiveTaskLogic: express.RequestHandler = async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method Not Allowed" });
      return;
    }

    const { taskId } = req.body as { taskId: string };
    if (!taskId || typeof taskId !== "string" || taskId.trim() === "") {
      res.status(400).json({ error: "Bad Request" });
      return;
    }

    // Auth header structure check
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const verifiedUser = await verifyAuthToken(req);
    if (!verifiedUser) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const isSubscribed = await checkSubscription(verifiedUser.email);
    if (!isSubscribed) {
      res.status(403).json({ error: "Forbidden: Active subscription required" });
      return;
    }

    const taskRef = db.collection("tasks").doc(taskId);
    const taskDoc = await taskRef.get();
    if (!taskDoc.exists) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    if (taskDoc.data()?.user_email !== verifiedUser.email) {
      res.status(403).json({ error: "Forbidden: You do not own this task" });
      return;
    }

    await taskRef.update({
      status: "archived",
      archivedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(200).json({ status: "success", taskId });
  } catch (err: any) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error("Error in archiveTask:", errMsg);
    res.status(500).json({ error: "Internal Server Error", message: errMsg });
  }
};

/**
 * Restore Task (Undo Soft Delete)
 * Sets task status to "active", clears archivedAt, and resets ai_status to "pending_review".
 */
const restoreTaskLogic: express.RequestHandler = async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method Not Allowed" });
      return;
    }

    const { taskId } = req.body as { taskId: string };
    if (!taskId || typeof taskId !== "string" || taskId.trim() === "") {
      res.status(400).json({ error: "Bad Request" });
      return;
    }

    // Auth header structure check
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const verifiedUser = await verifyAuthToken(req);
    if (!verifiedUser) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const isSubscribed = await checkSubscription(verifiedUser.email);
    if (!isSubscribed) {
      res.status(403).json({ error: "Forbidden: Active subscription required" });
      return;
    }

    const taskRef = db.collection("tasks").doc(taskId);
    const taskDoc = await taskRef.get();
    if (!taskDoc.exists) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    if (taskDoc.data()?.user_email !== verifiedUser.email) {
      res.status(403).json({ error: "Forbidden: You do not own this task" });
      return;
    }

    await taskRef.update({
      status: "active",
      archivedAt: null,
    });

    res.status(200).json({ status: "success", taskId });
  } catch (err: any) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error("Error in restoreTask:", errMsg);
    res.status(500).json({ error: "Internal Server Error", message: errMsg });
  }
};

// ─── Process Email With AI ──────────────────────────────────────────────────

/**
 * Internal helper: 2-phase AI processing for a single email document.
 * Can be called from both the HTTP endpoint and the background sync hook.
 * Returns { status, taskId? } or throws on error.
 */
async function processEmailInternally(emailId: string, userEmail: string): Promise<{ status: string; taskId?: string; reason?: string }> {
  const emailRef = db.collection("emails").doc(emailId);
  const emailDoc = await emailRef.get();
  if (!emailDoc.exists) {
    return { status: "not_found" };
  }

  const emailData = emailDoc.data()!;

  // Load unified AI configuration from users/{userId}/settings/ai_configuration
  let userId = emailData.user_id || "";
  if (!userId) {
    const userQuery = await db.collection("users").where("email", "==", userEmail).limit(1).get();
    if (!userQuery.empty) {
      userId = userQuery.docs[0].data().uid || userQuery.docs[0].id;
    }
  }

  let customPriorityRules = "";
  let customReplyRules = "";
  let exclusionRules = "";
  if (userId) {
    const aiConfigDoc = await db.doc(`users/${userId}/settings/ai_configuration`).get();
    if (aiConfigDoc.exists) {
      const data = aiConfigDoc.data();
      customPriorityRules = data?.customPriorityRules || "";
      customReplyRules = data?.customReplyRules || "";
      exclusionRules = data?.exclusionRules || "";
    }
  }

  const sender = emailData.sender || "";
  const subject = emailData.subject || "Nincs tárgy";
  const rawTextContent = emailData.textContent || "";
  // Enforce strict bounding logic: Truncate raw incoming text stream cleanly to protect API budget
  const textContent = rawTextContent.slice(0, 6000);

  // Firestore Transaction to prevent TOCTOU race condition (atomically check & increment)
  try {
    await db.runTransaction(async (transaction) => {
      const userRef = db.collection("users").doc(userEmail);
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) {
        throw new Error("user_not_found");
      }

      const userData = userDoc.data();
      if (!userData) {
        throw new Error("user_not_found");
      }

      const subscriptionStatus = userData.subscriptionStatus || "none";
      if (subscriptionStatus !== "active") {
        throw new Error("subscription_inactive");
      }

      const tier = (userData.tier || "none") as 'none' | 'basic' | 'pro' | 'ultra';
      const processedEmailsThisMonth = userData.processedEmailsThisMonth || 0;

      const TIER_LIMITS: Record<string, number> = {
        none: 0,
        basic: 500,
        pro: 1500,
        ultra: 5000
      };
      const limit = TIER_LIMITS[tier] || 0;

      if (processedEmailsThisMonth >= limit) {
        throw new Error("quota_exceeded");
      }

      // Atomically increment the usage counter inside the transaction
      transaction.update(userRef, {
        processedEmailsThisMonth: admin.firestore.FieldValue.increment(1)
      });
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg === "quota_exceeded") {
      logger.warn(`processEmailInternally: User ${userEmail} quota exceeded during transactional check.`);
      await emailRef.update({ status: "quota_exceeded" });
      return { status: "quota_exceeded", reason: "Tier limit exceeded" };
    }
    if (errMsg === "subscription_inactive") {
      logger.warn(`processEmailInternally: User ${userEmail} subscription is inactive.`);
      await emailRef.update({ status: "subscription_inactive" });
      return { status: "subscription_inactive", reason: "Active subscription required" };
    }
    logger.error(`processEmailInternally: Transaction failure for ${userEmail}:`, errMsg);
    return { status: "quota_error" };
  }

  if (!process.env.OPENAI_API_KEY) {
    logger.warn("processEmailInternally: OPENAI_API_KEY not set, skipping AI processing.");
    return { status: "no_api_key" };
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  try {
    // ── PHASE 1: AI Pre-Filter ──────────────────────────────────────────────
    if (exclusionRules.trim()) {
      try {
        const filterPrompt = `Te a NormaFlow AI szűrője vagy. A feladatod eldönteni, hogy az alábbi e-mail releváns-e egy könyvelőiroda számára, vagy figyelmen kívül hagyható.

A felhasználó szűrési szabályai (milyen leveleket HAGYJON figyelmen kívül):
${exclusionRules}

A választ szigorúan JSON formátumban add vissza:
- "relevant": boolean (true ha a levél releváns és feldolgozandó, false ha figyelmen kívül hagyható)
- "reason": string (rövid indoklás magyarul)`;

        const filterUserPrompt = `Feladó: ${sender}\nTárgy: ${subject}\nÜzenet:\n${textContent.substring(0, 1500)}`;

        const filterResponse = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: filterPrompt },
            { role: "user", content: filterUserPrompt },
          ],
          response_format: { type: "json_object" },
          max_tokens: 200,
        });
        let filterResult: any;
        try {
          filterResult = JSON.parse(filterResponse.choices[0]?.message?.content || "{}");
        } catch (parseErr) {
          logger.error(`processEmailInternally: Failed to parse filter JSON for ${userEmail}:`, parseErr);
          // On parse error, proceed to task generation anyway
          filterResult = { relevant: true, reason: "Parse error, proceeding with processing" };
        }

        if (filterResult.relevant === false) {
          await emailRef.update({
            status: "filtered",
            filter_reason: filterResult.reason || "AI szűrő kiszűrte"
          });
          logger.info(`processEmailInternally: Email ${emailId} filtered out. Reason: ${filterResult.reason}`);
          return { status: "filtered", reason: filterResult.reason || "AI szűrő kiszűrte" };
        }
      } catch (filterErr) {
        logger.error(`processEmailInternally: AI pre-filter error for ${userEmail}:`, filterErr);
        // On filter error, proceed to task generation anyway
      }
    }

    // ── PHASE 2: Task Generation ────────────────────────────────────────────
    let aiReplyDraft: string | null = null;
    let aiSummary = "Nem sikerült összefoglalót készíteni.";
    let aiPriorityReason = "";
    let priorityNum = 3;

    try {
      const systemPrompt = `You are a rigorous, no-nonsense AI accounting assistant. Analyze the provided email payload and return a strict JSON object containing: "summary", "action_items", "priority", "priority_reason", and "reply_draft".

Baseline Priority Logic (Unless overridden by the user's custom priority rules):
- "Sürgős": Legal/tax deadlines (áfa, bérszámfejtés, NAV, inkasszó), actions required within 48h.
- "Közepes": Standard invoice uploads, tax questions without immediate threat, company data updates.
- "Alacsony": General greetings, thank you notes, future meeting scheduling.

---
[USER-DEFINED CUSTOM PRIORITIZATION INSTRUCTIONS]
${customPriorityRules.trim() || "No custom priority rules provided. Rely purely on the baseline logic."}

---
[USER-DEFINED CUSTOM REPLY DRAFTING INSTRUCTIONS]
${customReplyRules.trim() || "No custom reply rules provided. Draft a formal, professional response in Hungarian."}`;

      const userPrompt = `[ORIGINAL EMAIL DATA TO PROCESS]
Feladó: ${sender}
Tárgy: ${subject}
Dátum: ${emailData.received_at || new Date().toISOString()}
Levél szövege: 
${textContent}`;

      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        max_tokens: 1000,
      });
      let result: any;
      try {
        result = JSON.parse(response.choices[0]?.message?.content || "{}");
      } catch (parseErr) {
        logger.error(`processEmailInternally: Failed to parse task generation JSON for ${userEmail}:`, parseErr);
        // Fallback to default manual review task on parse error
        result = {
          summary: subject || "E-mail feldolgozása",
          action_items: "Manuális felülvizsgálat szükséges",
          priority: "Közepes",
          priority_reason: "AI parse error, requires manual review",
          reply_draft: null
        };
      }

      const baseSummary = result.summary || "Nem sikerült összefoglalót készíteni.";
      const actionItems = result.action_items || "";
      if (actionItems) {
        const itemsFormatted = Array.isArray(actionItems)
          ? actionItems.map((item: string) => `- ${item}`).join("\n")
          : String(actionItems);
        aiSummary = `${baseSummary}\n\nTeendők:\n${itemsFormatted}`;
      } else {
        aiSummary = baseSummary;
      }

      aiPriorityReason = result.priority_reason || "";
      const aiPriorityStr = result.priority || "Közepes";
      if (aiPriorityStr === "Sürgős") {
        priorityNum = 5;
      } else if (aiPriorityStr === "Közepes") {
        priorityNum = 3;
      } else if (aiPriorityStr === "Alacsony") {
        priorityNum = 2;
      }

      aiReplyDraft = result.reply_draft || null;
    } catch (aiErr) {
      logger.error(`processEmailInternally: AI task generation error for ${userEmail}:`, aiErr);
      // Fallback to default manual review task on AI error
      aiSummary = `${subject || "E-mail feldolgozása"}\n\nManuális felülvizsgálat szükséges (AI hiba)`;
      aiPriorityReason = "AI processing error, requires manual review";
      priorityNum = 3;
      aiReplyDraft = null;
    }

    // Create task in the tasks collection
    const nextStep = aiReplyDraft ? "AI választervezet felülvizsgálata" : "Manuális válasz írása szükséges";
    const taskRef = await db.collection("tasks").add({
      category: "E-mail",
      summary: subject,
      next_step: nextStep,
      priority: priorityNum,
      received_at: emailData.received_at || new Date().toISOString(),
      sender,
      subject,
      user_email: userEmail,
      user_id: emailData.user_id || "",
      status: "active",
      archivedAt: null,
      ai_status: "pending_review",
      ai_reply: aiReplyDraft,
      ai_summary: aiSummary,
      ai_priority_reason: aiPriorityReason,
      textContent,
      source_mailbox: emailData.source_mailbox || "",
      received_via: emailData.received_via || "imap",
      sourceEmailId: emailId,
    });

    // Mark the email as processed
    await emailRef.update({ status: "processed" });

    return { status: "success", taskId: taskRef.id };
  } catch (executionErr: unknown) {
    // Rollback the counter increment in case of failure
    logger.error(`processEmailInternally: Execution error, rolling back increment:`, executionErr);
    try {
      await db.collection("users").doc(userEmail).update({
        processedEmailsThisMonth: admin.firestore.FieldValue.increment(-1)
      });
    } catch (rollbackErr) {
      logger.error(`processEmailInternally: Rollback failed for user ${userEmail}:`, rollbackErr);
    }
    throw executionErr;
  }
}

/**
 * HTTP endpoint: Thin auth wrapper around processEmailInternally.
 */
const processEmailWithAiLogic: express.RequestHandler = async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Access-Control-Allow-Methods", "POST");
      res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.status(204).send("");
      return;
    }

    const { emailId } = req.body as { emailId?: string };
    if (!emailId) {
      res.status(400).json({ error: "Bad Request: emailId is required" });
      return;
    }

    const authResult = await verifyAuthToken(req);
    if (!authResult) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    if (!(await checkSubscription(authResult.email))) {
      res.status(403).json({ error: "Forbidden: Active subscription required" });
      return;
    }

    // Verify ownership
    const emailDoc = await db.collection("emails").doc(emailId).get();
    if (!emailDoc.exists) {
      res.status(404).json({ error: "Email not found" });
      return;
    }
    const emailData = emailDoc.data()!;
    if (emailData.user_id !== authResult.uid && emailData.user_email !== authResult.email) {
      res.status(403).json({ error: "Forbidden: You do not own this email" });
      return;
    }

    const result = await processEmailInternally(emailId, authResult.email);
    if (result.status === "filtered") {
      res.status(200).json({ status: "filtered", reason: result.reason });
    } else if (result.status === "success") {
      res.status(200).json({ status: "success", taskId: result.taskId });
    } else {
      res.status(400).json({ error: result.status });
    }
  } catch (err: any) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error("Error in processEmailWithAi:", errMsg);
    res.status(500).json({ error: "Internal Server Error", message: errMsg });
  }
};

/**
 * SUBSYSTEM 9: deleteEmail
 * Soft deletes an email by setting status to "deleted".
 */
const deleteEmailLogic: express.RequestHandler = async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Access-Control-Allow-Methods", "DELETE");
      res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.status(204).send("");
      return;
    }

    if (req.method !== "DELETE") {
      res.status(405).json({ error: "Method Not Allowed" });
      return;
    }

    const emailId = req.params.emailId;
    if (!emailId || typeof emailId !== "string") {
      res.status(400).json({ error: "Missing or invalid emailId parameter" });
      return;
    }

    const authResult = await verifyAuthToken(req);
    if (!authResult) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const emailDoc = await db.collection("emails").doc(emailId).get();
    if (!emailDoc.exists) {
      res.status(404).json({ error: "Email not found" });
      return;
    }

    const emailData = emailDoc.data()!;
    if (emailData.user_id !== authResult.uid && emailData.user_email !== authResult.email) {
      res.status(403).json({ error: "Forbidden: You do not own this email" });
      return;
    }

    await db.collection("emails").doc(emailId).update({ status: "deleted" });

    res.status(200).json({ status: "success", message: "Email marked as deleted" });
  } catch (err: any) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error("Error in deleteEmail:", errMsg);
    res.status(500).json({ error: "Internal Server Error", message: errMsg });
  }
};

const stripeWebhookHandler: express.RequestHandler = async (req, res) => {
  const sig = req.headers["stripe-signature"];
  if (!sig || typeof sig !== "string") {
    res.status(400).send("Webhook Error: Missing stripe-signature header");
    return;
  }

  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET || "";
  if (!endpointSecret) {
    logger.error("stripeWebhookHandler: STRIPE_WEBHOOK_SECRET environment variable is not configured");
    res.status(500).send("Webhook Configuration Error");
    return;
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error("stripeWebhookHandler: Signature verification failed:", errMsg);
    res.status(400).send(`Webhook Error: ${errMsg}`);
    return;
  }

  logger.info(`stripeWebhookHandler: Received Stripe event: ${event.type}`);

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const customerEmail = session.customer_details?.email || session.metadata?.email || session.metadata?.userEmail;
        if (!customerEmail) {
          logger.warn("stripeWebhookHandler: No customer email resolved for checkout.session.completed");
          break;
        }

        const tier = (session.metadata?.tier || "basic") as 'basic' | 'pro' | 'ultra';

        logger.info(`stripeWebhookHandler: Setting user ${customerEmail} subscription to active, tier ${tier}`);
        await db.collection("users").doc(customerEmail).set({
          subscriptionStatus: "active",
          tier: tier,
          processedEmailsThisMonth: 0
        }, { merge: true });
        break;
      }

      case "customer.subscription.created": {
        const subscription = event.data.object as Stripe.Subscription;
        const customerEmail = subscription.metadata?.email || subscription.metadata?.userEmail;
        if (!customerEmail) {
          logger.warn("stripeWebhookHandler: No email metadata resolved for customer.subscription.created");
          break;
        }

        const tier = (subscription.metadata?.tier || "basic") as 'basic' | 'pro' | 'ultra';

        logger.info(`stripeWebhookHandler: Setting user ${customerEmail} subscription to active, tier ${tier}`);
        await db.collection("users").doc(customerEmail).set({
          subscriptionStatus: "active",
          tier: tier,
          processedEmailsThisMonth: 0
        }, { merge: true });
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const customerEmail = subscription.metadata?.email || subscription.metadata?.userEmail;
        if (!customerEmail) {
          logger.warn("stripeWebhookHandler: No email metadata resolved for customer.subscription.deleted");
          break;
        }

        logger.info(`stripeWebhookHandler: Degrading subscription state for user ${customerEmail} due to deletion`);
        await db.collection("users").doc(customerEmail).set({
          subscriptionStatus: "inactive",
          tier: "none"
        }, { merge: true });
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerEmail = invoice.customer_email || invoice.metadata?.email || invoice.metadata?.userEmail;
        if (!customerEmail) {
          logger.warn("stripeWebhookHandler: No email metadata resolved for invoice.payment_failed");
          break;
        }

        logger.info(`stripeWebhookHandler: Suspending subscription for user ${customerEmail} due to failed invoice payment`);
        await db.collection("users").doc(customerEmail).set({
          subscriptionStatus: "suspended",
          tier: "none"
        }, { merge: true });
        break;
      }

      default:
        logger.info(`stripeWebhookHandler: Unhandled event type: ${event.type}`);
    }

    res.status(200).json({ received: true });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(`stripeWebhookHandler: Error processing event ${event.type}:`, errMsg);
    res.status(500).send(`Internal Server Error: ${errMsg}`);
  }
};

// ─── Central Express Routing Subsystem ──────────────────────────────────────

const app = express();
app.use(cors({ origin: true }));

// Stripe webhook requires the raw request body to verify the signature integrity.
// Place it before express.json() parser so the buffer remains untouched.
app.post("/stripe-webhook", express.raw({ type: "application/json" }), stripeWebhookHandler);

app.use(express.json());

const registeredRoutes = [
  "/webhook/cloudflare-inbound",
  "/improveEmailDraft",
  "/sendManualEmail",
  "/archiveTask",
  "/restoreTask",
  "/handleFeedbackSubmit",
  "/sendAiReply",
  "/processEmailWithAi",
  "/verifySubscription"
];

app.use((req, res, next) => {
  if (registeredRoutes.includes(req.path)) {
    if (req.method !== "POST" && req.method !== "OPTIONS") {
      res.status(405).json({ error: "Method Not Allowed" });
      return;
    }
  }
  next();
});

// Registering POST routes with application-layer rate limiter on critical ingress paths
app.post("/webhook/cloudflare-inbound", limiter, cloudflareInboundWebhookLogic);
app.post("/improveEmailDraft", limiter, improveEmailDraftLogic);
app.post("/sendManualEmail", sendManualEmailLogic);
app.post("/archiveTask", archiveTaskLogic);
app.post("/restoreTask", restoreTaskLogic);
app.post("/handleFeedbackSubmit", handleFeedbackSubmitLogic);
app.post("/sendAiReply", sendAiReplyLogic);
app.post("/processEmailWithAi", processEmailWithAiLogic);
app.post("/verifySubscription", limiter, verifySubscriptionLogic);
app.delete("/emails/:emailId", deleteEmailLogic);

export const api = onRequest({
  cors: true,
  secrets: ["OPENAI_API_KEY", "SERVER_WEBHOOK_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "CLOUDFLARE_WORKER_SECRET", "ENCRYPTION_KEY"],
  maxInstances: 10,
  invoker: "public",
}, app);
