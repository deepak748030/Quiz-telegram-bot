# QuizForge — Telegram Text/PDF to Quiz Bot

A production-ready Node.js Telegram bot that turns pasted text or uploaded PDFs into **native Telegram quiz polls**. Gemini creates grounded questions, four answer choices, the correct option, and a short explanation. The app runs as a webhook-based Vercel Function and needs no database.

## What it does

- Accepts normal Telegram text messages and PDFs.
- Creates 3–15 native quiz polls in the original language, Hindi, English, Hinglish, or a requested language.
- Supports easy, medium, hard, and mixed difficulty.
- Uses Gemini structured JSON output, then validates every question against Telegram limits.
- Uses Telegram's current `InputPollOption` objects and `correct_option_ids` quiz API.
- Returns the webhook response immediately and finishes generation with Vercel `waitUntil`, reducing Telegram retries during long AI calls.
- Retries temporary Gemini failures and Telegram `429`/`5xx` responses.
- Verifies Telegram's secret webhook header.
- Keeps API keys in Vercel environment variables—never in client code.

## Current stack (checked 16 August 2026)

- **Node.js 24.x**, the latest LTS and Vercel default.
- **TypeScript 5.9.3**, pinned for compatibility with Vercel's current function builder.
- **Gemini `gemini-3.5-flash-lite`**, the latest stable Gemini Flash-Lite model with free-tier input and output. It supports PDF input, a 1,048,576-token input window, and structured output.
- **`@google/genai`**, Google's current JavaScript SDK (not the deprecated `@google/generative-ai` package).
- **Vercel Functions** with up to 300 seconds configured for Hobby deployments.
- **Telegram Bot API** native quiz polls.

Gemini 3.7 Flash is newer and more capable overall, but its API does **not** currently have a free tier. This project therefore defaults to 3.5 Flash-Lite. You can change `GEMINI_MODEL` at any time without changing code.

Official references:

- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Gemini 3.5 Flash-Lite model](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite)
- [Gemini PDF understanding](https://ai.google.dev/gemini-api/docs/document-processing)
- [Telegram Bot API — sendPoll](https://core.telegram.org/bots/api#sendpoll)
- [Vercel Node.js versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)
- [Vercel `waitUntil`](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package#waituntil)

## Project structure

```text
api/webhook.ts                 Vercel webhook entry point
src/config.ts                  Validated environment configuration
src/gemini.ts                  Structured Gemini text/PDF generation
src/handler.ts                 Commands and end-to-end update processing
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

## 2. Deploy to Vercel Hobby

### Dashboard method

1. Put this folder in a GitHub repository.
2. In Vercel, choose **Add New → Project** and import the repository.
3. Keep Framework Preset as **Other**. No build command is required.
4. Add these Production environment variables:

| Variable | Required | Value |
|---|---:|---|
| `TELEGRAM_BOT_TOKEN` | Yes | Token from BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Yes | Random secret generated above |
| `GEMINI_API_KEY` | Yes | Key from AI Studio |
| `GEMINI_MODEL` | No | Defaults to `gemini-3.5-flash-lite` |
| `DEFAULT_QUIZ_COUNT` | No | Defaults to `8` |
| `MAX_QUIZ_COUNT` | No | Defaults/maxes at `15` |
| `MAX_PDF_BYTES` | No | Defaults to `20000000` |
| `POLL_DELAY_MS` | No | Defaults to `1000` to respect Telegram limits |

5. Deploy and copy the production URL, for example `https://quiz-forge.vercel.app`.

The included `vercel.json` runs the function in Mumbai (`bom1`), uses 2 GB memory, and permits a 300-second invocation. You can change the region if most users are elsewhere.

### CLI method

```bash
npm install
npx vercel
npx vercel --prod
```

Add secrets through the Vercel dashboard or `vercel env add`; do not commit `.env.local`.

## 3. Register the Telegram webhook

On your computer:

```bash
cp .env.example .env.local
```

Fill in at least `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`, then run:

```bash
npm install
npm run webhook:set -- https://YOUR-PROJECT.vercel.app
```

The script automatically appends `/api/webhook`, registers only `message` updates, adds the secret header, and installs the bot command menu. To discard old queued updates on first setup:

```bash
npm run webhook:set -- https://YOUR-PROJECT.vercel.app --drop
```

Check status:

```bash
npm run webhook:info
```

Delete the webhook if needed:

```bash
npm run webhook:delete
```

You can also open `https://YOUR-PROJECT.vercel.app/api/webhook` in a browser. A healthy setup returns JSON with `"ok": true`; it never reveals secret values.

## Usage

### Instant quiz

Send or paste ordinary source text. The bot creates 8 mixed questions in the source language.

### Custom text quiz

The source must begin on the next line:

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
/quiz [3-15] [easy|medium|hard|mixed] [language]
```

All parts are optional. Examples:

```text
/quiz 5 easy English
/quiz 12 hard Hindi
/quiz 8 mixed auto
```

Commands: `/start`, `/help`, `/quiz`, `/model`.

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

Telegram requires a public HTTPS webhook, so use a secure tunnel only for local testing. Production should point directly to the Vercel URL.

## Limits and privacy

- **PDF size:** Telegram's hosted Bot API allows bots to download files up to 20 MB. Gemini itself can accept larger PDFs, but Telegram is the bottleneck here.
- **PDF type:** Password-protected, corrupted, or fake `.pdf` files are rejected or may fail processing.
- **Quiz count:** Capped at 15 so a complete quiz remains within Telegram's per-chat messaging limits and Vercel's function duration.
- **Rate limits:** “Free” does not mean unlimited. Gemini and Vercel apply free-tier quotas. Telegram also recommends no more than roughly one message per second in one chat, which is why poll sending is paced.
- **Data handling:** The app does not store user content in a database. It downloads each PDF into function memory, sends the source to Gemini, sends polls to Telegram, and then the function ends. Google states on its pricing page that free-tier content may be used to improve its products. Do not send sensitive documents unless that policy is acceptable.
- **Reliability:** `waitUntil` lets Vercel continue after acknowledging the webhook. If the platform forcibly terminates an invocation or a provider is unavailable, the user receives an error where possible; no durable job queue is included.

## Troubleshooting

### Bot does not answer

1. Open `/api/webhook` and confirm all three `configured` values are `true`.
2. Run `npm run webhook:info`.
3. Check `last_error_message` and `pending_update_count`.
4. Confirm the Vercel variables were added to **Production**, then redeploy.

### Vercel build fails while loading TypeScript

This repository pins TypeScript 5.9.3 because newer compiler majors may not yet be compatible with Vercel's function builder. Confirm `package.json` and `package-lock.json` are both uploaded, then redeploy without the build cache. A successful install log should say `Using TypeScript 5.9.3 (local user-provided)`.

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
- Review Vercel logs without printing entire webhook payloads or documents.
- Restrict or rotate the Gemini key from its Google project if abuse is suspected.

## License

Use and modify this project for your own bot. Add the license of your choice before public distribution.
