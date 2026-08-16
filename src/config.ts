export interface AppConfig {
  telegramToken: string;
  webhookSecret: string;
  geminiApiKey: string;
  geminiModel: string;
  defaultQuizCount: number;
  maxQuizCount: number;
  maxPdfBytes: number;
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

export const getConfig = (): AppConfig => {
  const webhookSecret = required("TELEGRAM_WEBHOOK_SECRET");
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(webhookSecret)) {
    throw new Error(
      "TELEGRAM_WEBHOOK_SECRET must be 1-256 characters using only A-Z, a-z, 0-9, _ and -.",
    );
  }

  const maxQuizCount = readInteger("MAX_QUIZ_COUNT", 50, 3, 50);
  const defaultQuizCount = readInteger(
    "DEFAULT_QUIZ_COUNT",
    8,
    3,
    maxQuizCount,
  );

  return {
    telegramToken: required("TELEGRAM_BOT_TOKEN"),
    webhookSecret,
    geminiApiKey: required("GEMINI_API_KEY"),
    geminiModel: process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash-lite",
    defaultQuizCount,
    maxQuizCount,
    maxPdfBytes: readInteger(
      "MAX_PDF_BYTES",
      20_000_000,
      100_000,
      20_000_000,
    ),
    pollDelayMs: readInteger("POLL_DELAY_MS", 1_000, 250, 2_000),
  };
};

export const configurationStatus = () => ({
  telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim()),
  webhookSecret: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET?.trim()),
  gemini: Boolean(process.env.GEMINI_API_KEY?.trim()),
  model: process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash-lite",
});
