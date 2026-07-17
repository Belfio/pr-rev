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

export interface AnalysisManifest {
  rootTileId: string;
  tileIds: string[];
  flows: { tileId: string; title: string }[];
  coverage: { analyzedFiles: number; eligibleFiles: number; unresolvedImports: number };
}

export interface OverlayManifest {
  pr: { number: number; title: string; baseSha: string; headSha: string; author: string; url: string };
  touchedTiles: Record<string, { status: string; counts: { added: number; modified: number; removed: number } }>;
  summaryUri: string;
}

const tf = (tileId: string) => tileId.replaceAll("/", "__");

export const keys = {
  reviews: () => ["reviews"] as const,
  manifest: (r: Review) => ["manifest", r.owner, r.repo, r.baseSha] as const,
  tile: (r: Review, tileId: string) => ["tile", r.owner, r.repo, r.baseSha, tileId] as const,
  tileMd: (r: Review, tileId: string) => ["tileMd", r.owner, r.repo, r.baseSha, tileId] as const,
  overlayManifest: (r: Review) => ["ovm", r.owner, r.repo, r.prNumber, r.headSha] as const,
  overlay: (r: Review, tileId: string) => ["ov", r.owner, r.repo, r.prNumber, r.headSha, tileId] as const,
  overlayMd: (r: Review, tileId: string) => ["ovmd", r.owner, r.repo, r.prNumber, r.headSha, tileId] as const,
  prSummary: (r: Review) => ["prsum", r.owner, r.repo, r.prNumber, r.headSha] as const,
  patch: (r: Review, uri: string) => ["patch", r.owner, r.repo, r.prNumber, r.headSha, uri] as const,
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
