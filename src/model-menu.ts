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
 * Renders the model picker.
 *
 * Every model is offered twice, on purpose:
 *
 *  1. As a tappable `/use_N` bot command inside the HTML message body.
 *     Telegram turns any `/token` in message text into a `bot_command` entity
 *     that is tappable in every client, and tapping it sends an ordinary
 *     message. That path only needs `message` updates, so it keeps working
 *     even when the deployment's webhook was registered without
 *     `callback_query` in `allowed_updates` — the usual reason inline buttons
 *     appear completely dead.
 *  2. As an inline keyboard button, which stays the nicer one-tap experience
 *     when callback updates are delivered normally.
 *
 * Both routes resolve to the same handler, so the menu behaves identically
 * whichever one the user reaches for.
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

  const rows = visible.map((model) => [
    {
      text: `${model === selectedModel ? "✅ " : ""}${model}`,
      callback_data: `m:${modelToken(model)}`,
    },
  ]);

  const navigation: { text: string; callback_data: string }[] = [];
  if (page > 0) navigation.push({ text: "⬅️ Previous", callback_data: `p:${page - 1}` });
  if (page + 1 < pageCount) navigation.push({ text: "Next ➡️", callback_data: `p:${page + 1}` });
  if (navigation.length > 0) rows.push(navigation);

  // `/use_N` is 1-based and indexes the whole catalogue, not the page, so a
  // command stays valid after the user pages around.
  const lines = visible.map((model, offset) => {
    const number = start + offset + 1;
    return model === selectedModel
      ? `✅ /use_${number} — <b>${escapeHtml(model)}</b> (current)`
      : `▫️ /use_${number} — <b>${escapeHtml(model)}</b>`;
  });

  const navigationLines: string[] = [];
  // Pages are 1-based in the command so "/model_2" really is page 2.
  if (page > 0) navigationLines.push(`⬅️ Previous page: /model_${page}`);
  if (page + 1 < pageCount) navigationLines.push(`➡️ Next page: /model_${page + 2}`);

  const text = [
    "<b>🤖 Choose your Gemini model</b>",
    "",
    `Current: <code>${escapeHtml(selectedModel)}</code>`,
    `${models.length} model${models.length === 1 ? "" : "s"} available · Page ${page + 1}/${pageCount}`,
    "",
    "<b>Tap a command to switch model:</b>",
    ...lines,
    ...(navigationLines.length > 0 ? ["", ...navigationLines] : []),
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
 * Buttons rendered by older deployments (`model:<index>` / `models:<page>`)
 * are still accepted so keyboards already sitting in users' chats keep
 * working after a redeploy instead of going dead.
 */
export const parseModelCallback = (
  data: string | undefined,
  models: string[],
): ModelAction => {
  if (!data) return { kind: "unknown" };

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
