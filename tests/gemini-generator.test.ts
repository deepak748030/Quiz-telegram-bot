import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The generator builds its GoogleGenAI client internally, so we mock the SDK
// and capture the exact request it sends.
const { generateContentMock } = vi.hoisted(() => ({
  generateContentMock: vi.fn(),
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn().mockImplementation(function () {
    return { models: { generateContent: generateContentMock } };
  }),
}));

const { GeminiQuizGenerator } = await import("../src/gemini.js");
import type { QuizRequestOptions } from "../src/types.js";

const baseOptions: QuizRequestOptions = {
  count: 3,
  difficulty: "mixed",
  language: "auto",
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const validResponseText = JSON.stringify({
  title: "Sample Quiz",
  language: "auto",
  quizzes: [
    {
      question: "What is 1 + 1?",
      options: ["1", "2", "3", "4"],
      correctOption: 1,
      explanation: "Basic addition.",
    },
  ],
});

describe("GeminiQuizGenerator", () => {
  it("sends a PDF as base64 inline data with the correct mime type", async () => {
    generateContentMock.mockResolvedValue({ text: validResponseText });

    const pdfBytes = new TextEncoder().encode("%PDF-1.4 sample content");
    const generator = new GeminiQuizGenerator("key", "gemini-2.5-flash-lite");
    await generator.generate({ kind: "pdf", data: pdfBytes }, baseOptions);

    expect(generateContentMock).toHaveBeenCalledTimes(1);
    const request = generateContentMock.mock.calls[0]?.[0] as {
      model: string;
      contents: Array<{ role: string; parts: unknown[] }>;
    };
    expect(request.model).toBe("gemini-2.5-flash-lite");

    const inlineDataPart = request.contents[0]?.parts.find(
      (part) =>
        typeof part === "object" &&
        part !== null &&
        "inlineData" in (part as Record<string, unknown>),
    ) as { inlineData: { mimeType: string; data: string } } | undefined;

    expect(inlineDataPart).toBeDefined();
    expect(inlineDataPart?.inlineData.mimeType).toBe("application/pdf");
    // The base64 must round-trip back to the original PDF bytes.
    const decoded = Buffer.from(inlineDataPart!.inlineData.data, "base64");
    expect(decoded).toEqual(Buffer.from(pdfBytes));
  });

  it("migrates a retired gemini-2.0-flash model to gemini-2.5-flash-lite", async () => {
    generateContentMock.mockResolvedValue({ text: validResponseText });

    const generator = new GeminiQuizGenerator("key", "gemini-2.0-flash");
    await generator.generate(
      { kind: "text", text: "Some study material to turn into a quiz." },
      baseOptions,
    );

    const request = generateContentMock.mock.calls[0]?.[0] as { model: string };
    expect(request.model).toBe("gemini-2.5-flash-lite");
  });

  it("surfaces a Gemini API error to the caller", async () => {
    const apiError = Object.assign(
      new Error(
        JSON.stringify({
          error: {
            code: 400,
            message: "Request too large",
            status: "INVALID_ARGUMENT",
          },
        }),
      ),
      { status: 400 },
    );
    generateContentMock.mockRejectedValue(apiError);

    const generator = new GeminiQuizGenerator("key", "gemini-2.5-flash-lite");
    await expect(
      generator.generate({ kind: "pdf", data: new TextEncoder().encode("%PDF-1.4 x") }, baseOptions),
    ).rejects.toBe(apiError);
  });
});
