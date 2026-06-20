import { setGlobalOptions } from "firebase-functions/v2";
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import { OpenAI } from "openai";
import { ImapFlow } from "imapflow";
import * as nodemailer from "nodemailer";

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
}

interface FeedbackSubmitRequest {
  title: string;
  category: string;
  description?: string;
  user_email: string;
}

interface EmailConfig {
  provider: "google" | "outlook" | "custom";
  email: string;
  password?: string;
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
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
  if (config.provider === "outlook") {
    return {
      imapHost: config.imapHost || "imap-mail.outlook.com",
      imapPort: config.imapPort || 993,
      smtpHost: config.smtpHost || "smtp-mail.outlook.com",
      smtpPort: config.smtpPort || 587,
    };
  }
  return {
    imapHost: config.imapHost || "localhost",
    imapPort: config.imapPort || 993,
    smtpHost: config.smtpHost || "localhost",
    smtpPort: config.smtpPort || 587,
  };
}

/**
 * SUBSYSTEM 1: handleIncomingEmail
 * Replaces Make.com e-mail to task pipeline.
 * Input: POST JSON payload: { sender, subject, textContent, userEmail, userId }
 */
export const handleIncomingEmail = onRequest({
  cors: true,
  secrets: ["OPENAI_API_KEY", "SERVER_WEBHOOK_KEY"],
  maxInstances: 10,
  invoker: "public",
}, async (req, res) => {
  try {
    // Validate custom server-to-server webhook key
    const serverKey = req.headers["x-normaflow-server-key"];
    if (!serverKey || serverKey !== process.env.SERVER_WEBHOOK_KEY) {
      logger.warn("Unauthorized request to handleIncomingEmail: invalid server key");
      res.status(401).send("Unauthorized: Invalid server webhook key");
      return;
    }

    // Validate Method
    if (req.method !== "POST") {
      logger.warn(`Method Not Allowed: ${req.method}`);
      res.status(405).json({ error: "Method Not Allowed. Must be POST." });
      return;
    }

    const { sender, subject, textContent, userEmail, userId } = req.body as Partial<IncomingEmailRequest>;
    const targetEmail = userEmail || userId;

    // Step A: Validation & Strict Spam Filter
    if (!sender || !textContent || !targetEmail) {
      logger.warn("Validation failed: missing sender, textContent, or targetEmail");
      res.status(400).json({ error: "Missing required fields: sender, textContent, and userEmail/userId are required." });
      return;
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
    if (!userData || userData.subscriptionStatus !== "active") {
      logger.warn(`Forbidden request to handleIncomingEmail: user ${targetEmail} does not have an active subscription`);
      res.status(403).json({
        error: "Forbidden: Account requires an active subscription to process background email automation."
      });
      return;
    }

    // Quota evaluation
    const processedEmailsThisMonth = userData.processedEmailsThisMonth || 0;
    const tier = userData.tier || "basic";
    const tierLimits: Record<string, number> = {
      basic: 500,
      pro: 1500,
      ultra: 5000,
    };
    const limit = tierLimits[tier] || 500;
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
});

/**
 * SUBSYSTEM 2: handleFeedbackSubmit
 * Replaces Make.com webhook for the client-side Feedback Box.
 * Input: POST JSON payload: { title, category, description }
 * Authentication: Enforced ID Token validation via Authorization header
 */
export const handleFeedbackSubmit = onRequest({
  cors: true,
  maxInstances: 10,
  invoker: "public",
}, async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'GET, POST');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.status(204).send('');
      return;
    }

    // Verify JWT ID Token from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      logger.warn("Unauthorized request to handleFeedbackSubmit: missing or invalid authorization header");
      res.status(401).send("Unauthorized: Missing or invalid Authorization header");
      return;
    }

    const idToken = authHeader.split("Bearer ")[1];
    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(idToken);
    } catch (err: any) {
      logger.error("Token verification failed:", err);
      res.status(401).send("Unauthorized: Invalid token");
      return;
    }

    const verifiedUserEmail = decodedToken.email;
    if (!verifiedUserEmail) {
      logger.warn("Unauthorized request to handleFeedbackSubmit: token contains no email");
      res.status(401).send("Unauthorized: Token contains no email");
      return;
    }

    // Subscription check: verify user has an active subscription
    const userDoc = await admin.firestore().collection('users').doc(verifiedUserEmail).get();
    if (!userDoc.exists || userDoc.data()?.subscriptionStatus !== 'active') {
      logger.warn(`Forbidden request to handleFeedbackSubmit: user ${verifiedUserEmail} does not have an active subscription`);
      res.status(403).send("Forbidden: Active subscription required to submit feedback");
      return;
    }

    // Validate Method
    if (req.method !== "POST") {
      logger.warn(`Method Not Allowed: ${req.method}`);
      res.status(405).json({ error: "Method Not Allowed. Must be POST." });
      return;
    }

    const { title, category, description } = req.body as Partial<FeedbackSubmitRequest>;

    // Step A: Validation
    if (!title || !category) {
      logger.warn("Validation failed: missing title or category");
      res.status(400).json({
        error: "Bad Request",
        message: "Missing required fields. 'title' and 'category' are required.",
      });
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
});

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
  if (!userData || userData.subscriptionStatus !== "active") {
    logger.warn(`performEmailSync: User ${targetEmail} does not have an active subscription.`);
    return 0;
  }

  let processedEmailsThisMonth = userData.processedEmailsThisMonth || 0;
  const tier = userData.tier || "basic";
  const tierLimits: Record<string, number> = {
    basic: 500,
    pro: 1500,
    ultra: 5000,
  };
  const limit = tierLimits[tier] || 500;

  if (processedEmailsThisMonth >= limit) {
    logger.warn(`performEmailSync: User ${targetEmail} already reached their monthly limit.`);
    return 0;
  }

  // Load email config
  const configDoc = await db.doc(`users/${targetEmail}/tokens/email_config`).get();
  if (!configDoc.exists) return 0;
  const config = configDoc.data() as EmailConfig;

  // Google users rely on the webhook pipeline, skip IMAP sync
  if (config.provider === "google" || !config.password) return 0;

  const servers = resolveEmailServers(config);

  // Load auto-responder rules
  const rulesDoc = await db.doc(`users/${targetEmail}/settings/auto_responder`).get();
  let automationEnabled = false;
  let promptRules = "";
  let enforceWhitelist = true;
  if (rulesDoc.exists) {
    const data = rulesDoc.data();
    automationEnabled = !!data?.automationEnabled;
    promptRules = data?.promptRules || "";
    if (data?.enforceWhitelist === false) {
      enforceWhitelist = false;
    }
  }


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

        // Quota check inside loop
        if (processedEmailsThisMonth >= limit) {
          logger.warn(`performEmailSync: User ${targetEmail} reached limit of ${limit}. Aborting sync loop.`);
          break;
        }

        // Whitelist check
        let isWhitelisted = true;
        if (enforceWhitelist) {
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

        // Extract plain text body (simple extraction from raw source)
        let textContent = "";
        const boundaryMatch = rawSource.match(/boundary="?([^"\r\n]+)"?/);
        if (boundaryMatch) {
          // Multipart: find text/plain part
          const parts = rawSource.split(boundaryMatch[1]);
          for (const part of parts) {
            if (part.includes("text/plain")) {
              const bodyStart = part.indexOf("\r\n\r\n");
              if (bodyStart !== -1) {
                textContent = part.substring(bodyStart + 4).trim();
                break;
              }
            }
          }
        } else {
          // Simple message: body after double newline
          const bodyStart = rawSource.indexOf("\r\n\r\n");
          textContent = bodyStart !== -1 ? rawSource.substring(bodyStart + 4).trim() : rawSource;
        }

        // Spam filter
        if (!sender || isSpamSender(sender) || textContent.length < 20) {
          logger.info(`syncEmails: Filtered email from ${sender} for user ${targetEmail}`);
          continue;
        }

        // AI Engine
        let aiReply: string | null = null;
        let aiSummary = "Nem sikerült összefoglalót készíteni.";
        if (process.env.OPENAI_API_KEY) {
          try {
            const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
            const systemPrompt = `Te a NormaFlow AI asszisztense vagy egy könyvelőirodában. A feladatod, hogy elemezd a beérkező e-mailt.
Készíts egy rövid, 1-2 mondatos magyar nyelvű összefoglalót és szükség esetén teendőket (actionable bullet points) a könyvelő számára.

${automationEnabled && promptRules.trim() ? `Ezen kívül a könyvelő által meghatározott egyedi szabályok alapján készíts egy hivatalos, udvarias választervezet-javaslatot is.
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
            logger.error(`syncEmails: AI error for ${targetEmail}:`, aiErr);
          }
        }

        // Push task to Firestore
        const aiStatus = "pending_review";
        const nextStep = aiReply ? "AI választervezet felülvizsgálata" : "Manuális válasz írása szükséges";

        await db.collection("tasks").add({
          category: "E-mail",
          summary: subject || "Nincs tárgy megadva",
          next_step: nextStep,
          priority: 3,
          received_at: new Date().toISOString(),
          sender,
          subject: subject || "",
          user_email: targetEmail,
          status: "active",
          archivedAt: null,
          ai_status: aiStatus,
          ai_reply: aiReply,
          ai_summary: aiSummary,
          textContent: textContent,
          source_provider: config.provider,
        });

        // Increment processed email count
        await db.collection("users").doc(targetEmail).update({
          processedEmailsThisMonth: admin.firestore.FieldValue.increment(1)
        });
        processedEmailsThisMonth++;

        // Mark as seen
        if (msg.uid) {
          await client.messageFlagsAdd({ uid: msg.uid }, ["\\Seen"], { uid: true });
        }

        synced++;
      }
    } finally {
      lock.release();
    }

    await client.logout();
  } catch (err) {
    logger.error(`syncEmails: IMAP error for ${targetEmail}:`, err);
    try { await client.logout(); } catch { /* ignore */ }
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
export const syncEmailsNow = onRequest({
  cors: true,
  secrets: ["OPENAI_API_KEY"],
  maxInstances: 5,
  invoker: "public",
}, async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Access-Control-Allow-Methods", "POST");
      res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.status(204).send("");
      return;
    }

    // Auth
    const authResult = await verifyAuthToken(req);
    if (!authResult) {
      res.status(401).send("Unauthorized");
      return;
    }

    // Subscription check
    if (!(await checkSubscription(authResult.email))) {
      res.status(403).send("Forbidden: Active subscription required");
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method Not Allowed. Must be POST." });
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
});

// ─── SUBSYSTEM 5: sendAiReply (SMTP Email Sender) ───────────────────────────

/**
 * Sends the AI-generated reply as a real email via the accountant's
 * corporate SMTP server. JWT-authenticated + subscription-gated.
 * Input: { taskId, replyBody, recipientEmail }
 */
export const sendAiReply = onRequest({
  cors: true,
  maxInstances: 5,
  invoker: "public",
}, async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Access-Control-Allow-Methods", "POST");
      res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.status(204).send("");
      return;
    }

    // Auth
    const authResult = await verifyAuthToken(req);
    if (!authResult) {
      res.status(401).send("Unauthorized");
      return;
    }

    // Subscription check
    if (!(await checkSubscription(authResult.email))) {
      res.status(403).send("Forbidden: Active subscription required");
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method Not Allowed. Must be POST." });
      return;
    }

    const { taskId, replyBody, recipientEmail } = req.body as Partial<SendAiReplyRequest>;
    if (!taskId || !replyBody || !recipientEmail) {
      res.status(400).json({ error: "Missing required fields: taskId, replyBody, recipientEmail." });
      return;
    }

    // Load email config
    const configDoc = await db.doc(`users/${authResult.email}/tokens/email_config`).get();
    if (!configDoc.exists) {
      res.status(400).json({ error: "No email configuration found. Please connect your email first." });
      return;
    }
    const config = configDoc.data() as EmailConfig;

    if (config.provider === "google") {
      res.status(400).json({ error: "Google email replies are handled via the Gmail API. Use the Gmail interface." });
      return;
    }

    if (!config.password) {
      res.status(400).json({ error: "Missing email credentials. Please reconfigure your email connection." });
      return;
    }

    const servers = resolveEmailServers(config);

    // Load original task for subject threading
    const taskDoc = await db.collection("tasks").doc(taskId).get();
    const taskData = taskDoc.exists ? taskDoc.data() : null;
    const originalSubject = taskData?.subject || "Nincs tárgy";

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
});

/**
 * SUBSYSTEM 5: sendManualEmail
 * Authenticated POST endpoint to compose and send manual SMTP replies.
 */
export const sendManualEmail = onRequest({
  cors: true,
  maxInstances: 10,
  invoker: "public",
}, async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.status(204).send('');
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

    const { taskId, recipient, subject, body } = req.body as {
      taskId: string;
      recipient: string;
      subject: string;
      body: string;
    };

    if (!taskId || !recipient || !subject || !body) {
      res.status(400).json({ error: "Missing required fields: taskId, recipient, subject, body" });
      return;
    }

    // Load accountant SMTP config
    const configDoc = await db.doc(`users/${userEmail}/tokens/email_config`).get();
    if (!configDoc.exists) {
      res.status(400).json({ error: "Email configuration missing. Please connect your email first." });
      return;
    }
    const config = configDoc.data() as EmailConfig;
    const servers = resolveEmailServers(config);

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
});

/**
 * SUBSYSTEM 6: improveEmailDraft
 * Authenticated POST endpoint to professionalize draft content using AI.
 */
export const improveEmailDraft = onRequest({
  cors: true,
  maxInstances: 10,
  invoker: "public",
  secrets: ["OPENAI_API_KEY"],
}, async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.status(204).send('');
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

    const { text } = req.body as { text: string };
    if (!text || !text.trim()) {
      res.status(400).json({ error: "Missing required field: text" });
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
});

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
export const archiveTask = onRequest({ cors: true }, async (req, res) => {
  try {
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

    const { taskId } = req.body as { taskId: string };
    if (!taskId) {
      res.status(400).json({ error: "Missing required field: taskId" });
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
});

/**
 * Restore Task (Undo Soft Delete)
 * Sets task status to "active", clears archivedAt, and resets ai_status to "pending_review".
 */
export const restoreTask = onRequest({ cors: true }, async (req, res) => {
  try {
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

    const { taskId } = req.body as { taskId: string };
    if (!taskId) {
      res.status(400).json({ error: "Missing required field: taskId" });
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
});
