# QuizForge — Telegram Text/PDF to Quiz Bot

A production-ready Node.js Telegram bot that turns pasted text or uploaded PDFs into **native Telegram quiz polls**. Gemini creates grounded questions, four answer choices, the correct option, and a short explanation. The app runs as a long-lived, webhook-based web service (deploy to **Render**) and needs no database.

## What it does

- Accepts normal Telegram text messages and PDFs.
- Extracts embedded PDF text locally with `unpdf` and sends ordinary text to Gemini, so the selected model does **not** need native PDF-input support.
- Creates 1–50 native quiz polls in the original language, Hindi, English, Hinglish, or a requested language.
- Supports easy, medium, hard, and mixed difficulty.
- Uses Gemini structured JSON output, then validates every question against Telegram limits.
- Uses Telegram's current `InputPollOption` objects and `correct_option_id` quiz API.
- Returns the webhook response immediately and finishes generation in the background, reducing Telegram retries during long AI calls.
- Retries temporary Gemini failures and Telegram `429`/`5xx` responses.
- Verifies Telegram's secret webhook header.
- Lets each Telegram user privately add/change their own Gemini API key and select any generation model available to it.
- Keeps the bot owner’s key in environment variables and user keys only in process memory—never in client code or logs.

## Current stack (checked 16 August 2026)

- **Node.js 22.x** (LTS), the runtime used by the Render web service.
- **TypeScript 5.9.3**, compiled to `dist/` by the `build` script.
- **Gemini `gemini-2.5-flash`**, the current stable Flash model with a 1,048,576-token input window and structured JSON output. (Gemini 2.0 Flash-Lite was shut down on 1 June 2026, and 2.5 Flash-Lite was later removed for new API keys.)
- **`@google/genai`**, Google's current JavaScript SDK (not the deprecated `@google/generative-ai` package).
- **`unpdf`**, a serverless-friendly PDF.js wrapper used to extract embedded text before the Gemini request.
- **A persistent Node HTTP server** (`src/server.ts`) that exposes the `/webhook` endpoint and a small landing page.
- **Telegram Bot API** native quiz polls.

You can change `GEMINI_MODEL` at any time without changing code. Use `/model` in Telegram to list all models available to your API key.

Official references:

- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Gemini Flash model](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash)
- [`unpdf` PDF text extraction](https://www.npmjs.com/package/unpdf)
- [Telegram Bot API — sendPoll](https://core.telegram.org/bots/api#sendpoll)
- [Render Node.js runtime](https://render.com/docs/node-version)
- [Telegram webhooks](https://core.telegram.org/bots/api#setwebhook)

## Project structure

```text
src/server.ts                  Persistent HTTP server (Render entry point)
src/webhook-handler.ts         Shared webhook request handling (used by server + optional Vercel entry)
api/webhook.ts                 Optional Vercel serverless entry point
src/config.ts                  Validated environment configuration
src/gemini.ts                  Structured Gemini text generation
src/pdf.ts                     Safe local PDF-to-text extraction
src/handler.ts                 Commands and end-to-end update processing
src/model-menu.ts              Model picker: HTML command list + inline keyboard
src/quiz.ts                    Command parsing and Telegram-safe validation
src/telegram.ts                Telegram API client, file download, retries
scripts/telegram-webhook.mjs   Webhook setup/info/delete utility
public/index.html              Small deployment landing page
tests/quiz.test.ts             Parser and validation tests
tests/telegram.test.ts         Native quiz payload test
tests/webhook.test.ts          Health and webhook-auth tests
```

## 1. Create the keys

### Telegram bot token

1. Open [@BotFather](https://t.me/BotFather) in Telegram.
2. Send `/newbot` and follow the prompts.
3. Copy the token. It looks like `123456789:AA...`.

### Gemini API key

1. Open [Google AI Studio](https://aistudio.google.com/apikey).
2. Create an API key in a project that has Gemini API access.
3. Copy the key.

### Webhook secret

Generate a random secret locally:

```bash
openssl rand -hex 32
```

Telegram permits `A-Z`, `a-z`, `0-9`, `_`, and `-`; a hex secret is valid.

## 2. Deploy to Render

This project is a **web service** (a long-lived HTTP server), not a serverless function — so it needs **Build Command** and **Start Command** set. The included `render.yaml` and the `scripts` below configure it for you.

### Option A — Dashboard (recommended)

1. Put this folder in a GitHub repository.
2. In Render, choose **New → Web Service** and connect the repository.
3. In **Settings**, set:
   - **Runtime:** `Node`
   - **Build Command:** `npm ci && npm run build`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/webhook`
4. Add these environment variables (or pick **Deploy from Blueprint** and add the secrets in the dashboard):

| Variable | Required | Value |
|---|---:|---|
| `NODE_VERSION` | Yes | `22` |
| `TELEGRAM_BOT_TOKEN` | Yes | Token from BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Yes | Random secret generated above |
| `GEMINI_API_KEY` | Yes | Key from AI Studio |
| `GEMINI_MODEL` | No | Defaults to `gemini-2.5-flash` |
| `BOT_URL` | No | Defaults to `https://t.me/ForgeQuizBot`; shown on URL buttons in `/start`, `/help`, and the quiz-ready message |
| `DEFAULT_QUIZ_COUNT` | No | Defaults to `8` for study material; pre-written question sets are counted automatically |
| `MAX_QUIZ_COUNT` | No | Defaults to `50`, max `100` |
| `MAX_PDF_BYTES` | No | Defaults to `20000000` (Telegram's download ceiling) |
| `MAX_PDF_PAGES` | No | Defaults to `500`; limits untrusted PDF parser work |
| `MAX_PDF_TEXT_CHARACTERS` | No | Defaults to `500000`; bounds the text sent to Gemini |
| `POLL_DELAY_MS` | No | Defaults to `1000` to respect Telegram limits |

5. Deploy and copy the production URL, for example `https://quiz-forge.onrender.com`.

### Option B — Blueprint (`render.yaml`)

A `render.yaml` is included, so you can also use **New → Blueprint** and connect the repository. The build/start commands and `NODE_VERSION` are pre-filled; still add the three secrets (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `GEMINI_API_KEY`) in the Render dashboard.

### Local test before deploying

```bash
npm install
npm run dev
```

The server starts on `http://localhost:3000`; open `http://localhost:3000/webhook` to see the config status JSON.

## 3. Register the Telegram webhook

On your computer:

```bash
cp .env.example .env.local
```

Fill in at least `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`, then run:

```bash
npm install
npm run webhook:set -- https://YOUR-PROJECT.onrender.com
```

The script automatically appends `/webhook`, registers `message` and `callback_query` updates, adds the secret header, and installs the bot command menu. To discard old queued updates on first setup:

```bash
npm run webhook:set -- https://YOUR-PROJECT.onrender.com --drop
```

Check status:

```bash
npm run webhook:info
```

Delete the webhook if needed:

```bash
npm run webhook:delete
```

You can also open `https://YOUR-PROJECT.onrender.com/webhook` in a browser. A healthy setup returns JSON with `"ok": true`; it never reveals secret values.

## Usage

### Instant quiz

Send or paste ordinary study material. The bot creates 8 mixed questions in the source language.

If the source is already a numbered question/MCQ set, the bot automatically uses the detected question count instead of stopping at 8. A complete list with `A)`–`D)` options and a `Correct answer:` or `सही उत्तर:` line is preserved and sent directly. Uploaded PDF question sets are also converted in full. All automatic modes are capped at 50 polls; use an explicit `/quiz 10 ...` count when you want a fixed number.

Sentence-like source text may begin on the same line as `/quiz`, so numbers such as “20 questions” are not mistaken for command options.

### Custom text quiz

When using count, difficulty, or language controls, put the source on the next line:

```text
/quiz 10 hard Hindi
भारत का संविधान 26 नवंबर 1949 को अपनाया गया...
```

### Custom PDF quiz

Upload a PDF and use this as its Telegram caption:

```text
/quiz 12 medium Hinglish
```

Command syntax:

```text
/quiz [1-50] [easy|medium|hard|mixed] [language]
```

All parts are optional. Examples:

```text
/quiz 5 easy English
/quiz 12 hard Hindi
/quiz 8 mixed auto
```

Commands: `/start`, `/help`, `/quiz [1-100] [easy|medium|hard|mixed] [language]`, `/model`, `/apikey`.

### Personal Gemini key and model

In a **private chat** with the bot, send `/apikey YOUR_KEY`. The bot immediately tries to delete the secret-bearing message, validates the key, and uses that key only for that Telegram user. Send `/model` to load every Gemini model available to the active key. Send `/apikey reset` to return to the bot owner’s default key and model.

The model picker's buttons are **URL buttons** carrying a `?start=` deep link to the bot (`https://t.me/YourBot?start=use_7`). URL buttons are the only kind that let you **long-press** a button to copy/open its link. Tapping one opens the bot with a Start button that sends the payload as `/start use_7`; the `/start` handler routes it through the exact same parser as a typed `/use_7`, so a tap and a typed command behave identically. `use_N` payloads select a model (1-based over the whole catalogue), and `model_N` payloads page the list.

Typed commands still work too — `/use_7`, `/model_2`, and `/model` remain backend routes — and they arrive as ordinary `message` updates, so they keep working even if `callback_query` updates aren't reaching the bot. Buttons from older callback-based deployments (`m:<token>`, `model:<index>`, `/use_N`) are still accepted so keyboards already sitting in chats keep working after a redeploy.

Personal settings are deliberately held only in process memory: they are not written to disk or logs, and reset when the service restarts or redeploys. Telegram may retain messages if deletion fails, so use only a private chat and revoke a key in Google AI Studio if it was exposed.

## Group usage

With BotFather privacy mode enabled, a group bot generally receives commands, replies, and mentions—not every ordinary message. Either:

- use `/quiz ...` in the group,
- reply to/mention the bot, or
- use `/setprivacy` in BotFather if you intentionally want the bot to receive normal group text.

Only disable privacy when group members understand that messages become visible to the bot.

## Local checks

```bash
npm install
npm run check
```

`npm run check` runs strict TypeScript checking and the Vitest suite. For local webhook development:

```bash
npm run dev
```

Telegram requires a public HTTPS webhook, so use a secure tunnel only for local testing. Production should point directly to the Render URL.

## Limits and privacy

- **PDF processing:** PDFs are parsed inside the bot with `unpdf`; only extracted plain text is sent to Gemini. This removes the requirement for the chosen model to accept `application/pdf` input.
- **PDF limits:** Telegram downloads are capped at 20 MB. Parsing defaults to at most 500 pages and 500,000 extracted characters; both parser limits are configurable.
- **PDF type:** Password-protected, corrupted, and fake `.pdf` files are rejected. Scanned/image-only PDFs have no embedded text, so they must be made searchable with OCR before upload.
- **Quiz count:** Minimum 1 and capped at 100. Polls are paced to stay within Telegram's per-chat messaging limits.
- **Rate limits:** “Free” does not mean unlimited. Gemini and Render apply free-tier quotas. Telegram also recommends no more than roughly one message per second in one chat, which is why poll sending is paced.
- **Data handling:** The app does not store user content in a database. It downloads each PDF into memory, extracts its text locally, sends that extracted text to Gemini, sends polls to Telegram, and then releases the parser resources. Google states on its pricing page that free-tier content may be used to improve its products. Do not send sensitive documents unless that policy is acceptable.
- **Reliability:** The server acknowledges the webhook and finishes quiz generation in the background. If a provider is unavailable, the user receives an error where possible; no durable job queue is included.

## Troubleshooting

### Bot does not answer

1. Open `/webhook` and confirm all three `configured` values are `true`.
2. Run `npm run webhook:info`.
3. Check `last_error_message` and `pending_update_count`.
4. Confirm the variables were added in Render (dashboard → your service → **Environment**), then redeploy.

### Model buttons do nothing when tapped

The model-menu buttons are URL buttons (`?start=` deep links), so a tap is handled by the Telegram client itself: it opens the bot and, after you press Start, sends `/start use_N`. If the model still doesn't change after that, the bot isn't receiving message updates:

1. Open `/webhook` and confirm all three `configured` values are `true`.
2. Run `npm run webhook:info` and check `last_error_message` and `pending_update_count`.
3. Re-register the webhook: `npm run webhook:set -- https://your-service.onrender.com`.

Buttons from older deployments were callback buttons, which need `callback_query` in `allowed_updates`; `webhook:set` always registers `["message", "callback_query"]`, so those keep working too. Also check the service logs for `Callback query ... failed`. Every callback is answered even on an unknown or stale button, so a button should never leave a spinner hanging.

### Render build fails

The app needs Node 22 and the compiled output. Confirm:
- `NODE_VERSION` is set to `22`.
- **Build Command** is `npm ci && npm run build`.
- **Start Command** is `npm start`.
- Both `package.json` and `package-lock.json` are committed so `npm ci` works.

### `401 Unauthorized` at the webhook

The value used by `npm run webhook:set` must exactly equal the deployed `TELEGRAM_WEBHOOK_SECRET`. Set it again after correcting `.env.local`.

### Gemini quota error

Wait for the free quota window to reset, use another eligible project/key, or enable billing. Active limits are shown in Google AI Studio and can vary by project.

### Model not found

Model availability can change. Check the current model list and free-tier eligibility in Google AI Studio, set `GEMINI_MODEL` to a supported model ID, and redeploy. Avoid copying retired preview-model IDs from older guides.

### Polls arrive slowly

The one-second pacing is deliberate. Lower `POLL_DELAY_MS` only if you understand Telegram's flood limits; `429` responses are retried automatically.

## Security checklist

- Never commit `.env.local`.
- Rotate any key that was pasted into public code, logs, screenshots, or shell history.
- Keep the webhook secret long and random.
- Leave the secret-header check enabled.
- Review Render logs without printing entire webhook payloads or documents.
- Restrict or rotate the Gemini key from its Google project if abuse is suspected.

## License

Use and modify this project for your own bot. Add the license of your choice before public distribution.
