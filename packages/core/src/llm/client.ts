import { spawn } from "node:child_process";

/**
 * Two implementations:
 * - AnthropicApiClient: used when ANTHROPIC_API_KEY is set (deployed mode).
 * - ClaudeCliClient: shells out to the local `claude` CLI (rides the user's
 *   subscription; default for local dev, no key required).
 *
 * tier "light" = cheap map-phase calls (per-tile decoration);
 * tier "heavy" = synthesis/chat.
 */
export interface CompleteOptions {
  prompt: string;
  system?: string;
  maxTokens?: number;
  tier: "light" | "heavy";
}

export interface LlmClient {
  complete(opts: CompleteOptions): Promise<string>;
  stream(opts: CompleteOptions, onDelta: (text: string) => void): Promise<string>;
}

export function createLlmClient(): LlmClient {
  if (process.env.ANTHROPIC_API_KEY) return new AnthropicApiClient();
  return new ClaudeCliClient();
}

export class AnthropicApiClient implements LlmClient {
  private clientPromise: Promise<any> | null = null;

  private async client(): Promise<any> {
    if (!this.clientPromise) {
      this.clientPromise = import("@anthropic-ai/sdk").then((m: any) => new m.default());
    }
    return this.clientPromise;
  }

  private model(tier: "light" | "heavy"): string {
    if (tier === "light") return process.env.PR_REV_LIGHT_MODEL ?? "claude-haiku-4-5";
    return process.env.PR_REV_MODEL ?? "claude-opus-4-8";
  }

  async complete(opts: CompleteOptions): Promise<string> {
    return this.stream(opts, () => {});
  }

  async stream(opts: CompleteOptions, onDelta: (text: string) => void): Promise<string> {
    const client = await this.client();
    const stream = client.messages.stream({
      model: this.model(opts.tier),
      max_tokens: opts.maxTokens ?? 4096,
      ...(opts.system ? { system: opts.system } : {}),
      messages: [{ role: "user", content: opts.prompt }],
    });
    stream.on("text", (delta: string) => onDelta(delta));
    const final = await stream.finalMessage();
    return final.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");
  }
}

export class ClaudeCliClient implements LlmClient {
  private model(tier: "light" | "heavy"): string | null {
    if (tier === "light") return process.env.PR_REV_LIGHT_MODEL ?? "haiku";
    return process.env.PR_REV_MODEL ?? null; // null = user's configured default model
  }

  private args(tier: "light" | "heavy", extra: string[]): string[] {
    const model = this.model(tier);
    return [
      "-p",
      ...(model ? ["--model", model] : []),
      "--tools", "",
      ...extra,
    ];
  }

  async complete(opts: CompleteOptions): Promise<string> {
    const out = await runClaude(this.args(opts.tier, ["--output-format", "json"]), fullPrompt(opts));
    const parsed = JSON.parse(out);
    if (parsed.is_error) throw new Error(`claude CLI error: ${parsed.result}`);
    return parsed.result as string;
  }

  async stream(opts: CompleteOptions, onDelta: (text: string) => void): Promise<string> {
    const args = this.args(opts.tier, [
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
    ]);
    let text = "";
    await runClaude(args, fullPrompt(opts), (line) => {
      try {
        const ev = JSON.parse(line);
        if (ev.type === "stream_event" && ev.event?.type === "content_block_delta") {
          const d = ev.event.delta;
          if (d?.type === "text_delta" && d.text) {
            text += d.text;
            onDelta(d.text);
          }
        } else if (ev.type === "result" && !text && typeof ev.result === "string") {
          // fallback: no partial deltas seen (older CLI) — emit final result once
          text = ev.result;
          onDelta(ev.result);
        }
      } catch {
        // non-JSON line; ignore
      }
    });
    return text;
  }
}

function fullPrompt(opts: CompleteOptions): string {
  return opts.system ? `${opts.system}\n\n---\n\n${opts.prompt}` : opts.prompt;
}

function runClaude(args: string[], stdin: string, onLine?: (line: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let buf = "";
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("claude CLI timed out after 300s"));
    }, 300_000);
    proc.stdout.on("data", (chunk: Buffer) => {
      const s = chunk.toString();
      out += s;
      if (onLine) {
        buf += s;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) onLine(line);
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
    proc.on("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (onLine && buf.trim()) onLine(buf);
      if (code === 0) resolve(out);
      else reject(new Error(`claude CLI exited ${code}: ${err.slice(0, 500)}`));
    });
    proc.stdin.write(stdin);
    proc.stdin.end();
  });
}

/** Run up to `limit` promise factories concurrently. */
export async function pMap<T, R>(
  items: T[],
  fn: (item: T, i: number) => Promise<R>,
  limit: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}
