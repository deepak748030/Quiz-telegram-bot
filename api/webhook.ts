import { waitUntil } from "@vercel/functions";

import { createWebhookHandler } from "../src/webhook-handler.js";

export default {
  fetch: createWebhookHandler({ waitUntil }),
};
