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
  // Per-PR feature list (docs touched by this PR). Lives in the PR prefix so the
  // base analysis prefix stays PR-agnostic. `direct` = a changed file is cited by a
  // doc section; `shared` = a changed file is only reachable, not cited.
  features: z
    .array(
      z.object({
        slug: z.string(),
        title: z.string(),
        direct: z.boolean(),
        shared: z.boolean(),
      }),
    )
    .default([]),
  summaryUri: z.string(),
});

export const AnalysisManifest = z.object({
  schemaVersion: z.literal(1),
  repo: z.object({ owner: z.string(), name: z.string(), commitSha: z.string() }),
  rootTileId: z.string(),
  tileIds: z.array(z.string()),
  // @deprecated Flows are now before/after feature docs (see FeatureDoc); the
  // per-PR feature list lives on OverlayManifest.features. Kept so old on-disk
  // manifests still parse — the pipeline no longer WRITES this field.
  flows: z
    .array(
      z.object({
        tileId: z.string(),
        title: z.string(),
        direct: z.boolean(),
        shared: z.boolean(),
      }),
    )
    .default([]),
  coverage: z.object({
    analyzedFiles: z.number().int(),
    eligibleFiles: z.number().int(),
    unresolvedImports: z.number().int(),
  }),
  generatedAt: z.string(),
});

// --- Feature docs (PR triptych "Flows" pane: before/after documentation) -----

// Base narrative — merge-base state of one feature, no PR annotations. Reusable
// across PRs of the same merge-base (additive cache in the analysis prefix).
export const DocSection = z.object({
  id: z.string(), // stable slug within the doc (fixed across PRs at the same base)
  ordinal: z.number().int(),
  heading: z.string(),
  files: z.array(z.string()), // validated against graph ∪ PR files (see attribution)
  overview: z.string(), // "What happens" markdown (may be empty)
  importantDetail: z.string(), // callout (may be empty)
});

export const FeatureDoc = z.object({
  slug: z.string(), // stable, from entrypoint (e.g. "src.app.shop.page")
  title: z.string(),
  purpose: z.string(), // one-line
  atAGlance: z.string(), // ASCII diagram, rendered in <pre> (may be empty)
  coreModel: z.array(z.string()), // invariant bullets (may be empty)
  sections: z.array(DocSection),
  summary: z.string(), // recap (may be empty)
  // Provenance for the additive cache: "skeleton" docs (from --skip-llm) carry empty
  // prose and MUST be upgradable by a later full run; "llm" docs are never overwritten
  // (preserves section-id stability across real runs). Skeleton→llm is a one-way ratchet.
  generator: z.enum(["skeleton", "llm"]),
});

// PR change layer for one feature doc — keyed by prNumber/headSha in the PR prefix.
export const FeatureDocSectionChange = z.object({
  change: z.enum(["added", "changed", "removed"]),
  changeNarrative: z.string(), // before → after prose (may be empty)
  files: z.array(z.string()),
  hunkRefs: z.array(HunkRef), // reuse tile HunkRef so DiffView gets patchUri directly
});

export const FeatureDocOverlay = z.object({
  slug: z.string(),
  // sectionId -> change; sections absent here render unchanged. Keys may reference
  // base doc sections OR addedSections ids.
  sectionChanges: z.record(FeatureDocSectionChange),
  addedSections: z.array(DocSection), // net-new sections (from PR-added files)
});

// --- Data artifact (PR triptych "Data" pane) ---------------------------------

export const DataField = z.object({
  name: z.string(),
  type: z.string(),
  optional: z.boolean(),
});

export const DataEntity = z.object({
  id: z.string(), // exported symbol name (unique per file; suffix ~1 on collision)
  name: z.string(),
  kind: z.enum(["object", "enum"]),
  provenance: z.enum(["generated-db", "app-type", "migration"]),
  definedIn: z.string(),
  fields: z.array(DataField).default([]), // kind=object: checker-resolved apparent-type members
  values: z.array(z.string()).default([]), // kind=enum: string-literal union members
  pos: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
});

export const DataEdge = z.object({
  source: z.string(),
  target: z.string(),
  label: z.string(),
});

export const DataArtifact = z.object({
  schemaVersion: z.literal(1),
  status: z.enum(["ok", "unsupported"]),
  sources: z.array(z.string()), // schema-source files found
  entities: z.array(DataEntity),
  edges: z.array(DataEdge),
  consumers: z.record(z.array(z.string())), // defining file -> files importing it
});

export const DataOverlayField = z.object({
  status: z.enum(["added", "removed", "changed"]),
  type: z.string().nullable(), // new type ("changed"/"added"), null for "removed"
  prevType: z.string().nullable(), // prior type ("changed"/"removed"), null for "added"
});

export const DataOverlayEntity = z.object({
  status: z.enum(["added", "removed", "modified"]),
  fields: z.record(DataOverlayField).default({}),
  valuesAdded: z.array(z.string()).default([]), // enums
  valuesRemoved: z.array(z.string()).default([]), // enums
});

export const DataMigrationOp = z.object({
  file: z.string(),
  op: z.string(),
  table: z.string().nullable(),
  analyzed: z.boolean(), // false = "operation not analyzed" (raw statement kept in `op`)
});

export const DataOverlay = z.object({
  status: z.enum(["ok", "none", "unsupported"]),
  entities: z.record(DataOverlayEntity),
  addedEntities: z.array(DataEntity), // full entity objects, laid out client-side in a band
  migrationOps: z.array(DataMigrationOp),
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
export type DocSection = z.infer<typeof DocSection>;
export type FeatureDoc = z.infer<typeof FeatureDoc>;
export type FeatureDocSectionChange = z.infer<typeof FeatureDocSectionChange>;
export type FeatureDocOverlay = z.infer<typeof FeatureDocOverlay>;
export type DataField = z.infer<typeof DataField>;
export type DataEntity = z.infer<typeof DataEntity>;
export type DataEdge = z.infer<typeof DataEdge>;
export type DataArtifact = z.infer<typeof DataArtifact>;
export type DataOverlayField = z.infer<typeof DataOverlayField>;
export type DataOverlayEntity = z.infer<typeof DataOverlayEntity>;
export type DataMigrationOp = z.infer<typeof DataMigrationOp>;
export type DataOverlay = z.infer<typeof DataOverlay>;

/** "root/packages.api/handlers" -> "root__packages.api__handlers" */
export function tileFileName(tileId: string): string {
  return tileId.replaceAll("/", "__");
}

/**
 * Filename stem for a feature doc / doc overlay: "feature:<slug>" with the same
 * "/"→"__" escaping used for tiles (so `feature:` files sit beside `flow:`-style
 * names consistently). Base doc: analysis/{owner}/{repo}/{baseSha}/docs/<stem>.json;
 * doc overlay: pr/{owner}/{repo}/{n}/{headSha}/overlays/<stem>.json.
 */
export function featureFileName(slug: string): string {
  return tileFileName(`feature:${slug}`);
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
