import { getConfig } from "./config.js";
import { GeminiQuizGenerator, listGeminiModels } from "./gemini.js";
import {
  buildModelMenu,
  escapeHtml,
  isModelMenuCommand,
  pageOfModel,
  parseModelCallback,
  parseModelCommand,
} from "./model-menu.js";
import { extractPdfText, PdfExtractionError } from "./pdf.js";
import { parsePastedQuiz, parseQuizInput } from "./quiz.js";
import { delay, formatBytes, TelegramClient } from "./telegram.js";
import {
  getUserAISettings,
  redactUserApiKeys,
  resetUserAISettings,
  setAvailableModels,
  setUserApiKey,
  setUserModel,
} from "./user-settings.js";
import type {
  QuizRequestOptions,
  QuizSource,
  TelegramMessage,
  TelegramUpdate,
} from "./types.js";

/**
 * Extracts the leading bot command from a message.
 *
 * `_` and digits are part of the match on purpose: the model picker renders
 * tappable `/use_3` and `/model_2` commands, and a name pattern of `/[a-z]+`
 * would truncate those to `/use` and `/model`, so the tap would be answered by
 * the wrong branch. A trailing `@BotName` (added by Telegram when a command is
 * tapped in a group) is stripped.
 */
const commandName = (text: string): string | undefined => {
  const first = text.trim().split(/\s+/, 1)[0]?.toLowerCase();
  return first?.match(/^\/[a-z][a-z0-9_]*/)?.[0];
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

const apiKeyArgument = (text: string): string | undefined =>
  text.trim().match(/^\/apikey(?:@[A-Za-z0-9_]+)?(?:\s+(.+))?$/is)?.[1]?.trim();

const startText = (firstName: string, defaultCount: number, maxCount: number) => `
<b>Hi ${escapeHtml(firstName)}! 👋</b>

Send me <b>any text</b> or a <b>PDF</b>. I’ll turn it into native Telegram quiz polls with answers and explanations.

<b>Default:</b> ${defaultCount} mixed-difficulty questions for study material. Pre-written question sets are counted automatically (up to ${maxCount}).

<b>Custom quiz</b>
<code>/quiz 12 hard Hindi</code>
Then put your source text on the next line, or use that command as a PDF caption.

You can create 1–${maxCount} questions. Use /help for examples.

Use /model to choose any Gemini model, or /apikey to securely use your own Gemini API key.
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
<code>/quiz [1-${maxCount}] [easy|medium|hard|mixed] [language]</code>

<b>Examples</b>
<code>/quiz 5 easy English</code>
<code>/quiz 12 hard Hindi</code>
<code>/quiz 8 mixed auto</code>

“auto” keeps the source language. Every poll has 4 choices, one correct answer, and a short explanation.

<b>Personal Gemini settings</b>
/model — see and select all models available to your key. Tap the button showing the model’s name; if buttons don’t respond in your client, type the matching <code>/use_1</code>-style command instead.
/apikey YOUR_KEY — use or change your own key (private chat only)
/apikey reset — return to the bot’s default key and model
`.trim();

/** Short, presentable, secret-free excerpt of an error for user-facing text. */
const sanitizeErrorHint = (raw: string): string => {
  // The @google/genai SDK throws an ApiError whose `message` is the raw JSON
  // error body, e.g. {"error":{"code":400,"message":"...","status":"..."}}.
  // Prefer that inner human-readable message when it can be parsed.
  let text = raw;
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const body = JSON.parse(jsonMatch[0]) as { error?: { message?: string } };
      if (body?.error?.message) text = body.error.message;
    } catch {
      /* keep the original text */
    }
  }

  let clean = text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  const secrets = [
    process.env.TELEGRAM_BOT_TOKEN,
    process.env.GEMINI_API_KEY,
    process.env.TELEGRAM_WEBHOOK_SECRET,
  ].filter((value): value is string => Boolean(value));
  for (const secret of secrets) clean = clean.replaceAll(secret, "[REDACTED]");
  clean = redactUserApiKeys(clean);
  if (clean.length > 140) clean = `${clean.slice(0, 137)}...`;
  return clean ? ` (${clean})` : "";
};

const safeErrorMessage = (
  error: unknown,
  usesPersonalKey = false,
  wasPdf = false,
): string => {
  if (error instanceof PdfExtractionError) return error.message;

  const message = error instanceof Error ? error.message : String(error);
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status?: unknown }).status)
      : NaN;
  // Treat snake_case and space-separated status strings the same way - Gemini
  // reports both "resource_exhausted" and "RESOURCE_EXHAUSTED", for instance.
  const normalized = message.toLowerCase().replaceAll("_", " ");
  // Short, secret-free excerpt of the real error. Surfaced in the branches
  // where a friendly guess alone would leave the user (and support) guessing.
  const hint = sanitizeErrorHint(message);

  if (
    normalized.includes("too large") ||
    normalized.includes("too big") ||
    normalized.includes("larger than") ||
    normalized.includes("exceeds the") ||
    normalized.includes("maximum allowed") ||
    normalized.includes("max bytes") ||
    normalized.includes("request entity too large")
  ) {
    return wasPdf
      ? `The text extracted from this PDF is too large for the AI service to process at once.${hint} Split the PDF into smaller parts or paste a shorter section.`
      : `That request is too large for the AI service to process at once.${hint}`;
  }
  if (
    normalized.includes("429") ||
    normalized.includes("quota") ||
    normalized.includes("resource exhausted") ||
    normalized.includes("rate limit")
  ) {
    return "Gemini's free quota is busy or exhausted right now. Please wait a little and try again.";
  }
  if (
    normalized.includes("api key") ||
    normalized.includes("apikey") ||
    normalized.includes("unauthorized") ||
    normalized.includes("unauthenticated") ||
    normalized.includes("permission denied") ||
    /\b40[13]\b/.test(normalized)
  ) {
    return usesPersonalKey
      ? "Your Gemini API key was rejected. Update it in private with /apikey YOUR_KEY."
      : "The bot's AI service is not configured correctly. Please contact the bot owner.";
  }
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return "Gemini had a temporary server error. Please try again in a moment.";
  }
  if (
    normalized.includes("not found") ||
    normalized.includes("model not supported") ||
    normalized.includes("not supported") ||
    normalized.includes("does not support")
  ) {
    return "The selected Gemini model is not available or doesn't support this request. Use /model to pick a different one.";
  }
  if (normalized.includes("invalid argument") || normalized.includes("invalid value")) {
    return wasPdf
      ? `Gemini could not process the text extracted from this PDF.${hint} Try a smaller PDF or choose another model with /model.`
      : `Gemini could not process this request.${hint} Please retry, or choose another model with /model.`;
  }
  if (
    normalized.includes("safety") ||
    normalized.includes("blocked") ||
    normalized.includes("prohibited") ||
    normalized.includes("harmful")
  ) {
    return "Gemini blocked this content for safety reasons. Try different source material.";
  }
  if (
    normalized.includes("json") ||
    normalized.includes("empty response") ||
    normalized.includes("did not return any valid") ||
    normalized.includes("cannot get text")
  ) {
    return "Gemini did not return usable quiz questions after 3 attempts. Please retry once; if it continues, choose another model with /model.";
  }
  if (
    normalized.includes("fetch") ||
    normalized.includes("timeout") ||
    normalized.includes("network") ||
    normalized.includes("econnreset") ||
    normalized.includes("socket")
  ) {
    return "The AI service could not be reached. Please wait a moment and try again.";
  }

  // Fallback: surface the real error so the user (and support) can act on it
  // instead of guessing from a generic message.
  return wasPdf
    ? `I couldn't create a quiz from the extracted PDF text.${hint} Try a smaller PDF, paste the text directly, or use /model to switch models.`
    : `I couldn't create this quiz.${hint} Please retry or choose another model with /model.`;
};

const logError = (context: string, error: unknown): void => {
  const configSecrets = [
    process.env.TELEGRAM_BOT_TOKEN,
    process.env.GEMINI_API_KEY,
    process.env.TELEGRAM_WEBHOOK_SECRET,
  ].filter((value): value is string => Boolean(value));
  let message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  for (const secret of configSecrets) message = message.replaceAll(secret, "[REDACTED]");
  console.error(context, redactUserApiKeys(message));
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
    `Add source text on a <b>new line</b> after the command, or attach a PDF with the command as its caption.\n\nExample:\n<pre>/quiz 5 medium Hindi\nYour source text starts here...</pre>\nCount can be 1–${maxCount}.`,
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

/**
 * Returns the model catalogue for a user, fetching it when process memory has
 * none.
 *
 * The catalogue lives only in memory, so it disappears on every restart,
 * redeploy, or cold serverless invocation — while the menu stays on screen in
 * the user's chat. Rebuilding it on demand is what keeps an old menu working
 * instead of silently ignoring taps.
 */
const loadModels = async (
  userId: number,
  fallbackApiKey: string,
): Promise<string[] | undefined> => {
  const settings = getUserAISettings(userId);
  if (settings.availableModels && settings.availableModels.length > 0) {
    return settings.availableModels;
  }
  try {
    const models = await listGeminiModels(settings.apiKey ?? fallbackApiKey);
    setAvailableModels(userId, models);
    return models;
  } catch {
    return undefined;
  }
};

export const handleUpdate = async (update: TelegramUpdate): Promise<void> => {
  const config = getConfig();
  const telegram = new TelegramClient(config.telegramToken);
  const callback = update.callback_query;

  if (callback) {
    try {
      const callbackMessage = callback.message;
      if (!callbackMessage) {
        await telegram.answerCallbackQuery(
          callback.id,
          "This menu is no longer available. Send /model again.",
          true,
        );
        return;
      }

      // Current menu buttons carry the literal `/use_N` / `/model_N` command
      // as their callback_data. A tap must behave exactly as if the user had
      // typed that command, so acknowledge the tap and re-dispatch the update
      // as a plain command message from the tapping user. This funnels the
      // button through the identical, already-working command branch below —
      // same parser, same model-switching logic, same confirmation reply.
      if (callback.data && /^\/(?:use|model)_\d+$/.test(callback.data)) {
        await telegram.answerCallbackQuery(callback.id);
        await handleUpdate({
          update_id: update.update_id,
          message: {
            message_id: callbackMessage.message_id,
            ...(callbackMessage.message_thread_id
              ? { message_thread_id: callbackMessage.message_thread_id }
              : {}),
            from: callback.from,
            chat: callbackMessage.chat,
            date: callbackMessage.date,
            text: callback.data,
          },
        });
        return;
      }

      const models = await loadModels(callback.from.id, config.geminiApiKey);
      if (!models) {
        await telegram.answerCallbackQuery(
          callback.id,
          "I couldn't refresh the model list. Send /model to reload it.",
          true,
        );
        return;
      }

      const action = parseModelCallback(callback.data, models);
      if (action.kind === "unknown") {
        // Answering is mandatory: an unanswered callback leaves Telegram's
        // spinner on the button until it times out, which is exactly what
        // "the button does nothing" looks like to a user.
        await telegram.answerCallbackQuery(
          callback.id,
          "That option is no longer available. Send /model to reload the list.",
          true,
        );
        return;
      }

      let page: number;
      if (action.kind === "select") {
        setUserModel(callback.from.id, action.model);
        page = pageOfModel(models, action.model);
        await telegram.answerCallbackQuery(callback.id, `✅ Selected ${action.model}`);
      } else {
        page = action.page;
        await telegram.answerCallbackQuery(callback.id);
      }

      const selectedModel = getUserAISettings(callback.from.id).model ?? config.geminiModel;
      const menu = buildModelMenu(models, selectedModel, page);
      try {
        await telegram.editMessage(
          callbackMessage.chat.id,
          callbackMessage.message_id,
          menu.text,
          "HTML",
          menu.markup,
        );
      } catch (editError) {
        // Telegram returns 400 "message is not modified" when the content is
        // the same — that is harmless. Silently ignore it.
        const msg = editError instanceof Error ? editError.message.toLowerCase() : "";
        if (!msg.includes("message is not modified")) {
          logError(`Callback edit failed for user ${callback.from.id}:`, editError);
        }
      }
    } catch (callbackError) {
      logError(`Callback query ${callback.id} failed:`, callbackError);
      try {
        await telegram.answerCallbackQuery(
          callback.id,
          "Something went wrong. Please try again.",
          true,
        );
      } catch {
        // Best-effort; nothing more we can do.
      }
    }
    return;
  }

  const message = update.message;
  if (!message || message.from?.is_bot) return;

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

  if (command === "/apikey") {
    if (message.chat.type !== "private") {
      await telegram.sendMessage(
        message.chat.id,
        "🔒 For your safety, API keys can only be added in a private chat with me.",
        replyOptions(message),
      );
      return;
    }

    const argument = apiKeyArgument(text);
    if (!argument) {
      await telegram.sendMessage(
        message.chat.id,
        "<b>Use your own Gemini API key</b>\n\nSend <code>/apikey YOUR_KEY</code> here in private. I’ll validate it and delete that message immediately. Use <code>/apikey reset</code> to return to the bot’s default key.\n\nYour key is kept only in this bot process and is cleared when the service restarts.",
        replyOptions(message),
      );
      return;
    }

    // Remove the secret-bearing Telegram message before making any network call.
    await telegram.deleteMessage(message.chat.id, message.message_id).catch(() => undefined);
    if (argument.toLowerCase() === "reset") {
      resetUserAISettings(message.from!.id);
      await telegram.sendMessage(
        message.chat.id,
        `✅ Personal AI settings cleared. Using the bot default: <code>${escapeHtml(config.geminiModel)}</code>.`,
        { parseMode: "HTML" },
      );
      return;
    }
    if (/\s/.test(argument) || argument.length < 10 || argument.length > 256) {
      await telegram.sendMessage(
        message.chat.id,
        "❌ That does not look like a valid Gemini API key. Nothing was saved.",
      );
      return;
    }

    try {
      const models = await listGeminiModels(argument);
      const oldModel = getUserAISettings(message.from!.id).model;
      const selectedModel = oldModel && models.includes(oldModel)
        ? oldModel
        : models.includes(config.geminiModel)
          ? config.geminiModel
          : models[0]!;
      setUserApiKey(message.from!.id, argument);
      setUserModel(message.from!.id, selectedModel);
      setAvailableModels(message.from!.id, models);
      const menu = buildModelMenu(models, selectedModel, 0);
      await telegram.sendMessage(
        message.chat.id,
        `✅ <b>Your Gemini key is active.</b> It will be used for your quizzes.\n\n${menu.text}`,
        { parseMode: "HTML", replyMarkup: menu.markup },
      );
    } catch {
      await telegram.sendMessage(
        message.chat.id,
        "❌ I couldn’t validate that key or find Gemini generation models for it. Check the key and Gemini API access, then try again. Nothing was saved.",
      );
    }
    return;
  }

  // `/model`, `/models`, `/model_2` (page) and `/use_7` (selection) all land
  // here. The paged/selecting variants are the tappable commands rendered in
  // the menu's HTML body, and they run the same logic as the inline buttons.
  if (command && isModelMenuCommand(command)) {
    const userId = message.from!.id;

    // `/model` and `/models` always refetch so the catalogue is current;
    // `/use_N` and `/model_N` reuse the cached list the menu was built from,
    // so the number the user tapped still refers to the model they saw.
    const isRefresh = command === "/model" || command === "/models";
    const models = isRefresh
      ? await listGeminiModels(
          getUserAISettings(userId).apiKey ?? config.geminiApiKey,
        ).then(
          (fetched) => {
            setAvailableModels(userId, fetched);
            return fetched;
          },
          () => undefined,
        )
      : await loadModels(userId, config.geminiApiKey);

    if (!models) {
      await telegram.sendMessage(
        message.chat.id,
        "❌ I couldn’t load the Gemini model list. If you use a personal key, update it with <code>/apikey YOUR_KEY</code>.",
        replyOptions(message),
      );
      return;
    }

    const action = isRefresh
      ? ({ kind: "page", page: 0 } as const)
      : parseModelCommand(command, models);

    if (action.kind === "unknown") {
      await telegram.sendMessage(
        message.chat.id,
        "⚠️ That model number is no longer valid. Send /model to reload the list.",
        replyOptions(message),
      );
      return;
    }

    let page: number;
    let confirmation = "";
    if (action.kind === "select") {
      setUserModel(userId, action.model);
      page = pageOfModel(models, action.model);
      confirmation = `✅ <b>Model set to <code>${escapeHtml(action.model)}</code></b>\n\n`;
    } else {
      page = action.page;
    }

    const selectedModel = getUserAISettings(userId).model ?? config.geminiModel;
    const menu = buildModelMenu(models, selectedModel, page);
    await telegram.sendMessage(message.chat.id, `${confirmation}${menu.text}`, {
      ...replyOptions(message),
      replyMarkup: menu.markup,
    });
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
        if (!hasPdfSignature(bytes)) {
          throw new PdfExtractionError(
            "INVALID_PDF",
            "This file is not a valid PDF. Export it as a new PDF and try again.",
          );
        }
        const extracted = await extractPdfText(bytes, {
          maxPages: config.maxPdfPages,
          maxCharacters: config.maxPdfTextCharacters,
        });
        source = {
          kind: "text",
          text: extracted.text,
        };
      } else {
        source = { kind: "text", text: request.sourceText };
      }

      const userSettings = message.from
        ? getUserAISettings(message.from.id)
        : {};
      const generator = new GeminiQuizGenerator(
        userSettings.apiKey ?? config.geminiApiKey,
        userSettings.model ?? config.geminiModel,
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
    const usesPersonalKey = message.from
      ? Boolean(getUserAISettings(message.from.id).apiKey)
      : false;
    const userMessage = safeErrorMessage(
      error,
      usesPersonalKey,
      Boolean(message.document),
    );
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
