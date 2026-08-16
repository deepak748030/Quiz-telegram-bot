import { describe, expect, it } from "vitest";

import {
  buildQuizPrompt,
  parseQuizInput,
  sanitizeQuizSet,
  truncateUnicode,
} from "../src/quiz.js";

describe("parseQuizInput", () => {
  it("uses defaults for ordinary source text", () => {
    expect(parseQuizInput("Photosynthesis uses sunlight.", 8, 15)).toEqual({
      isQuizCommand: false,
      options: { count: 8, difficulty: "mixed", language: "auto" },
      sourceText: "Photosynthesis uses sunlight.",
    });
  });

  it("parses count, difficulty, language, and multiline source", () => {
    expect(
      parseQuizInput(
        "/quiz 12 hard Hindi\nपृथ्वी सूर्य की परिक्रमा करती है।",
        8,
        15,
      ),
    ).toEqual({
      isQuizCommand: true,
      options: { count: 12, difficulty: "hard", language: "Hindi" },
      sourceText: "पृथ्वी सूर्य की परिक्रमा करती है।",
    });
  });

  it("supports commands addressed to a bot username", () => {
    const parsed = parseQuizInput("/quiz@MyBot 5 easy English", 8, 15);
    expect(parsed.options).toEqual({
      count: 5,
      difficulty: "easy",
      language: "English",
    });
    expect(parsed.sourceText).toBe("");
  });

  it("rejects counts outside the configured range", () => {
    const parsed = parseQuizInput("/quiz 99 hard Hindi", 8, 15);
    expect(parsed.error).toContain("between 3 and 15");
  });

  it("rejects duplicate count and difficulty controls", () => {
    expect(parseQuizInput("/quiz 5 6 English", 8, 15).error).toBe(
      "Use only one question count.",
    );
    expect(parseQuizInput("/quiz easy hard English", 8, 15).error).toContain(
      "only one difficulty",
    );
  });
});

describe("quiz sanitization", () => {
  it("keeps valid quizzes and removes duplicate questions", () => {
    const quiz = {
      question: "What is H2O?",
      options: ["Water", "Oxygen", "Hydrogen", "Salt"],
      correctOption: 0,
      explanation: "H2O is the chemical formula for water.",
    };
    const result = sanitizeQuizSet(
      {
        title: "Chemistry",
        language: "English",
        quizzes: [quiz, { ...quiz, question: "  What is H2O?  " }],
      },
      8,
    );
    expect(result.quizzes).toHaveLength(1);
    expect(result.quizzes[0]?.correctOption).toBe(0);
  });

  it("drops malformed quizzes", () => {
    expect(() =>
      sanitizeQuizSet(
        {
          quizzes: [
            {
              question: "Bad question",
              options: ["same", "same", "third", "fourth"],
              correctOption: 0,
              explanation: "Nope",
            },
          ],
        },
        8,
      ),
    ).toThrow("did not return any valid");
  });

  it("truncates by Unicode code points", () => {
    expect(truncateUnicode("😀😀😀😀", 3)).toBe("😀😀…");
  });
});

describe("buildQuizPrompt", () => {
  it("contains the requested controls and injection resistance", () => {
    const prompt = buildQuizPrompt({
      count: 10,
      difficulty: "medium",
      language: "Hinglish",
    });
    expect(prompt).toContain("exactly 10");
    expect(prompt).toContain("Difficulty: medium");
    expect(prompt).toContain("in Hinglish");
    expect(prompt).toContain("untrusted content");
  });
});
