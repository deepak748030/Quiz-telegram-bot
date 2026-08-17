#!/usr/bin/env node
import { config as loadEnv } from "dotenv";

loadEnv({ path: [".env.local", ".env"], quiet: true });

const [, , action = "info", ...args] = process.argv;
const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();

if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN in the environment or .env.local.");
  process.exit(1);
}

const api = async (method, payload = {}) => {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.description || `${method} failed with HTTP ${response.status}`);
  }
  return data.result;
};

const webhookUrl = () => {
  const raw = args.find((argument) => !argument.startsWith("--")) || process.env.WEBHOOK_URL;
  if (!raw) {
    throw new Error(
      "Pass your deployed URL: npm run webhook:set -- https://your-service.onrender.com",
    );
  }
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("The webhook URL must use HTTPS.");
  if (!url.pathname || url.pathname === "/") url.pathname = "/webhook";
  return url.toString().replace(/\/$/, "");
};

try {
  if (action === "set") {
    if (!secret) {
      throw new Error("Missing TELEGRAM_WEBHOOK_SECRET in the environment or .env.local.");
    }
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
      throw new Error(
        "TELEGRAM_WEBHOOK_SECRET must be 1-256 characters using only A-Z, a-z, 0-9, _ and -.",
      );
    }

    const url = webhookUrl();
    await api("setWebhook", {
      url,
      secret_token: secret,
      allowed_updates: ["message", "callback_query"],
      max_connections: 40,
      drop_pending_updates: args.includes("--drop"),
    });
    await api("setMyCommands", {
      commands: [
        { command: "start", description: "Start the quiz bot" },
        { command: "quiz", description: "Create a custom quiz" },
        { command: "help", description: "Show examples and limits" },
        { command: "model", description: "Choose your Gemini AI model" },
        { command: "apikey", description: "Add or change your Gemini API key" },
      ],
    });
    // The bot's own webhook filter is set above, but a *group* bot with
    // BotFather privacy mode ON only receives commands addressed to it. The
    // model menu's /use_N commands are ordinary commands, so they arrive
    // fine; this note just makes the requirement explicit for operators.
    console.log("✓ Inline buttons and /use_N commands enabled (callback_query allowed)");
    console.log(`✓ Webhook set to ${url}`);
    console.log("✓ Bot commands updated");
  } else if (action === "info") {
    const info = await api("getWebhookInfo");
    console.log(JSON.stringify(info, null, 2));

    // `allowed_updates` is a *filter*: a webhook registered without
    // "callback_query" makes Telegram drop every inline-button tap before it
    // ever reaches the bot, so the buttons look completely dead while normal
    // messages keep working. Surface that instead of leaving it to guesswork.
    const allowed = info.allowed_updates;
    if (Array.isArray(allowed) && !allowed.includes("callback_query")) {
      console.warn(
        "\n⚠ This webhook does NOT receive callback_query updates, so inline buttons cannot work.\n" +
          `  Currently allowed: ${allowed.join(", ") || "(none)"}\n` +
          "  Fix it with: npm run webhook:set -- https://your-service.onrender.com",
      );
    }
    if (!info.url) {
      console.warn("\n⚠ No webhook URL is set. The bot is not receiving any updates.");
    }
    if (info.last_error_message) {
      console.warn(
        `\n⚠ Telegram's last delivery attempt failed: ${info.last_error_message}`,
      );
    }
  } else if (action === "delete") {
    await api("deleteWebhook", {
      drop_pending_updates: args.includes("--drop"),
    });
    console.log("✓ Webhook deleted");
  } else {
    throw new Error("Unknown action. Use set, info, or delete.");
  }
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
