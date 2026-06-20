import { setGlobalOptions } from "firebase-functions/v2";
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import { OpenAI } from "openai";
import { ImapFlow } from "imapflow";
import * as nodemailer from "nodemailer";
import { simpleParser } from "mailparser";
import express from "express";
import cors from "cors";

// Set global options for the functions (max instances for budget/cost control)
setGlobalOptions({ maxInstances: 10 });

// Initialize Firebase Admin
admin.initializeApp();
const db = getFirestore();

// ─── Interfaces ──────────────────────────────────────────────────────────────

interface IncomingEmailRequest {
  sender: string;
  subject?: string;
  textContent: string;
  userEmail?: string;
  userId?: string;
  to?: string;
}

interface FeedbackSubmitRequest {
  title: string;
  category: string;
  description?: string;
  user_email: string;
}

interface EmailConfig {
  provider: "google" | "gmail" | "outlook" | "custom";
  connection_type?: "direct" | "forwarder";
  email: string;
  password?: string;
  imapHost?: string;
  imapPort?: number | string;
  smtpHost?: string;
  smtpPort?: number | string;
  connected_at: string;
}

interface SendAiReplyRequest {
  taskId: string;
  replyBody: string;
  recipientEmail: string;
}

// ─── Shared Helpers ──────────────────────────────────────────────────────────

/** Extract clean email from "Name <email@domain.com>" or "email@domain.com" */
function extractEmail(sender: string): string {
  const match = sender.match(/<([^>]+)>/);
  return match ? match[1].trim().toLowerCase() : sender.trim().toLowerCase();
}

/** Extract and verify JWT from Authorization header */
async function verifyAuthToken(req: any): Promise<{ email: string } | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const idToken = authHeader.split("Bearer ")[1];
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    return decoded.email ? { email: decoded.email } : null;
  } catch {
    return null;
  }
}

/** Check if a user has an active subscription */
async function checkSubscription(userEmail: string): Promise<boolean> {
  const userDoc = await db.collection("users").doc(userEmail).get();
  return userDoc.exists && userDoc.data()?.subscriptionStatus === "active";
}

/** Spam filter: returns true if the sender should be blocked */
function isSpamSender(sender: string): boolean {
  const senderLower = sender.toLowerCase();
  const parts = senderLower.split("@");
  const localPart = parts[0] || "";
  return localPart === "noreply" || localPart === "newsletter" || senderLower.includes("spam");
}

/** Resolve IMAP/SMTP config for a provider type */
function resolveEmailServers(config: EmailConfig): { imapHost: string; imapPort: number; smtpHost: string; smtpPort: number } {
  const imapPortNum = typeof config.imapPort === "string" ? parseInt(config.imapPort) : config.imapPort;
  const smtpPortNum = typeof config.smtpPort === "string" ? parseInt(config.smtpPort) : config.smtpPort;

  if (config.provider === "outlook") {
    return {
      imapHost: config.imapHost || "outlook.office365.com",
      imapPort: imapPortNum || 993,
      smtpHost: config.smtpHost || "smtp.office365.com",
      smtpPort: smtpPortNum || 587,
    };
  }
  if (config.provider === "gmail" || config.provider === "google") {
    return {
      imapHost: config.imapHost || "imap.gmail.com",
      imapPort: imapPortNum || 993,
      smtpHost: config.smtpHost || "smtp.gmail.com",
      smtpPort: smtpPortNum || 465,
    };
  }
  return {
    imapHost: config.imapHost || "localhost",
    imapPort: imapPortNum || 993,
    smtpHost: config.smtpHost || "localhost",
    smtpPort: smtpPortNum || 587,
  };
}

async function resolveSmtpConfig(userEmail: string, preferredEmail?: string): Promise<EmailConfig | null> {
  if (preferredEmail) {
    const connSnap = await db.collection("users").doc(userEmail).collection("email_connections")
      .where("email", "==", preferredEmail)
      .limit(1)
      .get();
    if (!connSnap.empty) {
      return connSnap.docs[0].data() as EmailConfig;
    }
  }

  const connsSnap = await db.collection("users").doc(userEmail).collection("email_connections").limit(1).get();
  if (!connsSnap.empty) {
    return connsSnap.docs[0].data() as EmailConfig;
  }

  const legacyDoc = await db.doc(`users/${userEmail}/tokens/email_config`).get();
  if (legacyDoc.exists) {
    return legacyDoc.data() as EmailConfig;
  }

  return null;
}

/**
 * SUBSYSTEM 1: handleIncomingEmail
 * Replaces Make.com e-mail to task pipeline.
 * Input: POST JSON payload: { sender, subject, textContent, userEmail, userId }
 */
const handleIncomingEmailLogic: express.RequestHandler = async (req, res) => {
  try {
    // Strict HTTP Method Guard
    if (req.method !== "POST") {
      logger.warn(`Method Not Allowed: ${req.method}`);
      res.status(405).json({ error: "Method Not Allowed" });
      return;
    }

    // Server Key Protection
    const serverKey = req.headers["x-normaflow-server-key"];
    if (!serverKey || serverKey !== process.env.SERVER_WEBHOOK_KEY) {
      logger.warn("Unauthorized request to handleIncomingEmail: missing or invalid server key");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { sender, subject, textContent, userEmail, userId, to } = req.body as Partial<IncomingEmailRequest>;
    let targetEmail = userEmail || userId;

    if (!targetEmail && to) {
      const cleanTo = to.trim().toLowerCase();
      if (cleanTo.endsWith("@task.normaflow.hu")) {
        const prefix = cleanTo.split("@")[0]; // e.g., "szabi-gmail.com-inbound"
        if (prefix && prefix.endsWith("-inbound")) {
          const emailPart = prefix.replace("-inbound", ""); // "szabi-gmail.com"
          const lastDash = emailPart.lastIndexOf("-");
          if (lastDash !== -1) {
            // Dynamically reconstruct the original target accountant email: "szabi@gmail.com"
            targetEmail = emailPart.substring(0, lastDash) + "@" + emailPart.substring(lastDash + 1);
          }
        }
      }
    }

    // Step A: Validation & Strict Spam Filter
    if (!sender || !textContent || !targetEmail) {
      logger.warn("Validation failed: missing sender, textContent, or targetEmail");
      res.status(400).json({ error: "Bad Request" });
      return;
    }

    let sourceMailbox = to ? extractEmail(to) : "";
    if (!sourceMailbox && textContent) {
      const toMatch = textContent.match(/To:\s*([^\r\n]+)/i);
      if (toMatch && toMatch[1]) {
        sourceMailbox = extractEmail(toMatch[1]);
      }
    }
    if (!sourceMailbox && targetEmail) {
      sourceMailbox = extractEmail(targetEmail);
    }

    const senderLower = sender.toLowerCase();
    const parts = senderLower.split("@");
    const localPart = parts[0] || "";
    const isSpamSender = localPart === "noreply" || localPart === "newsletter" || senderLower.includes("spam");
    const isTooShort = textContent.length < 20;

    if (isSpamSender || isTooShort) {
      logger.info(
        `Email filtered. Reason - Spam sender check: ${isSpamSender}, Text too short check: ${isTooShort}. Sender: ${sender}.`
      );
      res.status(200).json({ status: "filtered", message: "Email filtered as spam or system message." });
      return;
    }

    // Subscription check: verify user has an active subscription
    const userDoc = await db.collection("users").doc(targetEmail).get();
    const userData = userDoc.exists ? userDoc.data() : null;
    if (!userData || userData.subscriptionStatus !== "active" || userData.tier === "none") {
      logger.warn(`Forbidden request to handleIncomingEmail: user ${targetEmail} does not have an active subscription or has tier "none"`);
      res.status(403).json({
        error: "Forbidden: Account requires an active subscription to process background email automation."
      });
      return;
    }

    // Quota evaluation
    const processedEmailsThisMonth = userData.processedEmailsThisMonth || 0;
    const tier = userData.tier || "none";
    const tierLimits: Record<string, number> = {
      none: 0,
      basic: 500,
      pro: 1500,
      ultra: 5000,
    };
    const limit = tierLimits[tier] || 0;
    if (processedEmailsThisMonth >= limit) {
      logger.warn(`Quota exceeded for user ${targetEmail}: ${processedEmailsThisMonth} >= ${limit}`);
      res.status(403).json({
        error: "Forbidden: Monthly email processing limit reached for current subscription tier."
      });
      return;
    }

    // Step B: Fetch Accountant's Custom Rules / settings
    logger.info(`Fetching auto-responder settings for userEmail: ${targetEmail}`);
    const autoResponderRef = db.doc(`users/${targetEmail}/settings/auto_responder`);
    const rulesDoc = await autoResponderRef.get();

    let automationEnabled = false;
    let promptRules = "";
    let enforceWhitelist = true; // default to true if not set

    if (rulesDoc.exists) {
      const data = rulesDoc.data();
      automationEnabled = !!data?.automationEnabled;
      promptRules = data?.promptRules || "";
      if (data?.enforceWhitelist === false) {
        enforceWhitelist = false;
      }
    }

    // Whitelist Enforcement
    if (enforceWhitelist) {
      const senderEmail = extractEmail(sender);
      const clientsSnap = await db.collection("users")
        .doc(targetEmail)
        .collection("clients")
        .where("email", "==", senderEmail)
        .get();

      if (clientsSnap.empty) {
        logger.info(`Whitelisting: Sender ${senderEmail} is not a registered client of ${targetEmail}. Skipping processing.`);
        res.status(200).json({ status: "skipped", message: "Sender is not whitelisted in accountant's clients." });
        return;
      }
    } else {
      logger.info(`Whitelisting bypass: enforceWhitelist is false. Processing email from ${sender}.`);
    }

    let aiReply: string | null = null;
    let aiSummary = "Nem sikerült összefoglalót készíteni.";

    // Step C: Cost-Optimized AI Engine
    if (process.env.OPENAI_API_KEY) {
      logger.info(`Triggering OpenAI gpt-4o-mini for userEmail: ${targetEmail}`);
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      
      const systemPrompt = `Te a NormaFlow AI asszisztense vagy egy könyvelőirodában. A feladatod, hogy elemezd a beérkező e-mailt.
Készíts egy rövid, 1-2 mondatos magyar nyelvű összefoglalót és szükség esetén teendőket (actionable bullet points) a könyvelő számára.

${automationEnabled && promptRules.trim() ? `Ezen kívül a könyvelő által meghatározott egyedi szabályok alapján készíts egy hivatalos, udvarias választervezet-javaslatot is.
Könyvelő egyedi szabályai:
${promptRules}` : ''}

A választ szigorúan JSON formátumban add vissza, az alábbi kulcsokkal:
- "summary": A beérkező e-mail 1-2 mondatos magyar nyelvű összefoglalója, alatta új sorban a teendők listájával (pl. "Összegzés: ... \\nTeendők:\\n- ...").
- "reply": A szabályok alapján generált választervezet szövege, vagy null, ha az automatikus választervezés nincs engedélyezve/nem alkalmazható.`;

      const userPrompt = `Feladó: ${sender}\nTárgy: ${subject || "Nincs tárgy megadva"}\nÜzenet:\n${textContent}`;

      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        response_format: { type: "json_object" },
        max_tokens: 600,
      });

      try {
        const result = JSON.parse(response.choices[0]?.message?.content || "{}");
        aiSummary = result.summary || "Nem sikerült összefoglalót készíteni.";
        aiReply = result.reply || null;
      } catch (parseErr) {
        logger.error("Error parsing JSON response from OpenAI:", parseErr);
      }
    } else {
      logger.warn("OpenAI API key missing in handleIncomingEmail");
    }

    // Step D: Structured Firestore Ingestion
    const aiStatus = "pending_review";
    const nextStep = aiReply ? "AI választervezet felülvizsgálata" : "Manuális válasz írása szükséges";

    const taskPayload = {
      category: "E-mail",
      summary: subject || "Nincs tárgy megadva",
      next_step: nextStep,
      priority: 3,
      received_at: new Date().toISOString(),
      sender,
      subject: subject || "",
      user_email: targetEmail, // map to targetEmail
      status: "active",
      archivedAt: null,
      ai_status: aiStatus,
      ai_reply: aiReply,
      ai_summary: aiSummary,
      textContent: textContent,
      received_via: "forwarder",
      source_mailbox: sourceMailbox,
    };

    logger.info("Saving new task to Firestore...");
    const taskDocRef = await db.collection("tasks").add(taskPayload);
    logger.info(`Successfully created task with ID: ${taskDocRef.id}`);

    // Increment processed email count
    await db.collection("users").doc(targetEmail).update({
      processedEmailsThisMonth: admin.firestore.FieldValue.increment(1)
    });

    res.status(200).json({
      status: "success",
      taskId: taskDocRef.id,
      ai_status: aiStatus,
      next_step: nextStep,
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Error in handleIncomingEmail:", errorMessage);
    res.status(500).json({
      error: "Internal Server Error",
      message: errorMessage,
    });
  }
};

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

// ─── SUBSYSTEM 3: syncEmails (Scheduled IMAP Sync) ───────────────────────────

/**
 * Runs every 5 minutes. For each active subscriber with an Outlook or Custom
 * email_config, connects via IMAP, fetches unread messages, runs the AI engine,
 * and pushes tasks to Firestore. Google users are skipped (handled by webhook).
 */
async function performEmailSync(targetEmail: string): Promise<number> {
  let synced = 0;

  // Load user details
  const userDoc = await db.collection("users").doc(targetEmail).get();
  const userData = userDoc.exists ? userDoc.data() : null;
  if (!userData || userData.subscriptionStatus !== "active" || userData.tier === "none") {
    logger.warn(`performEmailSync: User ${targetEmail} does not have an active subscription or has tier "none".`);
    return 0;
  }

  let processedEmailsThisMonth = userData.processedEmailsThisMonth || 0;
  const tier = userData.tier || "none";
  const tierLimits: Record<string, number> = {
    none: 0,
    basic: 500,
    pro: 1500,
    ultra: 5000,
  };
  const limit = tierLimits[tier] || 0;

  if (processedEmailsThisMonth >= limit) {
    logger.warn(`performEmailSync: User ${targetEmail} already reached their monthly limit.`);
    return 0;
  }

  // Load whitelist rules
  const rulesDoc = await db.doc(`users/${targetEmail}/settings/auto_responder`).get();
  let enforceWhitelist = true;
  if (rulesDoc.exists) {
    const data = rulesDoc.data();
    if (data?.enforceWhitelist === false) {
      enforceWhitelist = false;
    }
  }

  // Fetch all documents inside users/{targetEmail}/email_connections
  const connectionsSnap = await db.collection("users").doc(targetEmail).collection("email_connections").get();
  if (connectionsSnap.empty) {
    logger.info(`performEmailSync: No email connections found for ${targetEmail}`);
    return 0;
  }

  for (const connDoc of connectionsSnap.docs) {
    const config = connDoc.data() as EmailConfig;

    // Strictly execute sync only on connection documents where connection_type === "direct"
    if (config.connection_type !== "direct" || !config.password || !config.email) {
      continue;
    }

    if (processedEmailsThisMonth >= limit) {
      logger.warn(`performEmailSync: User ${targetEmail} reached limit of ${limit}. Skipping remaining connections.`);
      break;
    }

    const servers = resolveEmailServers(config);

    // Connect to IMAP
    const client = new ImapFlow({
      host: servers.imapHost,
      port: servers.imapPort,
      secure: true,
      auth: {
        user: config.email,
        pass: config.password,
      },
      logger: false,
    });

    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");

      try {
        // Fetch unseen messages
        const messages = client.fetch({ seen: false }, { source: true, envelope: true });

        for await (const msg of messages) {
          const envelope = msg.envelope;
          if (!envelope) continue;
          const sender = envelope.from?.[0]?.address || "";
          const subject = envelope.subject || "";
          const rawSource = msg.source?.toString("utf-8") || "";

          // Self-email detection: bypass quota/whitelist/spam for self-sent test emails
          const isSelfEmail = extractEmail(sender) === config.email.toLowerCase() || extractEmail(sender) === targetEmail.toLowerCase();

          // Quota check inside loop (bypassed for self-emails)
          if (!isSelfEmail && processedEmailsThisMonth >= limit) {
            logger.warn(`performEmailSync: User ${targetEmail} reached limit of ${limit}. Aborting sync for this connection.`);
            break;
          }

          // Whitelist check (bypassed for self-emails)
          let isWhitelisted = true;
          if (enforceWhitelist && !isSelfEmail) {
            const senderEmail = extractEmail(sender);
            const clientsSnap = await db.collection("users")
              .doc(targetEmail)
              .collection("clients")
              .where("email", "==", senderEmail)
              .get();

            if (clientsSnap.empty) {
              isWhitelisted = false;
            }
          }

          if (!isWhitelisted) {
            const senderEmail = extractEmail(sender);
            logger.info(`performEmailSync: Whitelist check failed for sender ${senderEmail}. Skipping.`);
            if (msg.uid) {
              await client.messageFlagsAdd({ uid: msg.uid }, ["\\Seen"], { uid: true });
            }
            continue;
          }

          // Extract plain text body using mailparser (handles Base64, Quoted-Printable, multipart)
          let textContent = "";
          try {
            const parsed = await simpleParser(rawSource);
            textContent = (parsed.text || "").trim();
          } catch (parseErr) {
            logger.error(`syncEmails: MIME parse error for message "${subject}" from ${sender}:`, parseErr);
            continue;
          }

          // Spam filter (bypassed for self-emails)
          if (!sender || (!isSelfEmail && (isSpamSender(sender) || textContent.length < 20))) {
            logger.info(`syncEmails: Filtered e-mail from ${sender} for user ${targetEmail}`);
            continue;
          }

          try {
            // Store raw email into `emails` collection for later AI processing
            await db.collection("emails").add({
              user_email: targetEmail.toLowerCase().trim(),
              sender: sender,
              subject: subject || "Nincs tárgy",
              textContent: textContent,
              received_at: new Date().toISOString(),
              status: "unread",
              source_mailbox: config.email,
              received_via: "imap",
              messageId: envelope.messageId || null,
            });

            // Increment processed email count
            await db.collection("users").doc(targetEmail).update({
              processedEmailsThisMonth: admin.firestore.FieldValue.increment(1)
            });
            processedEmailsThisMonth++;
            synced++;
          } catch (err) {
            logger.error("IMAP Ingestion Failed for Msg:", subject, err);
          }

          // Mark as seen
          if (msg.uid) {
            await client.messageFlagsAdd({ uid: msg.uid }, ["\\Seen"], { uid: true });
          }
        }
      } finally {
        lock.release();
      }
      await client.logout();
    } catch (err) {
      logger.error(`syncEmails: IMAP error for connection ${config.email} of user ${targetEmail}:`, err);
      try { await client.logout(); } catch { /* ignore */ }
    }
  }

  return synced;
}

export const syncEmails = onSchedule({
  schedule: "every 5 minutes",
  secrets: ["OPENAI_API_KEY"],
  timeoutSeconds: 300,
}, async () => {
  logger.info("syncEmails: Starting scheduled email sync...");

  // Find all active subscribers
  const usersSnap = await db.collection("users")
    .where("subscriptionStatus", "==", "active")
    .get();

  let totalSynced = 0;
  for (const userDoc of usersSnap.docs) {
    const userEmail = userDoc.id;
    try {
      const count = await performEmailSync(userEmail);
      if (count > 0) {
        logger.info(`syncEmails: Synced ${count} emails for ${userEmail}`);
        totalSynced += count;
      }
    } catch (err) {
      logger.error(`syncEmails: Failed for ${userEmail}:`, err);
    }
  }

  logger.info(`syncEmails: Completed. Total synced: ${totalSynced}`);
});

// ─── SUBSYSTEM 4: syncEmailsNow (Manual Trigger) ────────────────────────────

/**
 * HTTPS endpoint for on-demand email sync.
 * Called by the frontend "Levelek szinkronizálása" button.
 * JWT-authenticated + subscription-gated.
 */
const syncEmailsNowLogic: express.RequestHandler = async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Access-Control-Allow-Methods", "POST");
      res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.status(204).send("");
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method Not Allowed" });
      return;
    }

    // Auth
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

    // Subscription check
    if (!(await checkSubscription(authResult.email))) {
      res.status(403).json({ error: "Forbidden: Active subscription required" });
      return;
    }

    logger.info(`syncEmailsNow: Manual sync triggered by ${authResult.email}`);
    const count = await performEmailSync(authResult.email);

    res.status(200).json({
      status: "success",
      synced: count,
      message: count > 0 ? `${count} új e-mail szinkronizálva.` : "Nincs új e-mail.",
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("syncEmailsNow error:", errorMessage);
    res.status(500).json({ error: "Internal Server Error", message: errorMessage });
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
    if (!config) {
      res.status(400).json({ error: "No email configuration found. Please connect your email first." });
      return;
    }

    if (config.provider === "google") {
      res.status(400).json({ error: "Google email replies are handled via the Gmail API. Use the Gmail interface." });
      return;
    }

    if (!config.password) {
      res.status(400).json({ error: "Missing email credentials. Please reconfigure your email connection." });
      return;
    }

    const servers = resolveEmailServers(config);

    // Create nodemailer transport
    const transporter = nodemailer.createTransport({
      host: servers.smtpHost,
      port: servers.smtpPort,
      secure: servers.smtpPort === 465,
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

    // Query email_connections subcollection specifically matching this email address
    let config: EmailConfig | null = null;
    const connSnap = await db.collection("users")
      .doc(userEmail)
      .collection("email_connections")
      .where("email", "==", sourceMailbox)
      .limit(1)
      .get();
    if (!connSnap.empty) {
      config = connSnap.docs[0].data() as EmailConfig;
    }

    const servers = config ? resolveEmailServers(config) : null;

    if (!config || !config.password || !servers || !servers.smtpHost || !servers.smtpPort) {
      res.status(400).json({
        error: "SMTP_NOT_CONFIGURED",
        message: `Nincs beállítva kimenő SMTP fiók ehhez a címhez: ${sourceMailbox}`
      });
      return;
    }

    // Setup nodemailer
    const transporter = nodemailer.createTransport({
      host: servers.smtpHost,
      port: servers.smtpPort,
      secure: servers.smtpPort === 465,
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
  } catch (err: any) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error("Error in improveEmailDraft:", errMsg);
    res.status(500).json({ error: "Internal Server Error", message: errMsg });
  }
};

/**
 * Automated Daily Task Cleanup Cron Job
 * Runs daily at midnight.
 * Deletes tasks in status "archived" where archivedAt is older than 30 days.
 */
export const cleanupExpiredTasks = onSchedule({ schedule: "0 0 * * *" }, async (event) => {
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

  // Load auto-responder rules for the user
  const rulesDoc = await db.doc(`users/${userEmail}/settings/auto_responder`).get();
  let promptRules = "";
  let exclusionRules = "";
  if (rulesDoc.exists) {
    const rulesData = rulesDoc.data();
    promptRules = rulesData?.promptRules || "";
    exclusionRules = rulesData?.exclusionRules || "";
  }

  const sender = emailData.sender || "";
  const subject = emailData.subject || "Nincs tárgy";
  const textContent = emailData.textContent || "";

  if (!process.env.OPENAI_API_KEY) {
    logger.warn("processEmailInternally: OPENAI_API_KEY not set, skipping AI processing.");
    return { status: "no_api_key" };
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
      const filterResult = JSON.parse(filterResponse.choices[0]?.message?.content || "{}");

      if (filterResult.relevant === false) {
        await emailRef.update({ status: "filtered" });
        logger.info(`processEmailInternally: Email ${emailId} filtered out. Reason: ${filterResult.reason}`);
        return { status: "filtered", reason: filterResult.reason || "AI szűrő kiszűrte" };
      }
    } catch (filterErr) {
      logger.error(`processEmailInternally: AI pre-filter error for ${userEmail}:`, filterErr);
      // On filter error, proceed to task generation anyway
    }
  }

  // ── PHASE 2: Task Generation ────────────────────────────────────────────
  let aiReply: string | null = null;
  let aiSummary = "Nem sikerült összefoglalót készíteni.";
  try {
    const systemPrompt = `Te a NormaFlow AI asszisztense vagy egy könyvelőirodában. A feladatod, hogy elemezd a beérkező e-mailt.
Készíts egy rövid, 1-2 mondatos magyar nyelvű összefoglalót és szükség esetén teendőket (actionable bullet points) a könyvelő számára.

${promptRules.trim() ? `Ezen kívül a könyvelő által meghatározott egyedi szabályok alapján készíts egy hivatalos, udvarias választervezet-javaslatot is.
Könyvelő egyedi szabályai:
${promptRules}` : ''}

A választ szigorúan JSON formátumban add vissza, az alábbi kulcsokkal:
- "summary": A beérkező e-mail 1-2 mondatos magyar nyelvű összefoglalója, alatta új sorban a teendők listájával (pl. "Összegzés: ... \\nTeendők:\\n- ...").
- "reply": A szabályok alapján generált választervezet szövege, vagy null, ha az automatikus választervezés nincs engedélyezve/nem alkalmazható.`;

    const userPrompt = `Feladó: ${sender}\nTárgy: ${subject || "Nincs tárgy megadva"}\nÜzenet:\n${textContent.substring(0, 2000)}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      max_tokens: 600,
    });
    const result = JSON.parse(response.choices[0]?.message?.content || "{}");
    aiSummary = result.summary || "Nem sikerült összefoglalót készíteni.";
    aiReply = result.reply || null;
  } catch (aiErr) {
    logger.error(`processEmailInternally: AI task generation error for ${userEmail}:`, aiErr);
  }

  // Create task in the tasks collection
  const nextStep = aiReply ? "AI választervezet felülvizsgálata" : "Manuális válasz írása szükséges";
  const taskRef = await db.collection("tasks").add({
    category: "E-mail",
    summary: subject,
    next_step: nextStep,
    priority: 3,
    received_at: emailData.received_at || new Date().toISOString(),
    sender,
    subject,
    user_email: userEmail,
    status: "active",
    archivedAt: null,
    ai_status: "pending_review",
    ai_reply: aiReply,
    ai_summary: aiSummary,
    textContent,
    source_mailbox: emailData.source_mailbox || "",
    received_via: emailData.received_via || "imap",
    sourceEmailId: emailId,
  });

  // Mark the email as processed
  await emailRef.update({ status: "processed" });

  return { status: "success", taskId: taskRef.id };
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
    if (emailDoc.data()?.user_email !== authResult.email) {
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

// ─── Central Express Routing Subsystem ──────────────────────────────────────

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

const registeredRoutes = [
  "/handleIncomingEmail",
  "/improveEmailDraft",
  "/sendManualEmail",
  "/syncEmailsNow",
  "/archiveTask",
  "/restoreTask",
  "/handleFeedbackSubmit",
  "/sendAiReply",
  "/processEmailWithAi"
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

app.post("/handleIncomingEmail", handleIncomingEmailLogic);
app.post("/improveEmailDraft", improveEmailDraftLogic);
app.post("/sendManualEmail", sendManualEmailLogic);
app.post("/syncEmailsNow", syncEmailsNowLogic);
app.post("/archiveTask", archiveTaskLogic);
app.post("/restoreTask", restoreTaskLogic);
app.post("/handleFeedbackSubmit", handleFeedbackSubmitLogic);
app.post("/sendAiReply", sendAiReplyLogic);
app.post("/processEmailWithAi", processEmailWithAiLogic);

export const api = onRequest({
  cors: true,
  secrets: ["OPENAI_API_KEY", "SERVER_WEBHOOK_KEY"],
  maxInstances: 10,
  invoker: "public",
}, app);
