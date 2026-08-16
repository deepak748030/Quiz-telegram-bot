import { timingSafeEqual } from "node:crypto";

import { configurationStatus } from "./config.js";
import { handleUpdate } from "./handler.js";
import type { TelegramUpdate } from "./types.js";
import { redactUserApiKeys } from "./user-settings.js";

export interface WebhookHandlerOptions {
  /**
   * Called with the background quiz-generation task after the webhook has been
   * acknowledged. On a persistent server this is fire-and-forget; on a
   * serverless platform (e.g. Vercel) pass the platform's `waitUntil` so the
   * function is kept alive while the task runs.
   */
  waitUntil: (task: Promise<void>) => void;
}

const json = (data: unknown, status = 200): Response =>
  Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });

const isTelegramUpdate = (value: unknown): value is TelegramUpdate => {
  if (!value || typeof value !== "object") return false;
  return typeof (value as { update_id?: unknown }).update_id === "number";
};

const secretsMatch = (provided: string | null, expected: string): boolean => {
  if (!provided) return false;
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  return (
    providedBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(providedBytes, expectedBytes)
  );
};

const backgroundError = (error: unknown): void => {
  let message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  for (const secret of [
    process.env.TELEGRAM_BOT_TOKEN,
    process.env.GEMINI_API_KEY,
    process.env.TELEGRAM_WEBHOOK_SECRET,
  ]) {
    if (secret) message = message.replaceAll(secret, "[REDACTED]");
  }
  console.error("Unhandled webhook task error:", redactUserApiKeys(message));
};

/**
 * Returns a fetch-style handler for the Telegram webhook. Used both by the
 * Render HTTP server and (optionally) the Vercel serverless function.
 */
export const createWebhookHandler = ({
  waitUntil,
}: WebhookHandlerOptions) => {
  return async (request: Request): Promise<Response> => {
    if (request.method === "GET") {
      const status = configurationStatus();
      return json({
        ok: status.telegram && status.webhookSecret && status.gemini,
        service: "telegram-gemini-quiz-bot",
        configured: {
          telegram: status.telegram,
          webhookSecret: status.webhookSecret,
          gemini: status.gemini,
        },
        model: status.model,
        timestamp: new Date().toISOString(),
      });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "GET, POST" },
      });
    }

    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
    if (!expectedSecret) {
      return json({ ok: false, error: "Webhook is not configured." }, 503);
    }

    const providedSecret = request.headers.get(
      "x-telegram-bot-api-secret-token",
    );
    if (!secretsMatch(providedSecret, expectedSecret)) {
      return json({ ok: false, error: "Unauthorized." }, 401);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "Invalid JSON." }, 400);
    }

    if (!isTelegramUpdate(body)) {
      return json({ ok: false, error: "Invalid Telegram update." }, 400);
    }

    // Acknowledge immediately and finish generation in the background.
    waitUntil(handleUpdate(body).catch(backgroundError));
    return json({ ok: true });
  };
};
