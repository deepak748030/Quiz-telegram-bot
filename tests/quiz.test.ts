import { describe, expect, it } from "vitest";

import {
  buildQuizPrompt,
  parsePastedQuiz,
  parseQuizInput,
  sanitizeQuizSet,
  truncateUnicode,
} from "../src/quiz.js";

describe("parseQuizInput", () => {
  it("uses defaults for ordinary source text", () => {
    expect(parseQuizInput("Photosynthesis uses sunlight.", 8, 50)).toEqual({
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
        50,
      ),
    ).toEqual({
      isQuizCommand: true,
      options: { count: 12, difficulty: "hard", language: "Hindi" },
      sourceText: "पृथ्वी सूर्य की परिक्रमा करती है।",
      countWasSpecified: true,
    });
  });

  it("supports commands addressed to a bot username", () => {
    const parsed = parseQuizInput("/quiz@MyBot 5 easy English", 8, 50);
    expect(parsed.options).toEqual({
      count: 5,
      difficulty: "easy",
      language: "English",
    });
    expect(parsed.sourceText).toBe("");
    expect(parsed.countWasSpecified).toBe(true);
  });

  it("accepts up to 50 questions and rejects larger requests", () => {
    expect(parseQuizInput("/quiz 50 hard Hindi", 8, 50).options.count).toBe(50);

    const parsed = parseQuizInput("/quiz 99 hard Hindi", 8, 50);
    expect(parsed.error).toContain("between 3 and 50");
  });

  it("rejects duplicate count and difficulty controls", () => {
    expect(parseQuizInput("/quiz 5 6 English", 8, 50).error).toBe(
      "Use only one question count.",
    );
    expect(parseQuizInput("/quiz easy hard English", 8, 50).error).toContain(
      "only one difficulty",
    );
  });


  it("treats sentence-like text on the /quiz line as source", () => {
    const input = `/quiz Bilkul, ye 20 questions ek hi baar mein copy-paste kar sakte ho:

20 MCQ Quiz

1. भारत का राष्ट्रीय पशु कौन-सा है?`;
    const parsed = parseQuizInput(input, 8, 50);

    expect(parsed.error).toBeUndefined();
    expect(parsed.options.count).toBe(8);
    expect(parsed.sourceText).toContain("Bilkul, ye 20 questions");
    expect(parsed.sourceText).toContain("1. भारत का राष्ट्रीय पशु");
  });
});

const makePastedQuiz = (count: number): string => {
  const questions = Array.from({ length: count }, (_, index) => `
${index + 1}. Question number ${index + 1}?
A) Option A ${index + 1}
B) Option B ${index + 1}
C) Option C ${index + 1}
D) Option D ${index + 1}
✅ Correct answer: B) Option B ${index + 1}`);
  return `Ready-made MCQ Quiz\n${questions.join("\n")}`;
};

describe("pasted MCQ parsing", () => {
  it("converts Hindi MCQs and preserves their supplied answers", () => {
    const result = parsePastedQuiz(`20 MCQ Quiz

1. भारत का राष्ट्रीय पशु कौन-सा है?
A) सिंह
B) बाघ
C) हाथी
D) तेंदुआ
✅ सही उत्तर: B) बाघ

2. जल का रासायनिक सूत्र क्या है?
A) CO₂
B) H₂O
C) O₂
D) NaCl
✅ सही उत्तर: B) H₂O`, 50);

    expect(result.error).toBeUndefined();
    expect(result.quizSet?.title).toBe("20 MCQ Quiz");
    expect(result.quizSet?.quizzes).toHaveLength(2);
    expect(result.quizSet?.quizzes[0]).toMatchObject({
      question: "भारत का राष्ट्रीय पशु कौन-सा है?",
      options: ["सिंह", "बाघ", "हाथी", "तेंदुआ"],
      correctOption: 1,
      explanation: "सही उत्तर: बाघ",
    });
  });

  it("accepts all 50 complete questions in one message", () => {
    const result = parsePastedQuiz(makePastedQuiz(50), 50);
    expect(result.error).toBeUndefined();
    expect(result.quizSet?.quizzes).toHaveLength(50);
  });

  it("returns a clear error when a pasted quiz exceeds 50 questions", () => {
    const result = parsePastedQuiz(makePastedQuiz(51), 50);
    expect(result.quizSet).toBeUndefined();
    expect(result.error).toContain("maximum of 50");
    expect(result.error).toContain("contains 51");
  });

  it("uses the AI fallback for incomplete or invalid MCQ blocks", () => {
    const incomplete = parsePastedQuiz(
      "1. Incomplete question?\nA) One\nB) Two\nC) Three",
      50,
    );
    expect(incomplete.detectedCount).toBe(1);
    expect(incomplete.quizSet).toBeUndefined();
    expect(incomplete.error).toBeUndefined();

    expect(() =>
      parsePastedQuiz(
        "1. Invalid question?\nA) Same\nB) Same\nC) Three\nD) Four\nAnswer: A",
        50,
      ),
    ).not.toThrow();
  });


  it("detects every numbered question even when AI conversion is needed", () => {
    const questions = Array.from(
      { length: 20 },
      (_, index) => `${index + 1}. Source question ${index + 1}?`,
    ).join("\n");
    const result = parsePastedQuiz(questions, 50);

    expect(result.detectedCount).toBe(20);
    expect(result.quizSet).toBeUndefined();
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


  it("asks for every source question when automatic PDF counting is enabled", () => {
    const prompt = buildQuizPrompt({
      count: 8,
      difficulty: "mixed",
      language: "auto",
      autoCount: true,
      maxCount: 50,
    });
    expect(prompt).toContain("every distinct question");
    expect(prompt).toContain("up to 50");
    expect(prompt).toContain("fallback count of 8");
  });
});
