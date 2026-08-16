import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { config as loadEnv } from "dotenv";

import { createWebhookHandler } from "./webhook-handler.js";

// Load local overrides (.env.local) before anything else; environment variables
// already set (e.g. by Render) always win.
loadEnv({ path: [".env.local", ".env"], quiet: true });

const PORT = Number(process.env.PORT || 3000);

const handle = createWebhookHandler({
  // Render runs a long-lived process, so the background quiz task can simply
  // run to completion in the background.
  waitUntil: (task) => {
    task.catch((error) => {
      console.error("Background webhook task failed:", error);
    });
  },
});

// public/ sits at the repo root. In dev the server runs from src/ (one level
// down); after `npm run build` it runs from dist/src/ (two levels down).
const isBuilt = import.meta.url.includes("/dist/");
const landingPageUrl = new URL(
  isBuilt ? "../../public/index.html" : "../public/index.html",
  import.meta.url,
);

const notFound = (): Response =>
  new Response("Not Found", { status: 404 });

/** Convert a node:http IncomingMessage into a fetch Request. */
const toFetchRequest = async (
  req: IncomingMessage,
  fullUrl: string,
): Promise<Request> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
    else headers.set(name, value);
  }

  const init: RequestInit = { method: req.method ?? "GET", headers };
  if (body.byteLength > 0) init.body = body;
  return new Request(fullUrl, init);
};

/** Write a fetch Response back to a node:http ServerResponse. */
const send = async (res: ServerResponse, response: Response): Promise<void> => {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value.includes(",") ? value.split(",").map((v) => v.trim()) : value;
  });
  res.writeHead(response.status, headers);
  if (response.body) res.end(Buffer.from(await response.arrayBuffer()));
  else res.end();
};

const server = createServer(async (req, res) => {
  try {
    const host = req.headers.host ?? "localhost";
    const url = new URL(req.url ?? "/", `http://${host}`);

    // Serve the small landing page on GET /.
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = await readFile(landingPageUrl);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    const fetchRequest = await toFetchRequest(req, url.toString());
    const response = await handle(fetchRequest);
    await send(res, response);
  } catch (error) {
    console.error("Request handler error:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Internal Server Error." }));
    } else {
      res.end();
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`QuizForge bot server listening on http://0.0.0.0:${PORT}`);
  console.log(`Webhook endpoint: POST/GET http://0.0.0.0:${PORT}/webhook`);
});
