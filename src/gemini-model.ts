// Current, broadly-available Gemini model used whenever a deployment does not
// pin a specific GEMINI_MODEL.
//
// History of why this is not "gemini-2.5-flash-lite":
//   - Gemini 2.0 Flash / Flash-Lite were shut down by Google on 1 June 2026.
//   - Gemini 2.5 Flash-Lite was later removed for newly created API keys
//     (HTTP 404 NOT_FOUND: "This model ... is no longer available to new
//     users"), so it can no longer be the default for fresh deployments.
// gemini-2.5-flash is a stable model that supports generateContent with
// structured JSON output and is available to both new and existing keys.
export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

// Models that Google has retired and that must be silently migrated to the
// default instead of failing every text/PDF request:
//   - gemini-2.0-flash / gemini-2.0-flash-lite  (shut down 1 June 2026)
//   - gemini-2.5-flash-lite                      (removed for new API keys)
const RETIRED_MODEL_PATTERN =
  /^(?:gemini-2\.0-flash(?:-lite)?|gemini-2\.5-flash-lite)(?:-001)?$/i;

/**
 * Maps a configured model name to a currently-supported model. Retired models
 * are migrated to {@link DEFAULT_GEMINI_MODEL}; any other name is passed
 * through unchanged so callers can still pin a specific model.
 */
export const resolveGeminiModel = (model: string): string =>
  RETIRED_MODEL_PATTERN.test(model.trim()) ? DEFAULT_GEMINI_MODEL : model;
