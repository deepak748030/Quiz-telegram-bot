import { beforeEach, describe, expect, it, vi } from "vitest";

const { extractTextMock, getDocumentProxyMock, destroyMock } = vi.hoisted(() => ({
  extractTextMock: vi.fn(),
  getDocumentProxyMock: vi.fn(),
  destroyMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("unpdf", () => ({
  extractText: (...args: unknown[]) => extractTextMock(...args),
  getDocumentProxy: (...args: unknown[]) => getDocumentProxyMock(...args),
}));

const { extractPdfText, PdfExtractionError } = await import("../src/pdf.js");

const options = { maxPages: 10, maxCharacters: 1_000 };

beforeEach(() => {
  vi.clearAllMocks();
  destroyMock.mockResolvedValue(undefined);
  getDocumentProxyMock.mockResolvedValue({ numPages: 2, loadingTask: { destroy: destroyMock } });
  extractTextMock.mockResolvedValue({
    totalPages: 2,
    text: [" First   page text.\n\n\nMore text. ", "Second page text."],
  });
});

describe("extractPdfText", () => {
  it("extracts and normalizes page-labelled text and releases PDF resources", async () => {
    const source = new TextEncoder().encode("%PDF-1.7 test");

    const result = await extractPdfText(source, options);

    expect(result).toEqual({
      totalPages: 2,
      text: "[Page 1]\nFirst page text.\n\nMore text.\n\n[Page 2]\nSecond page text.",
    });
    expect(getDocumentProxyMock).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.objectContaining({
        maxImageSize: 16_777_216,
      }),
    );
    expect(extractTextMock).toHaveBeenCalledWith(
      expect.objectContaining({ numPages: 2 }),
      { mergePages: false },
    );
    expect(destroyMock).toHaveBeenCalledOnce();
  });

  it("rejects scanned/image-only PDFs with an OCR-specific message", async () => {
    extractTextMock.mockResolvedValue({ totalPages: 2, text: [" ", "123"] });

    await expect(
      extractPdfText(new Uint8Array([1, 2, 3]), options),
    ).rejects.toMatchObject({
      name: "PdfExtractionError",
      code: "NO_TEXT",
      message: expect.stringContaining("OCR"),
    });
    expect(destroyMock).toHaveBeenCalledOnce();
  });

  it("rejects excessive page counts before extracting all pages", async () => {
    getDocumentProxyMock.mockResolvedValue({ numPages: 11, loadingTask: { destroy: destroyMock } });

    await expect(
      extractPdfText(new Uint8Array([1]), options),
    ).rejects.toMatchObject({ code: "TOO_MANY_PAGES" });
    expect(extractTextMock).not.toHaveBeenCalled();
    expect(destroyMock).toHaveBeenCalledOnce();
  });

  it("rejects extracted text over the configured AI-input limit", async () => {
    extractTextMock.mockResolvedValue({
      totalPages: 1,
      text: ["A".repeat(1_001)],
    });

    await expect(
      extractPdfText(new Uint8Array([1]), options),
    ).rejects.toMatchObject({ code: "TOO_MUCH_TEXT" });
  });

  it("turns parser failures into a safe password-protected PDF error", async () => {
    getDocumentProxyMock.mockRejectedValue(new Error("PasswordException: password required"));

    const promise = extractPdfText(new Uint8Array([1]), options);
    await expect(promise).rejects.toBeInstanceOf(PdfExtractionError);
    await expect(promise).rejects.toMatchObject({
      code: "INVALID_PDF",
      message: expect.stringContaining("password-protected"),
    });
  });
});
