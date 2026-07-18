import { analyze } from "@pr-rev/core";
import { assertSafeRepoRef } from "./github-live.js";

export type JobState = "queued" | "running" | "done" | "error";

export interface JobRecord {
  owner: string;
  repo: string;
  prNumber: number;
  state: JobState;
  startedAt: string;
  log: string[];
  error?: string;
}

const LOG_CAP = 200;

/**
 * In-process analysis runner: a job registry plus a single-worker FIFO queue.
 * Analyses share clone dirs (work/) and the LLM CLI, so they must not overlap —
 * the queue serializes them regardless of how many the UI kicks off at once.
 */
export class AnalysisRunner {
  private jobs = new Map<string, JobRecord>();
  private queue: string[] = [];
  private running = false;

  constructor(
    private artifactsDir: string,
    private workDir: string,
  ) {}

  private key(owner: string, repo: string, prNumber: number): string {
    return `${owner}/${repo}#${prNumber}`;
  }

  get(owner: string, repo: string, prNumber: number): JobRecord | undefined {
    return this.jobs.get(this.key(owner, repo, prNumber));
  }

  /**
   * Idempotent while a run is in flight: a repeat POST for a queued/running job
   * returns the existing record rather than enqueuing a duplicate. A finished
   * (done) or failed (error) job is re-queued, which is what the UI's
   * Re-analyze and Retry buttons rely on.
   */
  enqueue(owner: string, repo: string, prNumber: number): JobRecord {
    assertSafeRepoRef(owner, repo, prNumber);
    const key = this.key(owner, repo, prNumber);
    const existing = this.jobs.get(key);
    if (existing && (existing.state === "queued" || existing.state === "running")) return existing;

    const rec: JobRecord = {
      owner,
      repo,
      prNumber,
      state: "queued",
      startedAt: new Date().toISOString(),
      log: [],
    };
    this.jobs.set(key, rec);
    this.queue.push(key);
    void this.pump();
    return rec;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const key = this.queue.shift()!;
        const rec = this.jobs.get(key);
        if (!rec) continue;
        rec.state = "running";
        rec.startedAt = new Date().toISOString();
        const log = (msg: string) => {
          rec.log.push(msg);
          if (rec.log.length > LOG_CAP) rec.log.splice(0, rec.log.length - LOG_CAP);
        };
        try {
          await analyze({
            owner: rec.owner,
            repo: rec.repo,
            prNumber: rec.prNumber,
            artifactsDir: this.artifactsDir,
            workDir: this.workDir,
            skipLlm: false,
            log,
          });
          rec.state = "done";
        } catch (e) {
          rec.state = "error";
          rec.error = (e as Error).message;
          log(`ERROR: ${rec.error}`);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
