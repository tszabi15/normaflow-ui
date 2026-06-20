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
  userId: string;
}

interface FeedbackSubmitRequest {
  title: string;
  category: string;
  description?: string;
  user_email: string;
}

/**
 * SUBSYSTEM 1: handleIncomingEmail
 * Replaces Make.com email-to-task pipeline.
 * Input: POST JSON payload: { sender, subject, textContent, userId }
 */
export const handleIncomingEmail = onRequest({
  cors: true,
  secrets: ["OPENAI_API_KEY"],
  maxInstances: 10,
}, async (req, res) => {
  try {
    // Validate Method
    if (req.method !== "POST") {
      logger.warn(`Method Not Allowed: ${req.method}`);
      res.status(405).json({ error: "Method Not Allowed. Must be POST." });
      return;
    }

    const { sender, subject, textContent, userId } = req.body as Partial<IncomingEmailRequest>;

    // Step A: Validation & Strict Spam Filter
    if (!sender || !textContent || !userId) {
      logger.warn("Validation failed: missing sender, textContent, or userId");
      res.status(400).json({ error: "Missing required fields: sender, textContent, and userId are all required." });
      return;
    }

    const senderLower = sender.toLowerCase();
    const spamKeywords = ["noreply", "newsletter", "spam", "facebook", "linkedin", "marketing"];
    const isSpamSender = spamKeywords.some(keyword => senderLower.includes(keyword));
    const isTooShort = textContent.length < 20;

    if (isSpamSender || isTooShort) {
      logger.info(
        `Email filtered. Reason - Spam sender check: ${isSpamSender}, Text too short check: ${isTooShort}. Sender: ${sender}.`
      );
      res.status(200).json({ status: "filtered", message: "Email filtered as spam or system message." });
      return;
    }

    // Step B: Fetch Accountant's Custom Rules
    logger.info(`Fetching auto-responder settings for userId: ${userId}`);
    const autoResponderRef = db.doc(`users/${userId}/settings/auto_responder`);
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
      logger.info(`Triggering OpenAI gpt-4o-mini for userId: ${userId}`);
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
      logger.info(`AI automation disabled or prompt rules missing/empty for userId: ${userId}`);
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
      user_email: userId, // map to userId as requested
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
 * Input: POST JSON payload: { title, category, description, user_email }
 */
export const handleFeedbackSubmit = onRequest({
  cors: true,
  maxInstances: 10,
}, async (req, res) => {
  try {
    // Validate Method
    if (req.method !== "POST") {
      logger.warn(`Method Not Allowed: ${req.method}`);
      res.status(405).json({ error: "Method Not Allowed. Must be POST." });
      return;
    }

    const { title, category, description, user_email } = req.body as Partial<FeedbackSubmitRequest>;

    // Step A: Validation
    if (!title || !category || !user_email) {
      logger.warn("Validation failed: missing title, category, or user_email");
      res.status(400).json({
        error: "Bad Request",
        message: "Missing required fields. 'title', 'category', and 'user_email' are required.",
      });
      return;
    }

    // Step B: Firestore Ingestion
    const feedbackPayload = {
      title,
      type: category, // category string maps to type field
      description: description || "",
      user_email,
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
