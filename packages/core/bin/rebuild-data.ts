// one-off: rebuild ONLY the data artifacts using cached clones (no LLM, no tile rewrite)
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { resolvePr } from "../src/pipeline/github.js";
import { scanImports } from "../src/pipeline/imports.js";
import { buildData } from "../src/pipeline/data.js";
import { DataArtifact, DataOverlay, analysisPrefix, prPrefix } from "../src/schemas.js";

const [repoArg, prArg] = process.argv.slice(2);
const [owner, repo] = repoArg!.split("/") as [string, string];
const root = path.resolve(import.meta.dirname, "../../..");

const pr = await resolvePr(owner, repo, Number(prArg));
const baseDir = path.join(root, "work", `${owner}-${repo}-${pr.mergeBaseSha.slice(0, 12)}`);
const graph = await scanImports(baseDir);
const { artifact, overlay } = await buildData({
  owner, repo, pr, baseDir, workDir: path.join(root, "work"), graph, log: console.error,
});
DataArtifact.parse(artifact);
DataOverlay.parse(overlay);
await writeFile(path.join(root, "artifacts", analysisPrefix(owner, repo, pr.mergeBaseSha), "data.json"), JSON.stringify(artifact));
await writeFile(path.join(root, "artifacts", prPrefix(owner, repo, pr.number, pr.headSha), "data-overlay.json"), JSON.stringify(overlay));
console.error("data artifacts rewritten");
