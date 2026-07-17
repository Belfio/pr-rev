import type { Tile, TileNode, TileEdge } from "../schemas.js";
import { tileFileName } from "../schemas.js";
import type { ImportGraph } from "./imports.js";
import path from "node:path";

const MAX_CHILDREN = 29; // +1 "other" cluster = 30 node cap
const INLINE_THRESHOLD = 3; // dirs with fewer files than this (and no subdirs) inline into parent

interface DirNode {
  name: string; // display segment, e.g. "packages/api" after chain collapse
  dirPath: string; // repo-relative dir ("" = root)
  subdirs: DirNode[];
  files: string[]; // repo-relative file paths directly in this dir (post-inlining)
  totalFiles: number;
}

export interface TileBuild {
  tiles: Tile[]; // layout positions are zeroed; layout step fills them
  /** file -> [{tileId, nodeId}] at every hierarchy level containing it */
  fileToNodes: Map<string, { tileId: string; nodeId: string }[]>;
  /** repo-relative dir path -> tileId rendering that dir (for routing PR-added files) */
  dirToTile: Map<string, string>;
  rootTileId: string;
}

export function buildDirTree(files: string[]): DirNode {
  const root: DirNode = { name: "", dirPath: "", subdirs: [], files: [], totalFiles: 0 };
  const dirMap = new Map<string, DirNode>([["", root]]);

  const getDir = (dirPath: string): DirNode => {
    const existing = dirMap.get(dirPath);
    if (existing) return existing;
    const parent = getDir(path.dirname(dirPath) === "." ? "" : path.dirname(dirPath));
    const node: DirNode = {
      name: path.basename(dirPath),
      dirPath,
      subdirs: [],
      files: [],
      totalFiles: 0,
    };
    parent.subdirs.push(node);
    dirMap.set(dirPath, node);
    return node;
  };

  for (const f of files) {
    const dir = path.dirname(f) === "." ? "" : path.dirname(f);
    getDir(dir).files.push(f);
  }
  countFiles(root);
  collapseChains(root);
  inlineTinyDirs(root);
  countFiles(root);
  return root;
}

function countFiles(n: DirNode): number {
  n.totalFiles = n.files.length + n.subdirs.reduce((acc, c) => acc + countFiles(c), 0);
  return n.totalFiles;
}

/** dir with no files and exactly one subdir merges into "a/b" */
function collapseChains(n: DirNode): void {
  for (const c of n.subdirs) collapseChains(c);
  n.subdirs = n.subdirs.map((c) => {
    while (c.files.length === 0 && c.subdirs.length === 1) {
      const only = c.subdirs[0]!;
      only.name = `${c.name}/${only.name}`;
      c = only;
    }
    return c;
  });
}

function inlineTinyDirs(n: DirNode): void {
  for (const c of n.subdirs) inlineTinyDirs(c);
  const keep: DirNode[] = [];
  for (const c of n.subdirs) {
    if (c.subdirs.length === 0 && c.files.length < INLINE_THRESHOLD) {
      n.files.push(...c.files);
    } else {
      keep.push(c);
    }
  }
  n.subdirs = keep;
}

/** slug for a dir segment usable inside a tileId: "packages/api" -> "packages.api" */
function seg(name: string): string {
  return name.replaceAll("/", ".").replaceAll(/[^a-zA-Z0-9._-]/g, "_");
}

export function buildTiles(
  tree: DirNode,
  graph: ImportGraph,
  repo: { owner: string; name: string; commitSha: string },
  coverage: { analyzedFiles: number; eligibleFiles: number; unresolvedImports: number },
): TileBuild {
  const tiles: Tile[] = [];
  const fileToNodes = new Map<string, { tileId: string; nodeId: string }[]>();
  const dirToTile = new Map<string, string>();

  const record = (file: string, tileId: string, nodeId: string) => {
    if (!fileToNodes.has(file)) fileToNodes.set(file, []);
    fileToNodes.get(file)!.push({ tileId, nodeId });
  };

  interface Child {
    nodeId: string;
    label: string;
    kind: "module" | "file" | "cluster";
    files: string[]; // all descendant files (for edge mapping + index)
    dir?: DirNode; // present for module children
    clusterMembers?: DirNode[]; // present for "other" cluster
    loc: number;
  }

  const makeTile = (
    dir: DirNode,
    tileId: string,
    title: string,
    parentTileId: string | null,
    breadcrumbs: { tileId: string; title: string }[],
    extraDirs?: DirNode[], // for overflow tiles: render these dirs instead of dir's own children
  ): void => {
    const subdirs = extraDirs ?? dir.subdirs;
    const ownFiles = extraDirs ? [] : dir.files;
    if (!extraDirs && !dirToTile.has(dir.dirPath)) dirToTile.set(dir.dirPath, tileId);

    let children: Child[] = [
      ...subdirs.map((d): Child => ({
        nodeId: `n:${seg(d.name)}`,
        label: d.name,
        kind: "module" as const,
        files: allFiles(d),
        dir: d,
        loc: 0,
      })),
      ...ownFiles.map((f): Child => ({
        nodeId: `n:${seg(path.basename(f))}`,
        label: path.basename(f),
        kind: "file" as const,
        files: [f],
        loc: 0,
      })),
    ];

    // dedupe accidental nodeId collisions
    const seen = new Map<string, number>();
    for (const c of children) {
      const k = c.nodeId;
      const count = seen.get(k) ?? 0;
      if (count > 0) c.nodeId = `${k}~${count}`;
      seen.set(k, count + 1);
    }

    // cap with "other" cluster (largest children stay visible)
    children.sort((a, b) => b.files.length - a.files.length);
    let cluster: Child | null = null;
    if (children.length > MAX_CHILDREN + 1) {
      const overflow = children.slice(MAX_CHILDREN);
      const overflowDirs = overflow.filter((c) => c.dir).map((c) => c.dir!);
      const overflowFiles = overflow.flatMap((c) => c.files);
      cluster = {
        nodeId: "n:other",
        label: `other (${overflow.length})`,
        kind: "cluster",
        files: overflowFiles,
        clusterMembers: overflowDirs,
        loc: 0,
      };
      children = [...children.slice(0, MAX_CHILDREN), cluster];
    }

    // edges: aggregate file imports to child granularity
    const owner = new Map<string, string>(); // file -> nodeId within this tile
    for (const c of children) for (const f of c.files) owner.set(f, c.nodeId);
    const weights = new Map<string, number>();
    for (const [src, targets] of graph.edges) {
      const a = owner.get(src);
      if (!a) continue;
      for (const t of targets) {
        const b = owner.get(t);
        if (!b || a === b) continue;
        const k = `${a}->${b}`;
        weights.set(k, (weights.get(k) ?? 0) + 1);
      }
    }
    let edges: TileEdge[] = [...weights.entries()].map(([k, weight]) => {
      const [source, target] = k.split("->") as [string, string];
      return { id: `e:${k}`, source, target, kind: "import" as const, weight };
    });
    if (edges.length > 80) {
      edges.sort((a, b) => b.weight - a.weight);
      edges = edges.slice(0, 80);
    }

    const nodes: TileNode[] = children.map((c) => {
      const childTileId =
        c.kind === "file"
          ? null
          : c.kind === "cluster"
            ? c.clusterMembers && c.clusterMembers.length > 0
              ? `${tileId}/other`
              : null
            : c.files.length > 1 || (c.dir && c.dir.subdirs.length > 0)
              ? `${tileId}/${seg(c.dir!.name)}`
              : null;
      for (const f of c.files) record(f, tileId, c.nodeId);
      return {
        id: c.nodeId,
        kind: c.kind,
        label: c.label,
        summary: null,
        anchors:
          c.kind === "file"
            ? [{ file: c.files[0]!, startLine: 1, endLine: 1 }]
            : c.dir
              ? [{ file: c.dir.dirPath || ".", startLine: 0, endLine: 0 }]
              : [],
        childTileId,
        stats: { files: c.files.length, loc: c.loc },
        pos: { x: 0, y: 0, w: 0, h: 0 },
      };
    });

    tiles.push({
      schemaVersion: 1,
      tileId,
      kind: "module-map",
      title,
      parentTileId,
      breadcrumbs,
      repo,
      coverage,
      nodes,
      edges,
      explanation: { uri: `tiles/${tileFileName(tileId)}.md` },
    });

    const crumbs = [...breadcrumbs, { tileId, title }];
    for (const c of children) {
      if (c.kind === "module" && c.dir) {
        const childId = `${tileId}/${seg(c.dir.name)}`;
        if (nodes.find((n) => n.id === c.nodeId)?.childTileId === childId) {
          makeTile(c.dir, childId, c.dir.name, tileId, crumbs);
        }
      } else if (c.kind === "cluster" && c.clusterMembers && c.clusterMembers.length > 0) {
        const childId = `${tileId}/other`;
        const synthetic: DirNode = {
          name: "other",
          dirPath: dir.dirPath,
          subdirs: c.clusterMembers,
          files: [],
          totalFiles: c.files.length,
        };
        makeTile(synthetic, childId, `${title} — other`, tileId, crumbs);
      }
    }
  };

  const rootTitle = `${repo.owner}/${repo.name}`;
  makeTile(tree, "root", rootTitle, null, []);
  return { tiles, fileToNodes, dirToTile, rootTileId: "root" };
}

function allFiles(d: DirNode): string[] {
  return [...d.files, ...d.subdirs.flatMap(allFiles)];
}
