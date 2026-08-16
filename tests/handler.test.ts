import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearAllUserAISettings, getUserAISettings } from "../src/user-settings.js";

// Mocks are declared with vi.hoisted so they exist before the mocked modules
// are imported (vi.mock factories run during import resolution).
const { telegramMocks, geminiMocks, pdfMocks } = vi.hoisted(() => {
  const telegramInstance = () => ({
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    editMessage: vi
      .fn()
      .mockResolvedValue({ message_id: 10, chat: { id: 1, type: "private" } }),
    sendMessage: vi
      .fn()
      .mockResolvedValue({ message_id: 10, chat: { id: 1, type: "private" } }),
    sendQuiz: vi
      .fn()
      .mockResolvedValue({ message_id: 11, chat: { id: 1, type: "private" } }),
    sendChatAction: vi.fn().mockResolvedValue(true),
    downloadFile: vi.fn(),
    deleteMessage: vi.fn().mockResolvedValue(true),
    getFile: vi.fn(),
    call: vi.fn(),
  });
  return {
    telegramMocks: telegramInstance(),
    geminiMocks: { listGeminiModels: vi.fn(), generate: vi.fn() },
    pdfMocks: { extractPdfText: vi.fn() },
  };
});

vi.mock("../src/telegram.js", () => ({
  TelegramClient: vi.fn().mockImplementation(function () {
    return telegramMocks;
  }),
  delay: vi.fn().mockResolvedValue(undefined),
  formatBytes: (bytes: number) => `${bytes} B`,
}));

vi.mock("../src/gemini.js", () => ({
  listGeminiModels: (...args: unknown[]) => geminiMocks.listGeminiModels(...args),
  GeminiQuizGenerator: vi.fn().mockImplementation(function () {
    return { generate: (...args: unknown[]) => geminiMocks.generate(...args) };
  }),
}));

vi.mock("../src/pdf.js", () => {
  class PdfExtractionError extends Error {}
  return {
    PdfExtractionError,
    extractPdfText: (...args: unknown[]) => pdfMocks.extractPdfText(...args),
  };
});

const { handleUpdate } = await import("../src/handler.js");

const stubEnv = () => {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "test_secret");
  vi.stubEnv("GEMINI_API_KEY", "test-gemini-key");
};

const pdfBytes = (text = "%PDF-1.4 hello world"): Uint8Array =>
  new TextEncoder().encode(text);

beforeEach(() => {
  vi.clearAllMocks();
  clearAllUserAISettings();
  stubEnv();
  telegramMocks.sendMessage.mockResolvedValue({
    message_id: 10,
    chat: { id: 1, type: "private" },
  });
  telegramMocks.editMessage.mockResolvedValue({
    message_id: 10,
    chat: { id: 1, type: "private" },
  });
  geminiMocks.listGeminiModels.mockResolvedValue([
    "gemini-a",
    "gemini-b",
    "gemini-c",
  ]);
  pdfMocks.extractPdfText.mockResolvedValue({
    text: "Text extracted locally from the uploaded PDF for quiz generation.",
    totalPages: 1,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("handleUpdate — model menu callbacks", () => {
  it("re-fetches the missing model catalogue and applies the selection", async () => {
    // Memory is empty (cold instance / restart), yet the inline buttons are
    // still on screen. The callback must rebuild the list, not look dead.
    await handleUpdate({
      update_id: 1,
      callback_query: {
        id: "cb1",
        from: { id: 99, is_bot: false, first_name: "User" },
        message: { message_id: 5, chat: { id: 1, type: "private" }, date: 0 },
        data: "model:1",
      },
    });

    expect(geminiMocks.listGeminiModels).toHaveBeenCalledTimes(1);
    expect(telegramMocks.answerCallbackQuery).toHaveBeenCalledWith(
      "cb1",
      "Selected gemini-b",
    );
    // The rebuilt menu should mark gemini-b as the selected model.
    const markup = telegramMocks.editMessage.mock.calls[0]?.[4] as {
      inline_keyboard: { text: string; callback_data: string }[][];
    };
    expect(markup.inline_keyboard[1]?.[0]?.text).toBe("✅ gemini-b");
    // And cache the catalogue so the next click does not need another fetch.
    expect(getUserAISettings(99).availableModels).toEqual([
      "gemini-a",
      "gemini-b",
      "gemini-c",
    ]);
  });

  it("reuses the cached catalogue on subsequent clicks (no extra fetch)", async () => {
    await handleUpdate({
      update_id: 1,
      callback_query: {
        id: "cb1",
        from: { id: 99, is_bot: false, first_name: "User" },
        message: { message_id: 5, chat: { id: 1, type: "private" }, date: 0 },
        data: "model:0",
      },
    });
    geminiMocks.listGeminiModels.mockClear();

    await handleUpdate({
      update_id: 2,
      callback_query: {
        id: "cb2",
        from: { id: 99, is_bot: false, first_name: "User" },
        message: { message_id: 5, chat: { id: 1, type: "private" }, date: 0 },
        data: "model:1",
      },
    });

    expect(geminiMocks.listGeminiModels).not.toHaveBeenCalled();
  });

  it("advances pages via the Next button after a catalogue rebuild", async () => {
    // 15 models span 2 pages, exercising the navigation path.
    const many = Array.from({ length: 15 }, (_, index) => `gemini-${index}`);
    geminiMocks.listGeminiModels.mockResolvedValue(many);

    await handleUpdate({
      update_id: 1,
      callback_query: {
        id: "cb1",
        from: { id: 99, is_bot: false, first_name: "User" },
        message: { message_id: 5, chat: { id: 1, type: "private" }, date: 0 },
        data: "models:1",
      },
    });

    expect(geminiMocks.listGeminiModels).toHaveBeenCalledTimes(1);
    expect(telegramMocks.answerCallbackQuery).toHaveBeenCalledWith("cb1");
    const text = telegramMocks.editMessage.mock.calls[0]?.[2] as string;
    expect(text).toContain("Page 2/2");
    const markup = telegramMocks.editMessage.mock.calls[0]?.[4] as {
      inline_keyboard: { text: string; callback_data: string }[][];
    };
    // Page 2 starts at index 10 -> "gemini-10".
    expect(markup.inline_keyboard[0]?.[0]?.text).toBe("gemini-10");
  });
});

describe("handleUpdate — PDF quiz errors surface the real cause", () => {
  it("includes a sanitized excerpt of the Gemini error on failure", async () => {
    telegramMocks.downloadFile.mockResolvedValue(pdfBytes());
    const apiError = Object.assign(
      new Error(
        JSON.stringify({
          error: {
            code: 400,
            message: "Number of input tokens must be positive",
            status: "INVALID_ARGUMENT",
          },
        }),
      ),
      { status: 400 },
    );
    geminiMocks.generate.mockRejectedValue(apiError);

    await handleUpdate({
      update_id: 3,
      message: {
        message_id: 7,
        from: { id: 99, is_bot: false, first_name: "User" },
        chat: { id: 1, type: "private" },
        date: 0,
        document: {
          file_id: "f1",
          file_unique_id: "u1",
          file_name: "doc.pdf",
          mime_type: "application/pdf",
          file_size: 1234,
        },
      },
    });

    expect(pdfMocks.extractPdfText).toHaveBeenCalledOnce();
    expect(geminiMocks.generate).toHaveBeenCalledWith(
      {
        kind: "text",
        text: "Text extracted locally from the uploaded PDF for quiz generation.",
      },
      expect.any(Object),
    );
    const failureText = telegramMocks.editMessage.mock.calls
      .map((call) => call[2])
      .find((text) => typeof text === "string" && text.includes("Quiz creation failed"));
    expect(failureText).toBeTruthy();
    // The real reason is now visible instead of a generic guess.
    expect(failureText).toContain("Number of input tokens must be positive");
  });

  it("never leaks the Gemini API key into the user-facing error", async () => {
    telegramMocks.downloadFile.mockResolvedValue(pdfBytes());
    geminiMocks.generate.mockRejectedValue(
      Object.assign(
        new Error(
          JSON.stringify({
            error: {
              code: 400,
              message: "something broke using key test-gemini-key here",
              status: "INVALID_ARGUMENT",
            },
          }),
        ),
        { status: 400 },
      ),
    );

    await handleUpdate({
      update_id: 4,
      message: {
        message_id: 8,
        from: { id: 99, is_bot: false, first_name: "User" },
        chat: { id: 1, type: "private" },
        date: 0,
        document: {
          file_id: "f1",
          file_unique_id: "u1",
          file_name: "doc.pdf",
          mime_type: "application/pdf",
          file_size: 1234,
        },
      },
    });

    const failureText = telegramMocks.editMessage.mock.calls
      .map((call) => call[2])
      .find((text) => typeof text === "string" && text.includes("Quiz creation failed"));
    expect(failureText).toBeTruthy();
    expect(failureText).toContain("[REDACTED]");
    expect(failureText).not.toContain("test-gemini-key");
  });
});
