import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { streamSSE } from "hono/streaming";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createLlmClient } from "@pr-rev/core";
import { buildChatContext } from "./chat-context.js";
import { getPrMeta, postPrComment, listOpenPrs } from "./github-live.js";
import { AnalysisRunner } from "./jobs.js";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const ARTIFACTS = process.env.ARTIFACTS_DIR ?? path.join(ROOT, "artifacts");
const WORK = path.join(ROOT, "work");

const app = new Hono();
const llm = createLlmClient();
const runner = new AnalysisRunner(ARTIFACTS, WORK);

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/reviews", async (c) => {
  try {
    return c.json(JSON.parse(await readFile(path.join(ARTIFACTS, "reviews.json"), "utf8")));
  } catch {
    return c.json([]);
  }
});

// live list of a repo's open PRs — proxied from GitHub, never cached
app.get("/api/prs/:owner/:repo", async (c) => {
  try {
    const prs = await listOpenPrs(c.req.param("owner"), c.req.param("repo"));
    c.header("Cache-Control", "no-store");
    return c.json(prs);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

// kick off (or re-run) an analysis in-process; the runner serializes concurrent requests
app.post("/api/analyze", async (c) => {
  try {
    const { owner, repo, prNumber } = (await c.req.json()) as {
      owner: string;
      repo: string;
      prNumber: number;
    };
    const rec = runner.enqueue(owner, repo, Number(prNumber));
    return c.json({ state: rec.state }, 202);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

// poll a job's state + rolling log
app.get("/api/analyze/:owner/:repo/:number", (c) => {
  const rec = runner.get(c.req.param("owner"), c.req.param("repo"), Number(c.req.param("number")));
  c.header("Cache-Control", "no-store");
  if (!rec) return c.json({ error: "unknown job" }, 404);
  return c.json(rec);
});

// serve any artifact file; path is validated (incl. symlink resolution) to stay inside ARTIFACTS
app.get("/api/artifacts/*", async (c) => {
  const rel = decodeURIComponent(c.req.path.replace(/^\/api\/artifacts\//, ""));
  if (rel.includes("\0") || rel.split("/").some((s) => s === "..")) return c.text("forbidden", 403);
  const root = await realpath(path.resolve(ARTIFACTS)).catch(() => null);
  if (!root) return c.text("not found", 404);
  const lexical = path.resolve(root, rel);
  if (!lexical.startsWith(root + path.sep)) return c.text("forbidden", 403);
  const abs = await realpath(lexical).catch(() => null); // follows symlinks
  if (!abs) return c.text("not found", 404); // file doesn't exist
  if (!abs.startsWith(root + path.sep)) return c.text("forbidden", 403); // symlink escape
  try {
    const data = await readFile(abs);
    const type = abs.endsWith(".json")
      ? "application/json"
      : abs.endsWith(".md")
        ? "text/markdown; charset=utf-8"
        : "text/plain; charset=utf-8";
    c.header("Content-Type", type);
    // SHA-keyed artifacts are immutable in principle, but local dev regenerates them
    // in place — only send immutable headers when explicitly enabled (deployed mode).
    c.header(
      "Cache-Control",
      process.env.IMMUTABLE_ARTIFACTS ? "public, max-age=31536000, immutable" : "no-cache",
    );
    return c.body(data);
  } catch {
    return c.text("not found", 404);
  }
});

// live PR metadata (title, body, comments) — proxied from GitHub, never cached in artifacts
app.get("/api/pr/:owner/:repo/:number", async (c) => {
  try {
    const meta = await getPrMeta(c.req.param("owner"), c.req.param("repo"), Number(c.req.param("number")));
    c.header("Cache-Control", "no-store");
    return c.json(meta);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

app.post("/api/pr/:owner/:repo/:number/comments", async (c) => {
  try {
    const { body } = (await c.req.json()) as { body: string };
    const comment = await postPrComment(
      c.req.param("owner"),
      c.req.param("repo"),
      Number(c.req.param("number")),
      body,
    );
    return c.json(comment, 201);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
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
