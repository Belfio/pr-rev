import type { Tile, TileNode, TileEdge } from "../schemas.js";
import { tileFileName } from "../schemas.js";
import type { ImportGraph } from "./imports.js";
import type { TileBuild } from "./tiles.js";
import type { ExtractedFlow } from "../llm/flow-extract.js";
import path from "node:path";

const MAX_FLOWS = 10;
const MAX_FALLBACK_NODES = 22;
const MAX_DEPTH = 4;

export interface FlowSpec {
  entry: string;
  tileId: string;
  title: string; // stable "Flow: x" title used in the view switcher
  reachable: string[]; // BFS order from the entrypoint
  touched: number;
}

export interface AssembledFlow {
  tile: Tile;
  membership: { file: string; tileId: string; nodeId: string }[];
  /** explanation markdown when the flow was LLM-extracted (fallback tiles get decorated later) */
  explanation: string | null;
  extracted: boolean;
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

function flowSlug(entry: string): string {
  return entry.replace(/\.(t|j)sx?$/, "").replaceAll("/", ".").replaceAll(/[^a-zA-Z0-9._-]/g, "_");
}

function flowTitle(entry: string): string {
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
      tileId: `flow:${flowSlug(entry)}`,
      title: `Flow: ${flowTitle(entry)}`,
      reachable: order,
      touched: order.filter((f) => changedFiles.has(f)).length,
    });
  }
  return specs
    .sort((a, b) => b.touched - a.touched || b.reachable.length - a.reachable.length)
    .slice(0, MAX_FLOWS);
}

const envelope = (
  spec: FlowSpec,
  repo: { owner: string; name: string; commitSha: string },
  coverage: { analyzedFiles: number; eligibleFiles: number; unresolvedImports: number },
  nodes: TileNode[],
  edges: TileEdge[],
): Tile => ({
  schemaVersion: 1,
  tileId: spec.tileId,
  kind: "flow",
  title: spec.title,
  parentTileId: "root",
  breadcrumbs: [{ tileId: "root", title: `${repo.owner}/${repo.name}` }],
  repo,
  coverage,
  nodes,
  edges: edges.slice(0, 80),
  explanation: { uri: `tiles/${tileFileName(spec.tileId)}.md` },
});

/** jump target: the deepest structure-map tile containing the file */
function jumpTileFor(mapBuild: TileBuild, file: string | null): string | null {
  if (!file) return null;
  const entries = mapBuild.fileToNodes.get(file);
  return entries && entries.length > 0 ? entries[entries.length - 1]!.tileId : null;
}

/** Build a step-diagram tile from an LLM-extracted flow (already validated). */
export function assembleExtractedFlow(
  spec: FlowSpec,
  flow: ExtractedFlow,
  mapBuild: TileBuild,
  repo: { owner: string; name: string; commitSha: string },
  coverage: { analyzedFiles: number; eligibleFiles: number; unresolvedImports: number },
): AssembledFlow {
  const membership: AssembledFlow["membership"] = [];
  const nodes: TileNode[] = flow.steps.map((s) => {
    const nodeId = `n:${s.id}`;
    if (s.file) membership.push({ file: s.file, tileId: spec.tileId, nodeId });
    return {
      id: nodeId,
      kind: s.kind === "step" ? "step" : s.kind === "screen" ? "screen" : s.kind,
      label: s.label,
      summary: s.detail ? (s.file ? `${s.detail} — ${s.file}` : s.detail) : s.file,
      anchors: s.file ? [{ file: s.file, startLine: 1, endLine: 1 }] : [],
      childTileId: jumpTileFor(mapBuild, s.file),
      stats: { files: s.file ? 1 : 0, loc: 0 },
      pos: { x: 0, y: 0, w: 0, h: 0 },
    };
  });
  const edges: TileEdge[] = flow.edges.map((e, i) => ({
    id: `e:${e.from}->${e.to}~${i}`,
    source: `n:${e.from}`,
    target: `n:${e.to}`,
    kind: "dataflow",
    weight: 1,
    label: e.label,
  }));
  return {
    tile: envelope(spec, repo, coverage, nodes, edges),
    membership,
    explanation: flow.explanationMarkdown || null,
    extracted: true,
  };
}

/** Deterministic fallback: the entrypoint's traced dependency fan (no LLM needed). */
export function assembleFallbackFlow(
  spec: FlowSpec,
  graph: ImportGraph,
  mapBuild: TileBuild,
  changedFiles: Set<string>,
  repo: { owner: string; name: string; commitSha: string },
  coverage: { analyzedFiles: number; eligibleFiles: number; unresolvedImports: number },
): AssembledFlow {
  let members = spec.reachable;
  if (members.length > MAX_FALLBACK_NODES) {
    const touched = members.filter((f) => changedFiles.has(f) && f !== spec.entry);
    const rest = members.filter((f) => !changedFiles.has(f) && f !== spec.entry);
    members = [spec.entry, ...touched, ...rest].slice(0, MAX_FALLBACK_NODES);
  }
  const memberSet = new Set(members);
  const membership: AssembledFlow["membership"] = [];
  const nodeIdFor = new Map<string, string>();
  const usedIds = new Map<string, number>();
  const nodes: TileNode[] = members.map((f) => {
    const base = `n:${path.basename(f).replaceAll(/[^a-zA-Z0-9._-]/g, "_")}`;
    const n = usedIds.get(base) ?? 0;
    usedIds.set(base, n + 1);
    const id = n === 0 ? base : `${base}~${n}`;
    nodeIdFor.set(f, id);
    membership.push({ file: f, tileId: spec.tileId, nodeId: id });
    return {
      id,
      kind: f === spec.entry ? ("service" as const) : ("file" as const),
      label: f === spec.entry ? flowTitle(spec.entry) : path.basename(f),
      summary: null,
      anchors: [{ file: f, startLine: 1, endLine: 1 }],
      childTileId: jumpTileFor(mapBuild, f),
      stats: { files: 1, loc: 0 },
      pos: { x: 0, y: 0, w: 0, h: 0 },
    };
  });
  const edges: TileEdge[] = [];
  for (const f of members) {
    for (const t of graph.edges.get(f) ?? []) {
      if (!memberSet.has(t)) continue;
      edges.push({
        id: `e:${nodeIdFor.get(f)}->${nodeIdFor.get(t)}`,
        source: nodeIdFor.get(f)!,
        target: nodeIdFor.get(t)!,
        kind: "dataflow",
        weight: 1,
      });
    }
  }
  return { tile: envelope(spec, repo, coverage, nodes, edges), membership, explanation: null, extracted: false };
}
