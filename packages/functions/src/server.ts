import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { streamSSE } from "hono/streaming";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createLlmClient } from "@pr-rev/core";
import { buildChatContext } from "./chat-context.js";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const ARTIFACTS = process.env.ARTIFACTS_DIR ?? path.join(ROOT, "artifacts");

const app = new Hono();
const llm = createLlmClient();

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/reviews", async (c) => {
  try {
    return c.json(JSON.parse(await readFile(path.join(ARTIFACTS, "reviews.json"), "utf8")));
  } catch {
    return c.json([]);
  }
});

// serve any artifact file; path is validated to stay inside ARTIFACTS
app.get("/api/artifacts/*", async (c) => {
  const rel = decodeURIComponent(c.req.path.replace(/^\/api\/artifacts\//, ""));
  const abs = path.resolve(ARTIFACTS, rel);
  if (!abs.startsWith(path.resolve(ARTIFACTS) + path.sep)) return c.text("forbidden", 403);
  try {
    const data = await readFile(abs);
    const type = abs.endsWith(".json")
      ? "application/json"
      : abs.endsWith(".md")
        ? "text/markdown; charset=utf-8"
        : "text/plain; charset=utf-8";
    c.header("Content-Type", type);
    c.header("Cache-Control", "public, max-age=31536000, immutable"); // SHA-keyed => immutable
    return c.body(data);
  } catch {
    return c.text("not found", 404);
  }
});

interface ChatBody {
  owner: string;
  repo: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  tileId: string;
  selectedNodeId: string | null;
  message: string;
  history: { role: "user" | "assistant"; text: string }[];
}

app.post("/api/chat", async (c) => {
  const body = (await c.req.json()) as ChatBody;
  const { system, prompt } = await buildChatContext(ARTIFACTS, body);
  return streamSSE(c, async (stream) => {
    try {
      await llm.stream({ prompt, system, tier: "heavy", maxTokens: 2048 }, (delta) => {
        stream.writeSSE({ event: "delta", data: JSON.stringify({ text: delta }) });
      });
      await stream.writeSSE({ event: "done", data: "{}" });
    } catch (e) {
      await stream.writeSSE({ event: "error", data: JSON.stringify({ message: (e as Error).message }) });
    }
  });
});

const port = Number(process.env.PORT ?? 3001);
serve({ fetch: app.fetch, port }, () => {
  console.log(`pr-rev api on http://localhost:${port} (artifacts: ${ARTIFACTS})`);
});
