import { afterEach, describe, expect, it, vi } from "vitest";

import { listGeminiModels } from "../src/gemini.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listGeminiModels", () => {
  it("lists all paginated Gemini models that support content generation", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        models: [
          { name: "models/gemini-flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
        ],
        nextPageToken: "next-page",
      }))
      .mockResolvedValueOnce(Response.json({
        models: [
          { name: "models/gemini-pro", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-flash", supportedGenerationMethods: ["generateContent"] },
        ],
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listGeminiModels("personal-secret-key")).resolves.toEqual([
      "gemini-flash",
      "gemini-pro",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { "x-goog-api-key": "personal-secret-key" },
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("personal-secret-key");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("pageToken=next-page");
  });

  it("rejects an invalid API key response without exposing the key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      Response.json({ error: { message: "API key not valid" } }, { status: 400 }),
    ));

    await expect(listGeminiModels("secret-value-never-in-error")).rejects.toThrow(
      "API key not valid",
    );
  });
});
