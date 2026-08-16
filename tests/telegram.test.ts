import { afterEach, describe, expect, it, vi } from "vitest";

import { TelegramClient } from "../src/telegram.js";

const quiz = {
  question: "Which planet is known as the Red Planet?",
  options: ["Venus", "Mars", "Jupiter", "Mercury"] as [
    string,
    string,
    string,
    string,
  ],
  correctOption: 1,
  explanation: "Iron oxides make Mars appear red.",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TelegramClient.sendQuiz", () => {
  it("uses the current Telegram quiz payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        ok: true,
        result: { message_id: 42, chat: { id: 123, type: "private" } },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new TelegramClient("test-token");
    await client.sendQuiz(123, quiz, {
      replyToMessageId: 9,
      messageThreadId: 7,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/sendPoll$/);

    const payload = JSON.parse(String(request.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      chat_id: 123,
      type: "quiz",
      is_anonymous: false,
      allows_revoting: true,
      correct_option_id: 1,
      explanation: quiz.explanation,
      message_thread_id: 7,
      reply_parameters: {
        message_id: 9,
        allow_sending_without_reply: true,
      },
    });
    expect(payload.options).toEqual([
      { text: "Venus" },
      { text: "Mars" },
      { text: "Jupiter" },
      { text: "Mercury" },
    ]);
  });
});
