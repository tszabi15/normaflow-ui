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

// Set global options for the functions (max instances for budget/cost control)
setGlobalOptions({ maxInstances: 10 });

// Initialize Firebase Admin
admin.initializeApp();
const db = getFirestore();

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

/** Check if a user has an active subscription */
async function checkSubscription(userEmail: string): Promise<boolean> {
  const userDoc = await db.collection("users").doc(userEmail).get();
  return userDoc.exists && userDoc.data()?.subscriptionStatus === "active";
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
    if (req.method !== "POST") {
      logger.warn(`Method Not Allowed: ${req.method}`);
      res.status(405).json({ error: "Method Not Allowed" });
      return;
    }

    const toField = (req.body.to || "").trim();
    const plusIndex = toField.indexOf("+");
    const atIndex = toField.indexOf("@");

    if (plusIndex === -1 || atIndex === -1 || plusIndex >= atIndex) {
      logger.error("Invalid routing format in 'to' field:", toField);
      res.status(400).json({ error: "Missing user routing token" });
      return;
    }
    const extractedUid = toField.substring(plusIndex + 1, atIndex).trim();

    // Map extractedUid to registered email address
    const userQuery = await db.collection("users").where("uid", "==", extractedUid).limit(1).get();
    if (userQuery.empty) {
      logger.warn(`User with UID ${extractedUid} not found`);
      res.status(404).json({ error: "User not found" });
      return;
    }
    const userDoc = userQuery.docs[0];
    const userEmail = userDoc.id;

    logger.info(`Saving raw incoming email from webhook for user UID: ${extractedUid} (${userEmail}) - public route`);
    let cleanSender = req.body.from || "Ismeretlen";
    if (cleanSender.includes("<")) {
      const match = cleanSender.match(/<([^>]+)>/);
      if (match && match[1]) cleanSender = match[1].trim();
    }
    cleanSender = cleanSender.toLowerCase().trim();

    const emailDocRef = await db.collection("emails").add({
      user_id: extractedUid,
      sender: cleanSender,
      subject: req.body.subject || "Nincs tárgy",
      textContent: req.body.text || "",
      received_at: new Date().toISOString(),
      status: "unread",
      received_via: "gas_router"
    });

    // Autonomous Trigger Hook
    try {
      const autoDoc = await db.doc(`users/${userEmail}/settings/auto_responder`).get();
      if (autoDoc.exists && autoDoc.data()?.globalAutomationEnabled === true) {
        logger.info(`handleIncomingEmailLogic: Auto-processing email ${emailDocRef.id} for ${userEmail}`);
        await processEmailInternally(emailDocRef.id, userEmail);
      }
    } catch (autoErr) {
      logger.error(`handleIncomingEmailLogic: Autonomous processing failed for email ${emailDocRef.id}:`, autoErr);
    }

    res.status(200).json({
      status: "success",
      emailId: emailDocRef.id
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

  // Load auto-responder rules for the user
  // Load user-defined custom AI rules from users/{userId}/settings/ai_rules
  let userId = emailData.user_id || "";
  if (!userId) {
    const userQuery = await db.collection("users").where("email", "==", userEmail).limit(1).get();
    if (!userQuery.empty) {
      userId = userQuery.docs[0].data().uid || userQuery.docs[0].id;
    }
  }

  let customPriorityRules = "";
  let customReplyRules = "";
  if (userId) {
    const aiRulesDoc = await db.doc(`users/${userId}/settings/ai_rules`).get();
    if (aiRulesDoc.exists) {
      const data = aiRulesDoc.data();
      customPriorityRules = data?.customPriorityRules || "";
      customReplyRules = data?.customReplyRules || "";
    }
  }

  // Load auto-responder rules for the user (for pre-filtering exclusions)
  const rulesDoc = await db.doc(`users/${userEmail}/settings/auto_responder`).get();
  let exclusionRules = "";
  if (rulesDoc.exists) {
    const rulesData = rulesDoc.data();
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
${customPriorityRules.trim() || "No custom priority rules provided by the user. Rely purely on the baseline logic."}

---
[USER-DEFINED CUSTOM REPLY DRAFTING INSTRUCTIONS]
${customReplyRules.trim() || "No custom reply rules provided by the user. Draft a formal, professional response in Hungarian."}`;

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
    const result = JSON.parse(response.choices[0]?.message?.content || "{}");

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

// ─── Central Express Routing Subsystem ──────────────────────────────────────

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

const registeredRoutes = [
  "/handleIncomingEmail",
  "/improveEmailDraft",
  "/sendManualEmail",
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
app.post("/archiveTask", archiveTaskLogic);
app.post("/restoreTask", restoreTaskLogic);
app.post("/handleFeedbackSubmit", handleFeedbackSubmitLogic);
app.post("/sendAiReply", sendAiReplyLogic);
app.post("/processEmailWithAi", processEmailWithAiLogic);
app.delete("/emails/:emailId", deleteEmailLogic);

export const api = onRequest({
  cors: true,
  secrets: ["OPENAI_API_KEY", "SERVER_WEBHOOK_KEY"],
  maxInstances: 10,
  invoker: "public",
}, app);
