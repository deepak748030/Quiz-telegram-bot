import { afterEach, describe, expect, it, vi } from "vitest";

import webhook from "../api/webhook.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("webhook endpoint", () => {
  it("reports non-secret configuration status", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "test_secret");
    vi.stubEnv("GEMINI_API_KEY", "test-key");

    const response = await webhook.fetch(
      new Request("https://example.com/api/webhook"),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      service: "telegram-gemini-quiz-bot",
      configured: {
        telegram: true,
        webhookSecret: true,
        gemini: true,
      },
    });
    expect(JSON.stringify(body)).not.toContain("test-token");
    expect(JSON.stringify(body)).not.toContain("test_secret");
    expect(JSON.stringify(body)).not.toContain("test-key");
  });

  it("rejects unauthorized and malformed Telegram requests", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "expected_secret");

    const unauthorized = await webhook.fetch(
      new Request("https://example.com/api/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ update_id: 1 }),
      }),
    );
    expect(unauthorized.status).toBe(401);

    const malformed = await webhook.fetch(
      new Request("https://example.com/api/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "expected_secret",
        },
        body: "not-json",
      }),
    );
    expect(malformed.status).toBe(400);
  });
});
