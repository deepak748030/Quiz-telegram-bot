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

  it("allows MAX_QUIZ_COUNT=50 but rejects values above it", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "test-secret");
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubEnv("MAX_QUIZ_COUNT", "50");

    expect(getConfig().maxQuizCount).toBe(50);

    vi.stubEnv("MAX_QUIZ_COUNT", "51");
    expect(() => getConfig()).toThrow("MAX_QUIZ_COUNT must be an integer from 3 to 50");
  });
});
