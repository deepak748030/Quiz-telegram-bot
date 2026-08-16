import { afterEach, describe, expect, it, vi } from "vitest";

import { getConfig } from "../src/config.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("quiz count configuration", () => {
  it("defaults to a maximum of 50 questions", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "test-secret");
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubEnv("MAX_QUIZ_COUNT", "");
    vi.stubEnv("DEFAULT_QUIZ_COUNT", "");

    const config = getConfig();
    expect(config.defaultQuizCount).toBe(8);
    expect(config.maxQuizCount).toBe(50);
  });

  it("defaults to the current stable Gemini model when GEMINI_MODEL is unset", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "test-secret");
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubEnv("GEMINI_MODEL", "");

    expect(getConfig().geminiModel).toBe("gemini-2.5-flash");
  });

  it("migrates the retired Gemini 2.0 default used by old deployments", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "test-secret");
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubEnv("GEMINI_MODEL", "gemini-2.0-flash-lite");

    expect(getConfig().geminiModel).toBe("gemini-2.5-flash");
  });

  it("migrates the removed gemini-2.5-flash-lite model used by old deployments", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "test-secret");
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubEnv("GEMINI_MODEL", "gemini-2.5-flash-lite");

    expect(getConfig().geminiModel).toBe("gemini-2.5-flash");
  });

  it("allows MAX_QUIZ_COUNT up to 100 but rejects values above it", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "test-secret");
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubEnv("MAX_QUIZ_COUNT", "100");

    expect(getConfig().maxQuizCount).toBe(100);

    vi.stubEnv("MAX_QUIZ_COUNT", "101");
    expect(() => getConfig()).toThrow("MAX_QUIZ_COUNT must be an integer from 1 to 100");
  });
});
