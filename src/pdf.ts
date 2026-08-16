import { extractText, getDocumentProxy } from "unpdf";

const MIN_USEFUL_TEXT_CHARACTERS = 20;
const MAX_IMAGE_PIXELS = 16_777_216;

export type PdfExtractionErrorCode =
  | "NO_TEXT"
  | "TOO_MANY_PAGES"
  | "TOO_MUCH_TEXT"
  | "INVALID_PDF";

export class PdfExtractionError extends Error {
  readonly code: PdfExtractionErrorCode;

  constructor(code: PdfExtractionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PdfExtractionError";
    this.code = code;
  }
}

export interface PdfTextExtractionOptions {
  maxPages: number;
  maxCharacters: number;
}

export interface ExtractedPdfText {
  text: string;
  totalPages: number;
}

const normalizeText = (text: string): string =>
  text
    .replaceAll("\u0000", "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const usefulCharacterCount = (text: string): number =>
  Array.from(text.replace(/\s/g, "")).length;

const parserMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes("password")) {
    return "This PDF is password-protected. Remove the password and upload it again.";
  }
  return "The PDF is corrupted or could not be read. Export it as a new PDF and try again.";
};

/**
 * Extracts a PDF's embedded text locally before any AI request is made.
 * Gemini consequently receives ordinary text, so quiz creation does not rely
 * on the selected model supporting application/pdf input.
 */
export const extractPdfText = async (
  data: Uint8Array,
  options: PdfTextExtractionOptions,
): Promise<ExtractedPdfText> => {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;

  try {
    // Copy the Telegram buffer because PDF.js may transfer/detach its input.
    pdf = await getDocumentProxy(Uint8Array.from(data), {
      maxImageSize: MAX_IMAGE_PIXELS,
    });

    if (pdf.numPages > options.maxPages) {
      throw new PdfExtractionError(
        "TOO_MANY_PAGES",
        `This PDF has ${pdf.numPages} pages; the maximum is ${options.maxPages}. Split it into smaller PDFs and try again.`,
      );
    }

    const result = await extractText(pdf, { mergePages: false });
    const pages = result.text.map((page, index) => {
      const text = normalizeText(page);
      return text ? `[Page ${index + 1}]\n${text}` : "";
    });
    const text = pages.filter(Boolean).join("\n\n");

    if (usefulCharacterCount(text) < MIN_USEFUL_TEXT_CHARACTERS) {
      throw new PdfExtractionError(
        "NO_TEXT",
        "No readable text was found in this PDF. It may be scanned or image-only; run OCR on it first, then upload the searchable PDF.",
      );
    }

    if (text.length > options.maxCharacters) {
      throw new PdfExtractionError(
        "TOO_MUCH_TEXT",
        `This PDF contains too much text (${text.length.toLocaleString("en-US")} characters; maximum ${options.maxCharacters.toLocaleString("en-US")}). Split it into smaller PDFs and try again.`,
      );
    }

    return { text, totalPages: result.totalPages };
  } catch (error) {
    if (error instanceof PdfExtractionError) throw error;
    throw new PdfExtractionError("INVALID_PDF", parserMessage(error), {
      cause: error,
    });
  } finally {
    await pdf?.loadingTask.destroy().catch(() => undefined);
  }
};
