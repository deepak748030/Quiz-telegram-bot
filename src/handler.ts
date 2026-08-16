import { getConfig } from "./config.js";
import { GeminiQuizGenerator } from "./gemini.js";
import { parsePastedQuiz, parseQuizInput } from "./quiz.js";
import { delay, formatBytes, TelegramClient } from "./telegram.js";
import type {
  QuizRequestOptions,
  QuizSource,
  TelegramMessage,
  TelegramUpdate,
} from "./types.js";

const escapeHtml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const commandName = (text: string): string | undefined => {
  const first = text.trim().split(/\s+/, 1)[0]?.toLowerCase();
  return first?.match(/^\/[a-z]+/)?.[0];
};

const isPdf = (message: TelegramMessage): boolean => {
  const document = message.document;
  if (!document) return false;
  return (
    document.mime_type?.toLowerCase() === "application/pdf" ||
    document.file_name?.toLowerCase().endsWith(".pdf") === true
  );
};

const hasPdfSignature = (bytes: Uint8Array): boolean => {
  const header = new TextDecoder("ascii").decode(bytes.slice(0, 1_024));
  return header.includes("%PDF-");
};

const startText = (firstName: string, defaultCount: number, maxCount: number) => `
<b>Hi ${escapeHtml(firstName)}! 👋</b>

Send me <b>any text</b> or a <b>PDF</b>. I’ll turn it into native Telegram quiz polls with answers and explanations.

<b>Default:</b> ${defaultCount} mixed-difficulty questions for study material. Pre-written question sets are counted automatically (up to ${maxCount}).

<b>Custom quiz</b>
<code>/quiz 12 hard Hindi</code>
Then put your source text on the next line, or use that command as a PDF caption.

You can create 3–${maxCount} questions. Use /help for examples.
`.trim();

const helpText = (maxCount: number, maxPdfBytes: number) => `
<b>How to create a quiz</b>

1️⃣ <b>Quick:</b> paste source text directly.
2️⃣ <b>PDF:</b> upload a PDF (up to ${formatBytes(maxPdfBytes)}).
3️⃣ <b>Custom:</b>
<pre>/quiz 10 medium Hinglish
Paste your source text here...</pre>
4️⃣ <b>Ready-made questions:</b> paste a numbered list or upload a question-set PDF. I’ll use every detected question instead of stopping at the default count (up to ${maxCount}). Complete MCQs with A)–D) and <code>Correct answer:</code> or <code>सही उत्तर:</code> are sent directly.
For a PDF, add <code>/quiz 10 medium Hinglish</code> as its caption.

<b>Format</b>
<code>/quiz [3-${maxCount}] [easy|medium|hard|mixed] [language]</code>

<b>Examples</b>
<code>/quiz 5 easy English</code>
<code>/quiz 12 hard Hindi</code>
<code>/quiz 8 mixed auto</code>

“auto” keeps the source language. Every poll has 4 choices, one correct answer, and a short explanation.
`.trim();

const safeErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  if (normalized.includes("larger than") || normalized.includes("too large")) {
    return `That PDF is too large for Telegram’s hosted Bot API. Please upload a file under 20 MB.`;
  }
  if (normalized.includes("429") || normalized.includes("quota") || normalized.includes("resource_exhausted")) {
    return "Gemini’s free quota is busy or exhausted right now. Please wait a little and try again.";
  }
  if (normalized.includes("pdf") || normalized.includes("document")) {
    return "I couldn’t read that PDF. Make sure it is a valid, non-password-protected PDF and try again.";
  }
  if (normalized.includes("api key") || normalized.includes("401") || normalized.includes("403")) {
    return "The bot’s AI service is not configured correctly. Please contact the bot owner.";
  }
  return "I couldn’t create this quiz. Please try a clearer source or a smaller PDF.";
};

const logError = (context: string, error: unknown): void => {
  const configSecrets = [
    process.env.TELEGRAM_BOT_TOKEN,
    process.env.GEMINI_API_KEY,
    process.env.TELEGRAM_WEBHOOK_SECRET,
  ].filter((value): value is string => Boolean(value));
  let message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  for (const secret of configSecrets) message = message.replaceAll(secret, "[REDACTED]");
  console.error(context, message);
};

const replyOptions = (message: TelegramMessage) => ({
  parseMode: "HTML" as const,
  replyToMessageId: message.message_id,
  ...(message.message_thread_id
    ? { messageThreadId: message.message_thread_id }
    : {}),
});

const sendHelpForEmptyQuiz = async (
  telegram: TelegramClient,
  message: TelegramMessage,
  maxCount: number,
): Promise<void> => {
  await telegram.sendMessage(
    message.chat.id,
    `Add source text on a <b>new line</b> after the command, or attach a PDF with the command as its caption.\n\nExample:\n<pre>/quiz 5 medium Hindi\nYour source text starts here...</pre>\nCount can be 3–${maxCount}.`,
    replyOptions(message),
  );
};

const getRequest = (
  message: TelegramMessage,
  defaultCount: number,
  maxCount: number,
): {
  options: QuizRequestOptions;
  sourceText: string;
  countWasSpecified: boolean;
  error?: string;
} => {
  const input = message.document ? message.caption ?? "" : message.text ?? "";
  const parsed = parseQuizInput(input, defaultCount, maxCount);
  return {
    options: parsed.options,
    sourceText: parsed.sourceText,
    countWasSpecified: parsed.countWasSpecified === true,
    ...(parsed.error ? { error: parsed.error } : {}),
  };
};

export const handleUpdate = async (update: TelegramUpdate): Promise<void> => {
  const message = update.message;
  if (!message || message.from?.is_bot) return;

  const config = getConfig();
  const telegram = new TelegramClient(config.telegramToken);
  const text = message.text ?? "";
  const command = commandName(text);

  if (command === "/start") {
    await telegram.sendMessage(
      message.chat.id,
      startText(
        message.from?.first_name || "there",
        config.defaultQuizCount,
        config.maxQuizCount,
      ),
      replyOptions(message),
    );
    return;
  }

  if (command === "/help") {
    await telegram.sendMessage(
      message.chat.id,
      helpText(config.maxQuizCount, config.maxPdfBytes),
      replyOptions(message),
    );
    return;
  }

  if (command === "/model") {
    await telegram.sendMessage(
      message.chat.id,
      `<b>AI model:</b> <code>${escapeHtml(config.geminiModel)}</code>\nOptimized for fast, structured quiz generation.`,
      replyOptions(message),
    );
    return;
  }

  if (command && command !== "/quiz") {
    await telegram.sendMessage(
      message.chat.id,
      "Unknown command. Send text/PDF directly, or use /help.",
      replyOptions(message),
    );
    return;
  }

  if (message.document && !isPdf(message)) {
    await telegram.sendMessage(
      message.chat.id,
      "Please upload a <b>PDF</b>. Other document types are not supported yet.",
      replyOptions(message),
    );
    return;
  }

  if (!message.document && !text.trim()) return;

  const request = getRequest(
    message,
    config.defaultQuizCount,
    config.maxQuizCount,
  );
  if (request.error) {
    await telegram.sendMessage(
      message.chat.id,
      `⚠️ ${escapeHtml(request.error)}`,
      replyOptions(message),
    );
    return;
  }

  if (!message.document && !request.sourceText) {
    await sendHelpForEmptyQuiz(telegram, message, config.maxQuizCount);
    return;
  }

  if (!message.document && Array.from(request.sourceText).length < 20) {
    await telegram.sendMessage(
      message.chat.id,
      "Please send at least 20 characters of useful source text so I can create a good quiz.",
      replyOptions(message),
    );
    return;
  }

  if (message.document?.file_size && message.document.file_size > config.maxPdfBytes) {
    await telegram.sendMessage(
      message.chat.id,
      `That PDF is too large. Maximum supported size is <b>${formatBytes(config.maxPdfBytes)}</b>.`,
      replyOptions(message),
    );
    return;
  }

  const pastedQuiz = parsePastedQuiz(
    message.document ? "" : request.sourceText,
    config.maxQuizCount,
  );
  if (pastedQuiz.error) {
    await telegram.sendMessage(
      message.chat.id,
      `⚠️ ${escapeHtml(pastedQuiz.error)}`,
      replyOptions(message),
    );
    return;
  }

  const inferredCount =
    !request.countWasSpecified && pastedQuiz.detectedCount > 0
      ? pastedQuiz.detectedCount
      : request.options.count;
  const generationOptions: QuizRequestOptions = {
    ...request.options,
    count: inferredCount,
    ...(message.document && !request.countWasSpecified
      ? { autoCount: true, maxCount: config.maxQuizCount }
      : {}),
  };
  const countLabel = pastedQuiz.quizSet
    ? String(pastedQuiz.quizSet.quizzes.length)
    : generationOptions.autoCount
      ? `up to ${config.maxQuizCount}`
      : String(generationOptions.count);
  const status = await telegram.sendMessage(
    message.chat.id,
    `⏳ <b>Creating ${countLabel} quiz questions…</b>\nReading the source and checking the answers.`,
    replyOptions(message),
  );

  try {
    await telegram.sendChatAction(
      message.chat.id,
      message.document ? "upload_document" : "typing",
      message.message_thread_id,
    );

    let quizSet = pastedQuiz.quizSet;
    if (!quizSet) {
      let source: QuizSource;
      if (message.document) {
        const bytes = await telegram.downloadFile(
          message.document.file_id,
          config.maxPdfBytes,
        );
        if (!hasPdfSignature(bytes)) throw new Error("Document is not a valid PDF.");
        source = {
          kind: "pdf",
          data: bytes,
        };
      } else {
        source = { kind: "text", text: request.sourceText };
      }

      const generator = new GeminiQuizGenerator(
        config.geminiApiKey,
        config.geminiModel,
      );
      quizSet = await generator.generate(source, generationOptions);
    }

    await telegram.editMessage(
      message.chat.id,
      status.message_id,
      `✅ <b>${escapeHtml(quizSet.title)}</b>\nGenerated ${quizSet.quizzes.length} questions. Sending them now…`,
    );

    for (const [index, quiz] of quizSet.quizzes.entries()) {
      await telegram.sendQuiz(message.chat.id, quiz, {
        ...(index === 0 ? { replyToMessageId: message.message_id } : {}),
        ...(message.message_thread_id
          ? { messageThreadId: message.message_thread_id }
          : {}),
      });
      if (index < quizSet.quizzes.length - 1) await delay(config.pollDelayMs);
    }

    await telegram.editMessage(
      message.chat.id,
      status.message_id,
      `🎉 <b>${escapeHtml(quizSet.title)}</b>\n${quizSet.quizzes.length} quiz questions are ready. Tap an option to answer!`,
    );
  } catch (error) {
    logError(`Update ${update.update_id} failed:`, error);
    const userMessage = safeErrorMessage(error);
    try {
      await telegram.editMessage(
        message.chat.id,
        status.message_id,
        `❌ <b>Quiz creation failed</b>\n${escapeHtml(userMessage)}`,
      );
    } catch (editError) {
      logError(`Could not edit failure status for update ${update.update_id}:`, editError);
    }
  }
};
