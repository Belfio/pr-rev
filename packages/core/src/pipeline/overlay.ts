import type { PrInfo, PrFile } from "./github.js";
import type { TileBuild } from "./tiles.js";
import type { TileOverlay, OverlayManifest, TileNode, HunkRef, OverlayNode } from "../schemas.js";
import { escapePath, tileFileName } from "../schemas.js";
import path from "node:path";

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(patch))) {
    hunks.push({
      oldStart: Number(m[1]),
      oldLines: m[2] ? Number(m[2]) : 1,
      newStart: Number(m[3]),
      newLines: m[4] ? Number(m[4]) : 1,
    });
  }
  return hunks;
}

export interface OverlayBuild {
  manifest: OverlayManifest;
  overlays: Map<string, TileOverlay>; // tileId -> overlay
  patches: Map<string, string>; // escaped filename -> patch text
}

/**
 * The PR's changes to one file as a single HunkRef (spanning all its hunks),
 * pointing at the on-disk patch. Shared with the feature-doc pipeline so doc
 * section changes reference the exact same patch files as tile overlays.
 */
export function hunkRefFor(f: PrFile): HunkRef[] {
  if (!f.patch) return [];
  const hunks = parseHunks(f.patch);
  if (hunks.length === 0) return [];
  const first = hunks[0]!;
  const last = hunks[hunks.length - 1]!;
  return [
    {
      file: f.filename,
      patchUri: `patches/${escapePath(f.filename)}.patch`,
      hunkIndices: hunks.map((_, i) => i),
      oldRange: [first.oldStart, last.oldStart + last.oldLines],
      newRange: [first.newStart, last.newStart + last.newLines],
    },
  ];
}

type Status = "added" | "modified" | "removed" | "renamed";

function normalizeStatus(s: PrFile["status"]): Status | null {
  if (s === "added" || s === "copied") return "added";
  if (s === "removed") return "removed";
  if (s === "renamed") return "renamed";
  if (s === "modified" || s === "changed") return "modified";
  return null;
}

/** ancestors of "root/a/b" = ["root", "root/a", "root/a/b"] */
function tileAncestry(tileId: string): string[] {
  const parts = tileId.split("/");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

export function buildOverlay(pr: PrInfo, build: TileBuild): OverlayBuild {
  const overlays = new Map<string, TileOverlay>();
  const patches = new Map<string, string>();
  const counts = new Map<string, { added: number; modified: number; removed: number }>();

  const overlay = (tileId: string): TileOverlay => {
    if (!overlays.has(tileId)) {
      overlays.set(tileId, {
        tileId,
        nodes: {},
        addedNodes: [],
        addedEdges: [],
        removedNodeIds: [],
        explanationUri: `overlays/${tileFileName(tileId)}.md`,
      });
    }
    return overlays.get(tileId)!;
  };

  const bump = (tileId: string, key: Status) => {
    const k = key === "renamed" ? "modified" : key;
    for (const id of tileAncestry(tileId)) {
      if (!counts.has(id)) counts.set(id, { added: 0, modified: 0, removed: 0 });
      counts.get(id)![k]++;
    }
  };

  const setNode =(tileId: string, nodeId: string, patch: Partial<OverlayNode> & { status: Status }) => {
    const o = overlay(tileId);
    const existing = o.nodes[nodeId];
    if (existing) {
      // module node aggregating multiple changed files: keep "modified", merge hunkRefs
      existing.hunkRefs.push(...(patch.hunkRefs ?? []));
      if (existing.status !== patch.status) existing.status = "modified";
    } else {
      o.nodes[nodeId] = {
        status: patch.status,
        renamedFrom: patch.renamedFrom ?? null,
        changeSummary: null,
        hunkRefs: patch.hunkRefs ?? [],
      };
    }
  };

  for (const f of pr.files) {
    const status = normalizeStatus(f.status);
    if (!status) continue;
    if (f.patch) patches.set(escapePath(f.filename), f.patch);

    const lookupPath =status === "renamed" && f.previousFilename ? f.previousFilename : f.filename;
    const entries = build.fileToNodes.get(lookupPath);

    if (entries && entries.length > 0) {
      const refs = hunkRefFor(f);
      const deepest = entries[entries.length - 1]!;
      for (const { tileId, nodeId } of entries) {
        const isFileNode = tileId === deepest.tileId && nodeId === deepest.nodeId;
        if (status === "removed" && isFileNode) {
          overlay(tileId).removedNodeIds.push(nodeId);
        } else {
          setNode(tileId, nodeId, {
            status: isFileNode ? status : "modified",
            renamedFrom: isFileNode && status === "renamed" ? f.previousFilename : null,
            hunkRefs: refs,
          });
        }
      }
      bump(deepest.tileId, status);
    } else {
      // file unknown to base analysis (added, or non-code file): route by directory walk
      let dir = path.dirname(f.filename);
      if (dir === ".") dir = "";
      let tileId: string | undefined;
      while (true) {
        tileId = build.dirToTile.get(dir);
        if (tileId !== undefined) break;
        if (dir === "") break;
        const parent = path.dirname(dir);
        dir = parent === "." ? "" : parent;
      }
      const target = tileId ?? build.rootTileId;
      const node: TileNode = {
        id: `n:new:${escapePath(f.filename)}`,
        kind: "file",
        label: path.basename(f.filename),
        summary: null,
        anchors: [{ file: f.filename, startLine: 1, endLine: 1 }],
        childTileId: null,
        stats: { files: 1, loc: 0 },
        pos: { x: 0, y: 0, w: 0, h: 0 }, // frontend lays added nodes in a band
      };
      const o = overlay(target);
      o.addedNodes.push(node);
      o.nodes[node.id] = {
        status, // real status — files outside the base code analysis can be modified/removed too
        renamedFrom: status === "renamed" ? f.previousFilename : null,
        changeSummary: null,
        hunkRefs: hunkRefFor(f),
      };
      bump(target, status);
      // mark ancestor container nodes as modified so highlighting propagates
      const ancestry = tileAncestry(target);
      for (let i = 0; i < ancestry.length - 1; i++) {
        const parentTile = ancestry[i]!;
        const childTile = ancestry[i + 1]!;
        // container node ids follow the tileId naming convention: "root/a/b" is owned by node "n:b" in "root/a"
        const childSeg = childTile.split("/").pop()!;
        setNode(parentTile, `n:${childSeg}`, { status: "modified", hunkRefs: [] });
      }
    }
  }

  const touchedTiles: OverlayManifest["touchedTiles"] = {};
  for (const [tileId, c] of counts) {
    touchedTiles[tileId] = { status: "modified", counts: c };
  }

  return {
    manifest: {
      pr: {
        number: pr.number,
        title: pr.title,
        baseSha: pr.mergeBaseSha,
        headSha: pr.headSha,
        author: pr.author,
        url: pr.url,
      },
      touchedTiles,
      features: [], // populated by the feature-doc pipeline (run.ts)
      summaryUri: "overlays/pr-summary.md",
    },
    overlays,
    patches,
  };
}
