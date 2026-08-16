import type {
  Quiz,
  TelegramApiResponse,
  TelegramFile,
  TelegramSentMessage,
} from "./types.js";

const TELEGRAM_API_ROOT = "https://api.telegram.org";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_API_ATTEMPTS = 4;

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export class TelegramApiError extends Error {
  readonly code: number | undefined;
  readonly retryAfter: number | undefined;

  constructor(message: string, code?: number, retryAfter?: number) {
    super(message);
    this.name = "TelegramApiError";
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export class TelegramClient {
  readonly #token: string;
  readonly #baseUrl: string;

  constructor(token: string) {
    this.#token = token;
    this.#baseUrl = `${TELEGRAM_API_ROOT}/bot${token}`;
  }

  async call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_API_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(`${this.#baseUrl}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        const data = (await response.json()) as TelegramApiResponse<T>;
        if (response.ok && data.ok && data.result !== undefined) return data.result;

        const retryAfter = data.parameters?.retry_after;
        const error = new TelegramApiError(
          data.description || `Telegram ${method} failed with HTTP ${response.status}.`,
          data.error_code || response.status,
          retryAfter,
        );

        if ((data.error_code === 429 || response.status >= 500) && attempt < MAX_API_ATTEMPTS - 1) {
          await sleep((retryAfter ?? 2 ** attempt) * 1_000 + 100);
          lastError = error;
          continue;
        }
        throw error;
      } catch (error) {
        lastError = error;
        if (error instanceof TelegramApiError || attempt >= MAX_API_ATTEMPTS - 1) {
          throw error;
        }
        await sleep(400 * 2 ** attempt);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`Telegram ${method} failed.`);
  }

  sendMessage(
    chatId: number,
    text: string,
    options: {
      parseMode?: "HTML";
      replyToMessageId?: number;
      messageThreadId?: number;
      disableNotification?: boolean;
    } = {},
  ): Promise<TelegramSentMessage> {
    return this.call<TelegramSentMessage>("sendMessage", {
      chat_id: chatId,
      text,
      ...(options.parseMode ? { parse_mode: options.parseMode } : {}),
      ...(options.replyToMessageId
        ? {
            reply_parameters: {
              message_id: options.replyToMessageId,
              allow_sending_without_reply: true,
            },
          }
        : {}),
      ...(options.messageThreadId
        ? { message_thread_id: options.messageThreadId }
        : {}),
      ...(options.disableNotification !== undefined
        ? { disable_notification: options.disableNotification }
        : {}),
    });
  }

  editMessage(
    chatId: number,
    messageId: number,
    text: string,
    parseMode: "HTML" = "HTML",
  ): Promise<TelegramSentMessage> {
    return this.call<TelegramSentMessage>("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: parseMode,
      link_preview_options: { is_disabled: true },
    });
  }

  sendChatAction(
    chatId: number,
    action: "typing" | "upload_document",
    messageThreadId?: number,
  ): Promise<true> {
    return this.call<true>("sendChatAction", {
      chat_id: chatId,
      action,
      ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
    });
  }

  sendQuiz(
    chatId: number,
    quiz: Quiz,
    options: {
      replyToMessageId?: number;
      messageThreadId?: number;
    } = {},
  ): Promise<TelegramSentMessage> {
    return this.call<TelegramSentMessage>("sendPoll", {
      chat_id: chatId,
      question: quiz.question,
      options: quiz.options.map((text) => ({ text })),
      type: "quiz",
      is_anonymous: false,
      allows_revoting: true,
      correct_option_ids: [quiz.correctOption],
      explanation: quiz.explanation,
      ...(options.replyToMessageId
        ? {
            reply_parameters: {
              message_id: options.replyToMessageId,
              allow_sending_without_reply: true,
            },
          }
        : {}),
      ...(options.messageThreadId
        ? { message_thread_id: options.messageThreadId }
        : {}),
    });
  }

  getFile(fileId: string): Promise<TelegramFile> {
    return this.call<TelegramFile>("getFile", { file_id: fileId });
  }

  async downloadFile(fileId: string, maxBytes: number): Promise<Uint8Array> {
    const file = await this.getFile(fileId);
    if (!file.file_path) throw new Error("Telegram did not provide a download path.");
    if (file.file_size && file.file_size > maxBytes) {
      throw new Error(`PDF is larger than the ${formatBytes(maxBytes)} limit.`);
    }

    const response = await fetch(
      `${TELEGRAM_API_ROOT}/file/bot${this.#token}/${file.file_path}`,
      { signal: AbortSignal.timeout(60_000) },
    );
    if (!response.ok) {
      throw new Error(`Telegram file download failed with HTTP ${response.status}.`);
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > maxBytes) {
      throw new Error(`PDF is larger than the ${formatBytes(maxBytes)} limit.`);
    }

    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > maxBytes) {
      throw new Error(`PDF is larger than the ${formatBytes(maxBytes)} limit.`);
    }
    return data;
  }
}

export const formatBytes = (bytes: number): string => {
  if (bytes < 1_000_000) return `${Math.ceil(bytes / 1_000)} KB`;
  return `${(bytes / 1_000_000).toFixed(bytes % 1_000_000 === 0 ? 0 : 1)} MB`;
};

export const delay = sleep;
