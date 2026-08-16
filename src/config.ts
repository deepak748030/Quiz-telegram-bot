import { DEFAULT_GEMINI_MODEL, resolveGeminiModel } from "./gemini-model.js";

export interface AppConfig {
  telegramToken: string;
  webhookSecret: string;
  geminiApiKey: string;
  geminiModel: string;
  defaultQuizCount: number;
  maxQuizCount: number;
  maxPdfBytes: number;
  maxPdfPages: number;
  maxPdfTextCharacters: number;
  pollDelayMs: number;
}

const readInteger = (
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const raw = process.env[name];
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
};

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const configuredGeminiModel = (): string => {
  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  // Keep old deployments working: Google shut down 2.0 Flash on 1 June 2026
  // and later removed 2.5 Flash-Lite for new API keys, so migrate both to the
  // current default instead of failing every text/PDF request.
  return resolveGeminiModel(model);
};

export const getConfig = (): AppConfig => {
  const webhookSecret = required("TELEGRAM_WEBHOOK_SECRET");
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(webhookSecret)) {
    throw new Error(
      "TELEGRAM_WEBHOOK_SECRET must be 1-256 characters using only A-Z, a-z, 0-9, _ and -.",
    );
  }

  const maxQuizCount = readInteger("MAX_QUIZ_COUNT", 50, 1, 100);
  const defaultQuizCount = readInteger(
    "DEFAULT_QUIZ_COUNT",
    8,
    1,
    maxQuizCount,
  );

  return {
    telegramToken: required("TELEGRAM_BOT_TOKEN"),
    webhookSecret,
    geminiApiKey: required("GEMINI_API_KEY"),
    geminiModel: configuredGeminiModel(),
    defaultQuizCount,
    maxQuizCount,
    maxPdfBytes: readInteger(
      "MAX_PDF_BYTES",
      20_000_000,
      100_000,
      20_000_000,
    ),
    // Bound untrusted PDF parsing and the amount of extracted text sent to AI.
    maxPdfPages: readInteger("MAX_PDF_PAGES", 500, 1, 2_000),
    maxPdfTextCharacters: readInteger(
      "MAX_PDF_TEXT_CHARACTERS",
      500_000,
      10_000,
      2_000_000,
    ),
    pollDelayMs: readInteger("POLL_DELAY_MS", 1_000, 250, 2_000),
  };
};

export const configurationStatus = () => ({
  telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim()),
  webhookSecret: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET?.trim()),
  gemini: Boolean(process.env.GEMINI_API_KEY?.trim()),
  model: configuredGeminiModel(),
});
