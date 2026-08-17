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
      "✅ Selected gemini-b",
    );
    // The rebuilt menu should mark gemini-b's command button as selected.
    const markup = telegramMocks.editMessage.mock.calls[0]?.[4] as {
      inline_keyboard: { text: string; callback_data: string }[][];
    };
    expect(markup.inline_keyboard[1]?.[0]?.text).toBe("✅ /use_2");
    expect(markup.inline_keyboard[1]?.[0]?.callback_data).toBe("/use_2");
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
    // Page 2 starts at catalogue index 10 -> command "/use_11".
    expect(markup.inline_keyboard[0]?.[0]?.text).toBe("/use_11");
    expect(markup.inline_keyboard[0]?.[0]?.callback_data).toBe("/use_11");
  });
});

describe("handleUpdate — tappable HTML commands in the model menu", () => {
  const userMessage = (text: string, messageId = 20) => ({
    message_id: messageId,
    from: { id: 99, is_bot: false, first_name: "User" },
    chat: { id: 1, type: "private" as const },
    date: 0,
    text,
  });

  it("renders a tappable /use_N command for every model", async () => {
    await handleUpdate({ update_id: 1, message: userMessage("/model") });

    const text = telegramMocks.sendMessage.mock.calls[0]?.[1] as string;
    // Telegram turns each /use_N into a bot_command entity, which is tappable
    // in every client and needs only `message` updates to work.
    expect(text).toContain("/use_1");
    expect(text).toContain("gemini-a");
    expect(text).toContain("/use_3");
    expect(text).toContain("gemini-c");
  });

  it("selects a model when the user taps /use_2", async () => {
    await handleUpdate({ update_id: 1, message: userMessage("/use_2") });

    expect(getUserAISettings(99).model).toBe("gemini-b");
    const text = telegramMocks.sendMessage.mock.calls[0]?.[1] as string;
    expect(text).toContain("Model set to");
    expect(text).toContain("gemini-b");
  });

  it("strips a trailing @BotName so group taps still select the model", async () => {
    // Telegram appends @BotName when a command is tapped in a group chat.
    await handleUpdate({ update_id: 1, message: userMessage("/use_3@QuizBot") });

    expect(getUserAISettings(99).model).toBe("gemini-c");
  });

  it("pages through the list with /model_2", async () => {
    const many = Array.from({ length: 15 }, (_, index) => `gemini-${index}`);
    geminiMocks.listGeminiModels.mockResolvedValue(many);
    // Prime the cache so /model_2 reuses the list the menu was rendered from.
    await handleUpdate({ update_id: 1, message: userMessage("/model") });
    telegramMocks.sendMessage.mockClear();

    await handleUpdate({ update_id: 2, message: userMessage("/model_2") });

    const text = telegramMocks.sendMessage.mock.calls[0]?.[1] as string;
    expect(text).toContain("Page 2/2");
    // Page 2 starts at catalogue index 10, so its first command is /use_11.
    expect(text).toContain("/use_11");
    expect(text).toContain("gemini-10");
  });

  it("rejects an out-of-range /use_N instead of silently doing nothing", async () => {
    await handleUpdate({ update_id: 1, message: userMessage("/use_99") });

    expect(getUserAISettings(99).model).toBeUndefined();
    const text = telegramMocks.sendMessage.mock.calls[0]?.[1] as string;
    expect(text).toContain("no longer valid");
  });

  it("keeps /use_N bound to the model shown even after the catalogue grows", async () => {
    // The menu was rendered from this list...
    await handleUpdate({ update_id: 1, message: userMessage("/model") });
    // ...and Google adds a model that sorts first before the user taps.
    geminiMocks.listGeminiModels.mockResolvedValue([
      "gemini-0-new",
      "gemini-a",
      "gemini-b",
      "gemini-c",
    ]);

    await handleUpdate({ update_id: 2, message: userMessage("/use_2") });

    // Still the model the user actually saw next to /use_2.
    expect(getUserAISettings(99).model).toBe("gemini-b");
  });
});

describe("handleUpdate — inline buttons execute the real /use_N commands", () => {
  it("labels every button with its working /use_N command", async () => {
    await handleUpdate({ update_id: 1, message: userSetup() });
    const markup = telegramMocks.sendMessage.mock.calls[0]?.[2] as {
      replyMarkup: { inline_keyboard: { text: string; callback_data: string }[][] };
    };
    const rows = markup.replyMarkup.inline_keyboard;
    expect(rows[0]?.[0]?.text).toBe("/use_1");
    expect(rows[0]?.[0]?.callback_data).toBe("/use_1");
    expect(rows[1]?.[0]?.text).toBe("/use_2");
    expect(rows[2]?.[0]?.callback_data).toBe("/use_3");
    // No button shows only a bare model name anymore.
    for (const row of rows) {
      for (const button of row) {
        expect(button.text).toMatch(/\/(?:use|model)_\d+/);
      }
    }
  });

  it("runs a tapped /use_N through the same path as the typed command", async () => {
    await handleUpdate({ update_id: 1, message: userSetup() });
    const markup = telegramMocks.sendMessage.mock.calls[0]?.[2] as {
      replyMarkup: { inline_keyboard: { text: string; callback_data: string }[][] };
    };
    const button = markup.replyMarkup.inline_keyboard[1]?.[0];
    expect(button?.callback_data).toBe("/use_2");
    telegramMocks.sendMessage.mockClear();

    await handleUpdate({
      update_id: 2,
      callback_query: {
        id: "cb1",
        from: { id: 99, is_bot: false, first_name: "User" },
        message: { message_id: 5, chat: { id: 1, type: "private" }, date: 0 },
        data: button!.callback_data,
      },
    });

    // Same result and same confirmation the typed /use_2 command produces.
    expect(getUserAISettings(99).model).toBe("gemini-b");
    expect(telegramMocks.answerCallbackQuery).toHaveBeenCalledWith("cb1");
    const text = telegramMocks.sendMessage.mock.calls[0]?.[1] as string;
    expect(text).toContain("Model set to");
    expect(text).toContain("gemini-b");
  });

  it("pages via the navigation button's /model_N command", async () => {
    const many = Array.from({ length: 15 }, (_, index) => `gemini-${index}`);
    geminiMocks.listGeminiModels.mockResolvedValue(many);
    await handleUpdate({ update_id: 1, message: userSetup() });
    const markup = telegramMocks.sendMessage.mock.calls[0]?.[2] as {
      replyMarkup: { inline_keyboard: { text: string; callback_data: string }[][] };
    };
    const nextButton = markup.replyMarkup.inline_keyboard.at(-1)?.[0];
    expect(nextButton?.callback_data).toBe("/model_2");
    telegramMocks.sendMessage.mockClear();

    await handleUpdate({
      update_id: 2,
      callback_query: {
        id: "cb1",
        from: { id: 99, is_bot: false, first_name: "User" },
        message: { message_id: 5, chat: { id: 1, type: "private" }, date: 0 },
        data: nextButton!.callback_data,
      },
    });

    const text = telegramMocks.sendMessage.mock.calls[0]?.[1] as string;
    expect(text).toContain("Page 2/2");
    expect(text).toContain("/use_11");
  });

  it("still honours legacy token buttons left on screen from old deployments", async () => {
    const { modelToken } = await import("../src/model-menu.js");
    await handleUpdate({
      update_id: 1,
      callback_query: {
        id: "cb1",
        from: { id: 99, is_bot: false, first_name: "User" },
        message: { message_id: 5, chat: { id: 1, type: "private" }, date: 0 },
        data: `m:${modelToken("gemini-b")}`,
      },
    });

    expect(getUserAISettings(99).model).toBe("gemini-b");
  });

  it("always answers an unrecognised callback so the spinner stops", async () => {
    await handleUpdate({
      update_id: 1,
      callback_query: {
        id: "cb1",
        from: { id: 99, is_bot: false, first_name: "User" },
        message: { message_id: 5, chat: { id: 1, type: "private" }, date: 0 },
        data: "m:deadbeef00",
      },
    });

    expect(telegramMocks.answerCallbackQuery).toHaveBeenCalledWith(
      "cb1",
      expect.stringContaining("no longer available"),
      true,
    );
  });
});

describe("handleUpdate — 28-model catalogue, page 3 (/use_21…/use_28)", () => {
  // The exact page-3 models from the production catalogue, at catalogue
  // indices 20-27 so their commands are /use_21…/use_28.
  const page3Models = [
    "gemini-3.6-flash",
    "gemini-3.7-flash",
    "gemini-flash-latest",
    "gemini-flash-lite-latest",
    "gemini-omni-flash-preview",
    "gemini-pro-latest",
    "gemini-robotics-er-1.6-preview",
    "gemini-robotics-er-2-preview",
  ];
  const catalogue = [
    ...Array.from({ length: 20 }, (_, index) => `gemini-model-${index + 1}`),
    ...page3Models,
  ];

  const expectedByCommand: Record<string, string> = {
    "/use_21": "gemini-3.6-flash",
    "/use_22": "gemini-3.7-flash",
    "/use_23": "gemini-flash-latest",
    "/use_24": "gemini-flash-lite-latest",
    "/use_25": "gemini-omni-flash-preview",
    "/use_26": "gemini-pro-latest",
    "/use_27": "gemini-robotics-er-1.6-preview",
    "/use_28": "gemini-robotics-er-2-preview",
  };

  beforeEach(() => {
    geminiMocks.listGeminiModels.mockResolvedValue(catalogue);
  });

  it("renders /use_21…/use_28 command buttons and a /model_2 previous-page button", async () => {
    await handleUpdate({
      update_id: 1,
      message: { ...userSetup(), text: "/model_3" },
    });

    const text = telegramMocks.sendMessage.mock.calls[0]?.[1] as string;
    expect(text).toContain("Page 3/3");
    expect(text).toContain("Previous page: /model_2");

    const markup = telegramMocks.sendMessage.mock.calls[0]?.[2] as {
      replyMarkup: { inline_keyboard: { text: string; callback_data: string }[][] };
    };
    const rows = markup.replyMarkup.inline_keyboard;
    // 8 command buttons + 1 navigation row.
    expect(rows).toHaveLength(9);
    for (const [index, command] of Object.keys(expectedByCommand).entries()) {
      expect(rows[index]?.[0]?.text).toBe(command);
      expect(rows[index]?.[0]?.callback_data).toBe(command);
    }
    expect(rows[8]?.[0]?.text).toBe("⬅️ /model_2");
    expect(rows[8]?.[0]?.callback_data).toBe("/model_2");
  });

  for (const [command, expectedModel] of Object.entries(expectedByCommand)) {
    it(`tapping ${command} selects ${expectedModel}, exactly like typing it`, async () => {
      // Tap the button.
      await handleUpdate({
        update_id: 1,
        callback_query: {
          id: "cb1",
          from: { id: 99, is_bot: false, first_name: "User" },
          message: { message_id: 5, chat: { id: 1, type: "private" }, date: 0 },
          data: command,
        },
      });
      expect(getUserAISettings(99).model).toBe(expectedModel);
      const tappedReply = telegramMocks.sendMessage.mock.calls.at(-1)?.[1] as string;
      expect(tappedReply).toContain("Model set to");
      expect(tappedReply).toContain(expectedModel);

      // Typing the same command still works and produces the same reply.
      clearAllUserAISettings();
      geminiMocks.listGeminiModels.mockResolvedValue(catalogue);
      telegramMocks.sendMessage.mockClear();
      await handleUpdate({
        update_id: 2,
        message: { ...userSetup(), text: command },
      });
      expect(getUserAISettings(99).model).toBe(expectedModel);
      const typedReply = telegramMocks.sendMessage.mock.calls.at(-1)?.[1] as string;
      expect(typedReply).toContain("Model set to");
      expect(typedReply).toContain(expectedModel);
    });
  }
});

const userSetup = () => ({
  message_id: 20,
  from: { id: 99, is_bot: false, first_name: "User" },
  chat: { id: 1, type: "private" as const },
  date: 0,
  text: "/model",
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
