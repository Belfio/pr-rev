import type { QueryClient } from "@tanstack/react-query";

export interface Review {
  owner: string;
  repo: string;
  prNumber: number;
  title: string;
  author: string;
  baseSha: string;
  headSha: string;
  url: string;
  generatedAt: string;
}

export interface PrListItem {
  number: number;
  title: string;
  author: string;
  draft: boolean;
  createdAt: string;
  headSha: string;
  url: string;
}

export type JobState = "queued" | "running" | "done" | "error";

export interface AnalyzeJob {
  owner: string;
  repo: string;
  prNumber: number;
  state: JobState;
  startedAt: string;
  log: string[];
  error?: string;
}

export interface TileNode {
  id: string;
  kind: string;
  label: string;
  summary: string | null;
  anchors: { file: string; startLine: number; endLine: number }[];
  childTileId: string | null;
  stats: { files: number; loc: number };
  pos: { x: number; y: number; w: number; h: number };
}

export interface TileEdge {
  id: string;
  source: string;
  target: string;
  kind: string;
  weight: number;
  label?: string | null;
}

export interface Tile {
  tileId: string;
  kind: string;
  title: string;
  parentTileId: string | null;
  breadcrumbs: { tileId: string; title: string }[];
  repo: { owner: string; name: string; commitSha: string };
  coverage: { analyzedFiles: number; eligibleFiles: number; unresolvedImports: number };
  nodes: TileNode[];
  edges: TileEdge[];
  explanation: { uri: string };
}

export interface HunkRef {
  file: string;
  patchUri: string;
  hunkIndices: number[];
  oldRange: [number, number];
  newRange: [number, number];
}

export interface OverlayNode {
  status: "added" | "modified" | "removed" | "renamed";
  renamedFrom: string | null;
  changeSummary: string | null;
  hunkRefs: HunkRef[];
}

export interface TileOverlay {
  tileId: string;
  nodes: Record<string, OverlayNode>;
  addedNodes: TileNode[];
  addedEdges: TileEdge[];
  removedNodeIds: string[];
  explanationUri: string | null;
}

export interface PrComment {
  id: number;
  author: string;
  authorAvatar: string | null;
  body: string;
  createdAt: string;
  kind: "discussion" | "review";
  path: string | null;
  line: number | null;
}

export interface PrMeta {
  number: number;
  title: string;
  body: string;
  author: string;
  state: string;
  draft: boolean;
  merged: boolean;
  url: string;
  createdAt: string;
  comments: PrComment[];
}

export interface AnalysisManifest {
  rootTileId: string;
  tileIds: string[];
  // direct/shared are PR-relative flow classification added by the pipeline; tolerate
  // their absence on older manifests (treat as neither direct nor shared).
  flows: { tileId: string; title: string; direct?: boolean; shared?: boolean }[];
  coverage: { analyzedFiles: number; eligibleFiles: number; unresolvedImports: number };
}

// ---------- Data (triptych "Data" tab) ----------

export interface DataField {
  name: string;
  type: string;
  optional: boolean;
}

export interface DataEntity {
  id: string;
  name: string;
  kind: "object" | "enum";
  provenance: "generated-db" | "app-type" | "migration";
  definedIn: string;
  fields: DataField[];
  values?: string[]; // kind === "enum" only
  pos: { x: number; y: number; w: number; h: number };
}

export interface DataEdge {
  source: string;
  target: string;
  label: string;
}

/** analysis/{owner}/{repo}/{baseSha}/data.json — base entities, PR-independent */
export interface DataArtifact {
  schemaVersion: number;
  status: "ok" | "unsupported";
  sources: string[];
  entities: DataEntity[];
  edges: DataEdge[];
  consumers: Record<string, string[]>; // definedIn file -> files importing it
}

// Field-level statuses come from the pipeline as "changed" (not "modified" — that's
// the ENTITY-level status); see packages/core/src/schemas.ts DataOverlayField.
export interface FieldOverlay {
  status: "added" | "removed" | "changed";
  type: string | null;
  prevType?: string | null;
}

export interface EntityOverlay {
  status: "added" | "removed" | "modified";
  fields?: Record<string, FieldOverlay>;
  valuesAdded?: string[];
  valuesRemoved?: string[];
}

export interface MigrationOp {
  file: string;
  op: string;
  table?: string;
  analyzed?: boolean; // absent === analyzed; false === surfaced as "not analyzed"
}

/** pr/{owner}/{repo}/{n}/{headSha}/data-overlay.json */
export interface DataOverlay {
  status: "ok" | "none" | "unsupported";
  entities: Record<string, EntityOverlay>;
  addedEntities: DataEntity[];
  migrationOps?: MigrationOp[];
}

// Per-PR feature list (docs touched by this PR); lives on OverlayManifest so the base
// analysis prefix stays PR-agnostic. Optional so pre-feature-docs overlay manifests on
// disk still parse (treated as an empty list).
export interface FeatureListItem {
  slug: string;
  title: string;
  direct: boolean;
  shared: boolean;
}

export interface OverlayManifest {
  pr: { number: number; title: string; baseSha: string; headSha: string; author: string; url: string };
  touchedTiles: Record<string, { status: string; counts: { added: number; modified: number; removed: number } }>;
  features?: FeatureListItem[];
  summaryUri: string;
}

// ---------- Feature docs (triptych "Flows" tab: before/after documentation) ----------
// Hand-mirrored from packages/core/src/schemas.ts — keep in lockstep.

/** Base narrative section (merge-base state, no PR annotations). */
export interface DocSection {
  id: string; // stable slug within the doc (fixed across PRs at the same base)
  ordinal: number;
  heading: string;
  files: string[];
  overview: string; // "What happens" markdown (may be empty)
  importantDetail: string; // callout (may be empty)
}

/** analysis/{owner}/{repo}/{baseSha}/docs/feature:<slug>.json — reusable across PRs. */
export interface FeatureDoc {
  slug: string;
  title: string;
  purpose: string;
  atAGlance: string; // RAW ascii, render in <pre> (may be "")
  coreModel: string[];
  sections: DocSection[];
  summary: string;
}

export interface FeatureDocSectionChange {
  change: "added" | "changed" | "removed";
  changeNarrative: string; // before → after prose (may be empty)
  files: string[];
  hunkRefs: HunkRef[];
}

/** pr/{owner}/{repo}/{n}/{headSha}/overlays/feature:<slug>.json — PR change layer. */
export interface FeatureDocOverlay {
  slug: string;
  // sectionId -> change; sections absent here render unchanged. Keys may reference base
  // doc sections OR addedSections ids (every added section has a change:"added" entry).
  sectionChanges: Record<string, FeatureDocSectionChange>;
  addedSections: DocSection[];
}

const tf = (tileId: string) => tileId.replaceAll("/", "__");
/** Filename stem for a feature doc / overlay: "feature:<slug>" with tile "/"→"__" escaping. */
const ff = (slug: string) => tf(`feature:${slug}`);

/** Feature ids carry a "feature:" prefix, mirroring the "flow:" prefix they replace. */
export function isFeatureId(id: string): boolean {
  return id.startsWith("feature:");
}

/** slug portion of a "feature:<slug>" tile id (returns the id unchanged if unprefixed). */
export function featureSlug(id: string): string {
  return id.startsWith("feature:") ? id.slice("feature:".length) : id;
}

/**
 * Merged, ordinal-sorted section list for a feature doc: base sections followed by the
 * overlay's net-new sections. The change for a section (if any) is `sectionChanges[id]`.
 */
export function mergeDocSections(
  doc: FeatureDoc | null | undefined,
  overlay: FeatureDocOverlay | null | undefined,
): DocSection[] {
  const merged = [...(doc?.sections ?? []), ...(overlay?.addedSections ?? [])];
  return merged.sort((a, b) => a.ordinal - b.ordinal);
}

export const keys = {
  reviews: () => ["reviews"] as const,
  openPrs: (owner: string, repo: string) => ["openPrs", owner, repo] as const,
  analyzeJob: (owner: string, repo: string, prNumber: number) =>
    ["analyzeJob", owner, repo, prNumber] as const,
  manifest: (r: Review) => ["manifest", r.owner, r.repo, r.baseSha] as const,
  tile: (r: Review, tileId: string) => ["tile", r.owner, r.repo, r.baseSha, tileId] as const,
  tileMd: (r: Review, tileId: string) => ["tileMd", r.owner, r.repo, r.baseSha, tileId] as const,
  overlayManifest: (r: Review) => ["ovm", r.owner, r.repo, r.prNumber, r.headSha] as const,
  overlay: (r: Review, tileId: string) => ["ov", r.owner, r.repo, r.prNumber, r.headSha, tileId] as const,
  overlayMd: (r: Review, tileId: string) => ["ovmd", r.owner, r.repo, r.prNumber, r.headSha, tileId] as const,
  prSummary: (r: Review) => ["prsum", r.owner, r.repo, r.prNumber, r.headSha] as const,
  patch: (r: Review, uri: string) => ["patch", r.owner, r.repo, r.prNumber, r.headSha, uri] as const,
  prMeta: (r: Review) => ["prMeta", r.owner, r.repo, r.prNumber] as const,
  data: (r: Review) => ["data", r.owner, r.repo, r.baseSha] as const,
  dataOverlay: (r: Review) => ["dataOv", r.owner, r.repo, r.prNumber, r.headSha] as const,
  featureDoc: (r: Review, slug: string) => ["featureDoc", r.owner, r.repo, r.baseSha, slug] as const,
  featureDocOverlay: (r: Review, slug: string) =>
    ["featureDocOv", r.owner, r.repo, r.prNumber, r.headSha, slug] as const,
};

const aPrefix = (r: Review) => `analysis/${r.owner}/${r.repo}/${r.baseSha}`;
const pPrefix = (r: Review) => `pr/${r.owner}/${r.repo}/${r.prNumber}/${r.headSha}`;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

async function fetchTextOrNull(url: string): Promise<string | null> {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

async function fetchJsonOrNull<T>(url: string): Promise<T | null> {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

export const api = {
  reviews: () => fetchJson<Review[]>("/api/reviews"),
  openPrs: async (owner: string, repo: string): Promise<PrListItem[]> => {
    const res = await fetch(`/api/prs/${owner}/${repo}`);
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `failed (${res.status})`);
    return res.json();
  },
  startAnalysis: async (owner: string, repo: string, prNumber: number): Promise<{ state: JobState }> => {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner, repo, prNumber }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `failed (${res.status})`);
    return res.json();
  },
  analyzeJob: (owner: string, repo: string, prNumber: number) =>
    fetchJsonOrNull<AnalyzeJob>(`/api/analyze/${owner}/${repo}/${prNumber}`),
  manifest: (r: Review) => fetchJson<AnalysisManifest>(`/api/artifacts/${aPrefix(r)}/manifest.json`),
  tile: (r: Review, tileId: string) =>
    fetchJson<Tile>(`/api/artifacts/${aPrefix(r)}/tiles/${tf(tileId)}.json`),
  tileMd: (r: Review, tileId: string) =>
    fetchText(`/api/artifacts/${aPrefix(r)}/tiles/${tf(tileId)}.md`),
  overlayManifest: (r: Review) =>
    fetchJson<OverlayManifest>(`/api/artifacts/${pPrefix(r)}/overlay-manifest.json`),
  overlay: (r: Review, tileId: string) =>
    fetchJsonOrNull<TileOverlay>(`/api/artifacts/${pPrefix(r)}/overlays/${tf(tileId)}.json`),
  overlayMd: (r: Review, tileId: string) =>
    fetchTextOrNull(`/api/artifacts/${pPrefix(r)}/overlays/${tf(tileId)}.md`),
  prSummary: (r: Review) =>
    fetchText(`/api/artifacts/${pPrefix(r)}/overlays/pr-summary.md`),
  patch: (r: Review, patchUri: string) =>
    fetchText(`/api/artifacts/${pPrefix(r)}/${patchUri}`),
  prMeta: (r: Review) => fetchJson<PrMeta>(`/api/pr/${r.owner}/${r.repo}/${r.prNumber}`),
  data: (r: Review) => fetchJsonOrNull<DataArtifact>(`/api/artifacts/${aPrefix(r)}/data.json`),
  dataOverlay: (r: Review) => fetchJsonOrNull<DataOverlay>(`/api/artifacts/${pPrefix(r)}/data-overlay.json`),
  // Base doc must exist for any feature in the manifest; the PR overlay may be absent
  // (additive base cache: a base doc can outlive the PR that has an overlay for it).
  featureDoc: (r: Review, slug: string) =>
    fetchJson<FeatureDoc>(`/api/artifacts/${aPrefix(r)}/docs/${ff(slug)}.json`),
  featureDocOverlay: (r: Review, slug: string) =>
    fetchJsonOrNull<FeatureDocOverlay>(`/api/artifacts/${pPrefix(r)}/overlays/${ff(slug)}.json`),
  postComment: async (r: Review, body: string): Promise<PrComment> => {
    const res = await fetch(`/api/pr/${r.owner}/${r.repo}/${r.prNumber}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `post failed (${res.status})`);
    return res.json();
  },
};

/** immutable, SHA-keyed artifacts: staleTime Infinity; gcTime is the eviction policy */
export const queryDefaults = {
  staleTime: Infinity,
  gcTime: 5 * 60 * 1000,
} as const;

export function prefetchTile(qc: QueryClient, r: Review, tileId: string): void {
  qc.prefetchQuery({ queryKey: keys.tile(r, tileId), queryFn: () => api.tile(r, tileId), ...queryDefaults });
  qc.prefetchQuery({ queryKey: keys.tileMd(r, tileId), queryFn: () => api.tileMd(r, tileId), ...queryDefaults });
  qc.prefetchQuery({ queryKey: keys.overlay(r, tileId), queryFn: () => api.overlay(r, tileId), ...queryDefaults });
  qc.prefetchQuery({ queryKey: keys.overlayMd(r, tileId), queryFn: () => api.overlayMd(r, tileId), ...queryDefaults });
}

/** prefetch the base data artifact + PR data overlay when entering the Data tab */
export function prefetchData(qc: QueryClient, r: Review): void {
  qc.prefetchQuery({ queryKey: keys.data(r), queryFn: () => api.data(r), ...queryDefaults });
  qc.prefetchQuery({ queryKey: keys.dataOverlay(r), queryFn: () => api.dataOverlay(r), ...queryDefaults });
}

/** prefetch a feature's base doc + PR doc overlay (used in place of prefetchTile for features) */
export function prefetchFeatureDoc(qc: QueryClient, r: Review, slug: string): void {
  qc.prefetchQuery({ queryKey: keys.featureDoc(r, slug), queryFn: () => api.featureDoc(r, slug), ...queryDefaults });
  qc.prefetchQuery({
    queryKey: keys.featureDocOverlay(r, slug),
    queryFn: () => api.featureDocOverlay(r, slug),
    ...queryDefaults,
  });
}
