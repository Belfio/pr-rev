import type { Tile, TileNode, TileEdge } from "../schemas.js";
import { tileFileName } from "../schemas.js";
import type { ImportGraph } from "./imports.js";
import type { TileBuild } from "./tiles.js";
import path from "node:path";

const MAX_FLOWS = 10;
const MAX_FLOW_NODES = 22;
const MAX_DEPTH = 4;

export interface FlowBuild {
  tiles: Tile[];
  /** file -> flow-tile memberships (kept separate from the map membership index) */
  membership: Map<string, { tileId: string; nodeId: string }[]>;
  flows: { tileId: string; title: string }[];
}

/** Next.js app/pages router entrypoints, plus common server/CLI mains. */
function findEntrypoints(files: string[]): string[] {
  const isEntry = (f: string) =>
    /(^|\/)app\/.*(^|\/)?(page|route|layout|error|global-error)\.(t|j)sx?$/.test(f) ||
    /(^|\/)pages\/.+\.(t|j)sx?$/.test(f) ||
    /(^|\/)(index|main|server|cli)\.(t|j)sx?$/.test(f.split("/").slice(-1)[0] ?? "");
  // layouts are entrypoints too but pages are the interesting flows; prefer page/route
  const pages = files.filter((f) => /(page|route)\.(t|j)sx?$/.test(f) && isEntry(f));
  return pages.length > 0 ? pages : files.filter(isEntry);
}

function flowSlug(entry: string): string {
  return entry.replace(/\.(t|j)sx?$/, "").replaceAll("/", ".").replaceAll(/[^a-zA-Z0-9._-]/g, "_");
}

function flowTitle(entry: string): string {
  // "src/app/shop/page.tsx" -> "shop page", "src/app/auth/callback/route.ts" -> "auth/callback route"
  const m = entry.match(/(?:^|\/)app\/(.*)\/(page|route|layout)\.(?:t|j)sx?$/);
  if (m) return `${m[1] || "root"} ${m[2]}`;
  const base = path.basename(entry).replace(/\.(t|j)sx?$/, "");
  const dir = path.dirname(entry).split("/").slice(-1)[0];
  return dir && dir !== "." ? `${dir}/${base}` : base;
}

export function buildFlowTiles(
  graph: ImportGraph,
  mapBuild: TileBuild,
  changedFiles: Set<string>,
  repo: { owner: string; name: string; commitSha: string },
  coverage: { analyzedFiles: number; eligibleFiles: number; unresolvedImports: number },
): FlowBuild {
  const entries = findEntrypoints(graph.files);

  // reachable set per entry (bounded BFS) — used both for ranking and tile content
  const reach = new Map<string, string[]>();
  for (const entry of entries) {
    const seen = new Set<string>([entry]);
    let frontier = [entry];
    for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const f of frontier) {
        for (const t of graph.edges.get(f) ?? []) {
          if (!seen.has(t)) {
            seen.add(t);
            next.push(t);
          }
        }
      }
      frontier = next;
    }
    reach.set(entry, [...seen]);
  }

  // rank: flows touching PR-changed files first, then by reach size
  const ranked = entries
    .map((e) => ({
      entry: e,
      files: reach.get(e)!,
      touched: reach.get(e)!.filter((f) => changedFiles.has(f)).length,
    }))
    .filter((r) => r.files.length > 2) // a flow of 1-2 files isn't a flow
    .sort((a, b) => b.touched - a.touched || b.files.length - a.files.length)
    .slice(0, MAX_FLOWS);

  const tiles: Tile[] = [];
  const membership = new Map<string, { tileId: string; nodeId: string }[]>();
  const flows: { tileId: string; title: string }[] = [];

  for (const { entry, files } of ranked) {
    const tileId = `flow:${flowSlug(entry)}`;
    const title = `Flow: ${flowTitle(entry)}`;

    // keep entry + nearest files; prefer touched files when truncating
    let members = files;
    if (members.length > MAX_FLOW_NODES) {
      const touched = members.filter((f) => changedFiles.has(f) && f !== entry);
      const rest = members.filter((f) => !changedFiles.has(f) && f !== entry);
      members = [entry, ...touched, ...rest].slice(0, MAX_FLOW_NODES);
    }
    const memberSet = new Set(members);

    const nodes: TileNode[] = [];
    const usedIds = new Map<string, number>();
    const nodeIdFor = new Map<string, string>();
    for (const f of members) {
      const base = `n:${path.basename(f).replaceAll(/[^a-zA-Z0-9._-]/g, "_")}`;
      const n = usedIds.get(base) ?? 0;
      usedIds.set(base, n + 1);
      const id = n === 0 ? base : `${base}~${n}`;
      nodeIdFor.set(f, id);
      // clicking a flow node jumps into the structure map at this file's location
      const mapEntry = mapBuild.fileToNodes.get(f);
      const jumpTile = mapEntry && mapEntry.length > 0 ? mapEntry[mapEntry.length - 1]!.tileId : null;
      nodes.push({
        id,
        kind: f === entry ? "service" : "file",
        label: f === entry ? flowTitle(entry) : path.basename(f),
        summary: null,
        anchors: [{ file: f, startLine: 1, endLine: 1 }],
        childTileId: jumpTile,
        stats: { files: 1, loc: 0 },
        pos: { x: 0, y: 0, w: 0, h: 0 },
      });
      if (!membership.has(f)) membership.set(f, []);
      membership.get(f)!.push({ tileId, nodeId: id });
    }

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

    tiles.push({
      schemaVersion: 1,
      tileId,
      kind: "flow",
      title,
      parentTileId: "root",
      breadcrumbs: [{ tileId: "root", title: `${repo.owner}/${repo.name}` }],
      repo,
      coverage,
      nodes,
      edges: edges.slice(0, 80),
      explanation: { uri: `tiles/${tileFileName(tileId)}.md` },
    });
    flows.push({ tileId, title });
  }

  return { tiles, membership, flows };
}
