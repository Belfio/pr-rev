import { z } from "zod";

// Tile paths are logical ids like "root/packages.api/handlers".
// In filenames, "/" is replaced by "__" (see tileFileName).

export const NodeKind = z.enum([
  "service",
  "module",
  "file",
  "function",
  "datastore",
  "external",
  "cluster",
  // flow-diagram step kinds
  "screen",
  "step",
  "decision",
]);

export const EdgeKind = z.enum(["import", "call", "reads", "writes", "dataflow"]);

export const Anchor = z.object({
  file: z.string(),
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
});

export const TileNode = z.object({
  id: z.string(),
  kind: NodeKind,
  label: z.string(),
  summary: z.string().nullable(),
  anchors: z.array(Anchor).max(5),
  childTileId: z.string().nullable(),
  stats: z.object({ files: z.number().int(), loc: z.number().int() }),
  pos: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
});

export const TileEdge = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  kind: EdgeKind,
  weight: z.number().int().positive(),
  label: z.string().nullable().optional(), // branch/sequence label on flow edges
});

export const Tile = z.object({
  schemaVersion: z.literal(1),
  tileId: z.string(),
  kind: z.enum(["module-map", "flow", "infra", "datastructure"]),
  title: z.string(),
  parentTileId: z.string().nullable(),
  breadcrumbs: z.array(z.object({ tileId: z.string(), title: z.string() })),
  repo: z.object({ owner: z.string(), name: z.string(), commitSha: z.string() }),
  coverage: z.object({
    analyzedFiles: z.number().int(),
    eligibleFiles: z.number().int(),
    unresolvedImports: z.number().int(),
  }),
  nodes: z.array(TileNode).max(40),
  edges: z.array(TileEdge).max(80),
  explanation: z.object({ uri: z.string() }),
});

export const HunkRef = z.object({
  file: z.string(),
  patchUri: z.string(),
  hunkIndices: z.array(z.number().int()),
  oldRange: z.tuple([z.number().int(), z.number().int()]),
  newRange: z.tuple([z.number().int(), z.number().int()]),
});

export const OverlayNode = z.object({
  status: z.enum(["added", "modified", "removed", "renamed"]),
  renamedFrom: z.string().nullable(),
  changeSummary: z.string().nullable(),
  hunkRefs: z.array(HunkRef),
});

export const TileOverlay = z.object({
  tileId: z.string(),
  nodes: z.record(OverlayNode),
  addedNodes: z.array(TileNode),
  addedEdges: z.array(TileEdge),
  removedNodeIds: z.array(z.string()),
  explanationUri: z.string().nullable(),
});

export const OverlayManifest = z.object({
  pr: z.object({
    number: z.number().int(),
    title: z.string(),
    baseSha: z.string(),
    headSha: z.string(),
    author: z.string(),
    url: z.string(),
  }),
  touchedTiles: z.record(
    z.object({
      status: z.enum(["modified"]),
      counts: z.object({
        added: z.number().int(),
        modified: z.number().int(),
        removed: z.number().int(),
      }),
    }),
  ),
  summaryUri: z.string(),
});

export const AnalysisManifest = z.object({
  schemaVersion: z.literal(1),
  repo: z.object({ owner: z.string(), name: z.string(), commitSha: z.string() }),
  rootTileId: z.string(),
  tileIds: z.array(z.string()),
  flows: z.array(z.object({ tileId: z.string(), title: z.string() })).default([]),
  coverage: z.object({
    analyzedFiles: z.number().int(),
    eligibleFiles: z.number().int(),
    unresolvedImports: z.number().int(),
  }),
  generatedAt: z.string(),
});

export type NodeKind = z.infer<typeof NodeKind>;
export type Anchor = z.infer<typeof Anchor>;
export type TileNode = z.infer<typeof TileNode>;
export type TileEdge = z.infer<typeof TileEdge>;
export type Tile = z.infer<typeof Tile>;
export type HunkRef = z.infer<typeof HunkRef>;
export type OverlayNode = z.infer<typeof OverlayNode>;
export type TileOverlay = z.infer<typeof TileOverlay>;
export type OverlayManifest = z.infer<typeof OverlayManifest>;
export type AnalysisManifest = z.infer<typeof AnalysisManifest>;

/** "root/packages.api/handlers" -> "root__packages.api__handlers" */
export function tileFileName(tileId: string): string {
  return tileId.replaceAll("/", "__");
}

export function analysisPrefix(owner: string, repo: string, baseSha: string): string {
  return `analysis/${owner}/${repo}/${baseSha}`;
}

export function prPrefix(owner: string, repo: string, prNumber: number, headSha: string): string {
  return `pr/${owner}/${repo}/${prNumber}/${headSha}`;
}

/** "src/api/auth.ts" -> "src__api__auth.ts" for patch filenames */
export function escapePath(p: string): string {
  return p.replaceAll("/", "__");
}
