#!/usr/bin/env tsx
import path from "node:path";
import { analyze } from "../src/pipeline/run.js";

// usage: pnpm analyze <owner>/<repo> <prNumber> [--skip-llm]
const [repoArg, prArg, ...flags] = process.argv.slice(2);
if (!repoArg || !prArg || !repoArg.includes("/")) {
  console.error("usage: pnpm analyze <owner>/<repo> <prNumber> [--skip-llm]");
  process.exit(1);
}
const [owner, repo] = repoArg.split("/") as [string, string];

const rootDir = path.resolve(import.meta.dirname, "../../..");

analyze({
  owner,
  repo,
  prNumber: Number(prArg),
  artifactsDir: path.join(rootDir, "artifacts"),
  workDir: path.join(rootDir, "work"),
  skipLlm: flags.includes("--skip-llm"),
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
