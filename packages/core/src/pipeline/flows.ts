import type { ImportGraph } from "./imports.js";
import type { PrFile } from "./github.js";
import path from "node:path";

const MAX_FLOWS = 10;
const MAX_DEPTH = 4;

export interface FlowSpec {
  entry: string;
  slug: string; // stable id from the entrypoint (e.g. "src.app.shop.page")
  title: string; // fallback title (LLM/doc may refine)
  reachable: string[]; // BFS order from the entrypoint (merge-base graph)
  touched: number;
}

/** Next.js app/pages router entrypoints, plus common server/CLI mains. */
function findEntrypoints(files: string[]): string[] {
  const isEntry = (f: string) =>
    /(^|\/)app\/.*(^|\/)?(page|route|layout|error|global-error)\.(t|j)sx?$/.test(f) ||
    /(^|\/)pages\/.+\.(t|j)sx?$/.test(f) ||
    /(^|\/)(index|main|server|cli)\.(t|j)sx?$/.test(f.split("/").slice(-1)[0] ?? "");
  const pages = files.filter((f) => /(page|route)\.(t|j)sx?$/.test(f) && isEntry(f));
  return pages.length > 0 ? pages : files.filter(isEntry);
}

export function flowSlug(entry: string): string {
  return entry.replace(/\.(t|j)sx?$/, "").replaceAll("/", ".").replaceAll(/[^a-zA-Z0-9._-]/g, "_");
}

export function flowTitle(entry: string): string {
  const m = entry.match(/(?:^|\/)app\/(.*)\/(page|route|layout)\.(?:t|j)sx?$/);
  if (m) return `${m[1] || "root"} ${m[2]}`;
  const base = path.basename(entry).replace(/\.(t|j)sx?$/, "");
  const dir = path.dirname(entry).split("/").slice(-1)[0];
  return dir && dir !== "." ? `${dir}/${base}` : base;
}

export function buildFlowSpecs(graph: ImportGraph, changedFiles: Set<string>): FlowSpec[] {
  const entries = findEntrypoints(graph.files);
  const specs: FlowSpec[] = [];
  for (const entry of entries) {
    const seen = new Set<string>([entry]);
    const order: string[] = [entry];
    let frontier = [entry];
    for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const f of frontier) {
        for (const t of graph.edges.get(f) ?? []) {
          if (!seen.has(t)) {
            seen.add(t);
            order.push(t);
            next.push(t);
          }
        }
      }
      frontier = next;
    }
    if (order.length <= 2) continue; // a flow of 1-2 files isn't a flow
    specs.push({
      entry,
      slug: flowSlug(entry),
      title: flowTitle(entry),
      reachable: order,
      touched: order.filter((f) => changedFiles.has(f)).length,
    });
  }
  return specs
    .sort((a, b) => b.touched - a.touched || b.reachable.length - a.reachable.length)
    .slice(0, MAX_FLOWS);
}

/**
 * The PR files relevant to one flow (its "after"/added inputs). `spec.reachable`
 * comes from the merge-base graph, so PR-added files are never in it; we bring
 * them in by directory adjacency and by import-name overlap. A file is attributed
 * to the flow when it:
 *  - is in the reachable set (filename or, for renames, previousFilename), or
 *  - lives under a directory already represented in reachable, or
 *  - imports / is imported by a reachable file (string match on the patch).
 *
 * This is the diff INPUT set; the hard hallucination guard (dropping unknown
 * paths) is applied separately against graph ∪ PR files.
 */
export function attributeDiffs(spec: FlowSpec, files: PrFile[]): PrFile[] {
  const reachableSet = new Set(spec.reachable);
  const reachableDirs = new Set(spec.reachable.map((f) => path.dirname(f)));
  // basenames without extension, used for coarse import-name overlap on patches
  const reachableStems = new Set(
    spec.reachable.map((f) => path.basename(f).replace(/\.(t|j)sx?$/, "")),
  );

  const importsReachable = (patch: string | null): boolean => {
    if (!patch) return false;
    for (const line of patch.split("\n")) {
      if (!/^[+ ].*(?:\bimport\b|\brequire\(|\bfrom\s)/.test(line)) continue;
      const m = line.match(/['"]([^'"]+)['"]/);
      if (!m) continue;
      const stem = path.basename(m[1]!).replace(/\.(t|j)sx?$/, "");
      if (reachableStems.has(stem)) return true;
    }
    return false;
  };

  return files.filter((f) => {
    if (reachableSet.has(f.filename)) return true;
    if (f.previousFilename && reachableSet.has(f.previousFilename)) return true;
    if (reachableDirs.has(path.dirname(f.filename))) return true;
    return importsReachable(f.patch);
  });
}
