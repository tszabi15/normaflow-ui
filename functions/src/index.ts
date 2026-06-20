import { setGlobalOptions } from "firebase-functions/v2";
import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import { OpenAI } from "openai";

// Set global options for the functions (max instances for budget/cost control)
setGlobalOptions({ maxInstances: 10 });

// Initialize Firebase Admin
admin.initializeApp();
const db = getFirestore();

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
    if (!userDoc.exists || userDoc.data()?.subscriptionStatus !== "active") {
      logger.warn(`Forbidden request to handleIncomingEmail: user ${targetEmail} does not have an active subscription`);
      res.status(403).json({
        error: "Forbidden: Account requires an active subscription to process background email automation."
      });
      return;
    }

    // Step B: Fetch Accountant's Custom Rules
    logger.info(`Fetching auto-responder settings for userEmail: ${targetEmail}`);
    const autoResponderRef = db.doc(`users/${targetEmail}/settings/auto_responder`);
    const rulesDoc = await autoResponderRef.get();

    let automationEnabled = false;
    let promptRules = "";

    if (rulesDoc.exists) {
      const data = rulesDoc.data();
      automationEnabled = !!data?.automationEnabled;
      promptRules = data?.promptRules || "";
    }

    let aiReply: string | null = null;

    // Step C: Cost-Optimized AI Engine
    if (automationEnabled && promptRules.trim()) {
      logger.info(`Triggering OpenAI gpt-4o-mini for userEmail: ${targetEmail}`);
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      
      const systemPrompt = `Te a NormaFlow AI asszisztense vagy egy könyvelőirodában. A feladatod, hogy a beérkező e-mailre generálj egy hivatalos, udvarias választervezetet a könyvelő által meghatározott egyedi szabályok alapján.\n\nKönyvelő egyedi szabályai:\n${promptRules}`;
      const userPrompt = `Feladó: ${sender}\nTárgy: ${subject || "Nincs tárgy megadva"}\nÜzenet:\n${textContent}`;

      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        max_tokens: 400,
      });

      aiReply = response.choices[0]?.message?.content || null;
    } else {
      logger.info(`AI automation disabled or prompt rules missing/empty for userEmail: ${targetEmail}`);
    }

    // Step D: Structured Firestore Ingestion
    const aiStatus = aiReply ? "sent" : "idle";
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
      status: "pending",
      ai_status: aiStatus,
      ai_reply: aiReply,
    };

    logger.info("Saving new task to Firestore...");
    const taskDocRef = await db.collection("tasks").add(taskPayload);
    logger.info(`Successfully created task with ID: ${taskDocRef.id}`);

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
