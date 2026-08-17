import { createHash } from "node:crypto";

import type { TelegramInlineKeyboardMarkup } from "./types.js";

/** Models listed per page in both the HTML command list and the keyboard. */
export const MODEL_PAGE_SIZE = 10;

export const escapeHtml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * Short, stable identifier for a model name.
 *
 * Inline buttons used to carry the model's *position* in the catalogue
 * (`model:7`). That position is not stable: the catalogue is rebuilt from the
 * Gemini API on every cold start, and Google adds/removes models over time, so
 * a button left on screen could silently select a different model — or point
 * past the end of a shorter list, which is what made taps look like they did
 * nothing. A content hash keeps a button bound to the model it was rendered
 * for, no matter how the catalogue shifts underneath it.
 *
 * 10 base64url characters of SHA-1 keep `m:<token>` at 12 bytes, far inside
 * Telegram's 64-byte `callback_data` limit.
 */
export const modelToken = (model: string): string =>
  createHash("sha1").update(model).digest("base64url").slice(0, 10);

export interface ModelMenu {
  text: string;
  markup: TelegramInlineKeyboardMarkup;
  /** Page actually rendered after clamping the requested page. */
  page: number;
  pageCount: number;
}

export const pageCountFor = (modelCount: number): number =>
  Math.max(1, Math.ceil(modelCount / MODEL_PAGE_SIZE));

const clampPage = (requestedPage: number, pageCount: number): number =>
  Math.min(Math.max(0, Number.isFinite(requestedPage) ? requestedPage : 0), pageCount - 1);

/**
 * Renders the model picker: a short HTML header plus a fully button-based
 * inline keyboard (`InlineKeyboardMarkup` / `InlineKeyboardButton`).
 *
 * The keyboard is the entire selection UI, on every page:
 *
 *  - One button per model. The visible label and the sent payload are
 *    deliberately different things: the user reads "gemini-3.6-flash", the
 *    tap sends "/use_21" as `callback_data`. The callback handler feeds that
 *    command through `parseModelCommand` — the identical parser the typed
 *    command uses — so a button tap executes precisely the same,
 *    already-working command path as manually sending `/use_N`. No separate
 *    button-only switching mechanism exists.
 *  - "⬅️ Previous page" / "➡️ Next page" buttons whose `callback_data` is
 *    the existing `/model_N` page command, reusing the same pagination
 *    logic as typing it.
 *
 * The message body intentionally contains NO `/use_N` or `/model_N` command
 * text. Those commands still exist as backend routes — typing `/use_21`
 * manually keeps working — they are just no longer part of the visible UI.
 *
 * A `ReplyKeyboardMarkup` could not do this: by Bot API design a
 * reply-keyboard tap sends the button's visible text verbatim, so a button
 * labelled "gemini-3.6-flash" would send "gemini-3.6-flash" — not "/use_21".
 * Inline `callback_data` is Telegram's native mechanism for a label that
 * differs from the payload, which is why the menu uses it.
 */
export const buildModelMenu = (
  models: string[],
  selectedModel: string,
  requestedPage: number,
): ModelMenu => {
  const pageCount = pageCountFor(models.length);
  const page = clampPage(requestedPage, pageCount);
  const start = page * MODEL_PAGE_SIZE;
  const visible = models.slice(start, start + MODEL_PAGE_SIZE);

  // Visible label = the model's name; sent payload = the working `/use_N`
  // command. The user never sees "/use_21" on a button — they see
  // "gemini-3.6-flash" — but tapping it dispatches "/use_21" through the
  // exact same handler as typing it. `N` is 1-based over the whole catalogue
  // (not the page), exactly like the typed command.
  const rows = visible.map((model, offset) => {
    const command = `/use_${start + offset + 1}`;
    return [
      {
        text: `${model === selectedModel ? "✅ " : ""}${model}`,
        callback_data: command,
      },
    ];
  });

  // Pagination is button-based too: friendly "Previous/Next page" labels
  // carrying the working `/model_N` page commands (1-based) as their
  // `callback_data`, routed through the existing pagination logic.
  const navigation: { text: string; callback_data: string }[] = [];
  if (page > 0) {
    navigation.push({ text: "⬅️ Previous page", callback_data: `/model_${page}` });
  }
  if (page + 1 < pageCount) {
    navigation.push({ text: "➡️ Next page", callback_data: `/model_${page + 2}` });
  }
  if (navigation.length > 0) rows.push(navigation);

  // The message body is deliberately minimal: no model list, no `/use_N`
  // lines, no `/model_N` navigation text. The inline keyboard below it IS
  // the entire selection UI. Typed `/use_N` and `/model_N` remain working
  // backend command routes, just no longer advertised here.
  const text = [
    "<b>🤖 Choose your Gemini model</b>",
    "",
    `Current: <code>${escapeHtml(selectedModel)}</code>`,
    `${models.length} model${models.length === 1 ? "" : "s"} available · Page ${page + 1}/${pageCount}`,
    "",
    "<b>Tap a model to switch:</b>",
  ].join("\n");

  return { text, markup: { inline_keyboard: rows }, page, pageCount };
};

export type ModelAction =
  | { kind: "select"; model: string }
  | { kind: "page"; page: number }
  | { kind: "unknown" };

/**
 * Resolves `callback_data` from a tapped inline button.
 *
 * Current buttons carry the literal `/use_N` / `/model_N` command, which is
 * handed to `parseModelCommand` — the exact parser used when the user types
 * the command — so a button tap and a typed command run the same logic.
 *
 * Buttons rendered by older deployments (`m:<token>`, `p:<page>`,
 * `model:<index>`, `models:<page>`) are still accepted so keyboards already
 * sitting in users' chats keep working after a redeploy instead of going
 * dead.
 */
export const parseModelCallback = (
  data: string | undefined,
  models: string[],
): ModelAction => {
  if (!data) return { kind: "unknown" };

  // Command-shaped buttons: reuse the typed-command parser verbatim.
  if (data.startsWith("/")) return parseModelCommand(data, models);

  // Bare command payloads ("use_21", "model_2") route through the exact
  // same parser — one source of truth for what a command means.
  if (/^(?:use|models?)_\d+$/.test(data)) return parseModelCommand(`/${data}`, models);

  const tokenMatch = data.match(/^m:([A-Za-z0-9_-]+)$/);
  if (tokenMatch) {
    const token = tokenMatch[1]!;
    const model = models.find((candidate) => modelToken(candidate) === token);
    return model ? { kind: "select", model } : { kind: "unknown" };
  }

  const pageMatch = data.match(/^p:(\d+)$/);
  if (pageMatch) return { kind: "page", page: Number(pageMatch[1]) };

  // Legacy, index-based buttons.
  const legacyModel = data.match(/^model:(\d+)$/);
  if (legacyModel) {
    const model = models[Number(legacyModel[1])];
    return model ? { kind: "select", model } : { kind: "unknown" };
  }

  const legacyPage = data.match(/^models:(\d+)$/);
  if (legacyPage) return { kind: "page", page: Number(legacyPage[1]) };

  return { kind: "unknown" };
};

/**
 * Resolves a tapped `/use_N` or `/model_N` command from the HTML menu.
 * `N` is 1-based in both cases.
 */
export const parseModelCommand = (
  command: string,
  models: string[],
): ModelAction => {
  const useMatch = command.match(/^\/use_(\d+)$/);
  if (useMatch) {
    const model = models[Number(useMatch[1]) - 1];
    return model ? { kind: "select", model } : { kind: "unknown" };
  }

  const pageMatch = command.match(/^\/model(?:s)?_(\d+)$/);
  if (pageMatch) return { kind: "page", page: Math.max(0, Number(pageMatch[1]) - 1) };

  return { kind: "unknown" };
};

/** True for every command the model picker owns. */
export const isModelMenuCommand = (command: string): boolean =>
  /^\/(?:models?|models?_\d+|use_\d+)$/.test(command);

/** Page a model lives on, used to re-render the menu around a selection. */
export const pageOfModel = (models: string[], model: string): number => {
  const index = models.indexOf(model);
  return index < 0 ? 0 : Math.floor(index / MODEL_PAGE_SIZE);
};
