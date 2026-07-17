import ELK from "elkjs/lib/elk.bundled.js";
import type { Tile } from "../schemas.js";

const elk = new ELK();

export async function layoutTile(tile: Tile): Promise<void> {
  const nodeSize = (label: string) => ({
    width: Math.max(150, Math.min(280, 40 + label.length * 8.5)),
    height: 64,
  });

  const isFlow = tile.kind === "flow";
  const graph = {
    id: "g",
    layoutOptions: {
      "elk.algorithm": "layered",
      // flowcharts read top-down; structure maps read left-right
      "elk.direction": isFlow ? "DOWN" : "RIGHT",
      "elk.spacing.nodeNode": isFlow ? "48" : "36",
      "elk.layered.spacing.nodeNodeBetweenLayers": isFlow ? "56" : "72",
    },
    children: tile.nodes.map((n) => ({ id: n.id, ...nodeSize(n.label) })),
    edges: tile.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };

  const res = await elk.layout(graph);
  const byId = new Map(res.children?.map((c) => [c.id, c]) ?? []);
  for (const n of tile.nodes) {
    const c = byId.get(n.id);
    n.pos = {
      x: Math.round(c?.x ?? 0),
      y: Math.round(c?.y ?? 0),
      w: Math.round(c?.width ?? 150),
      h: Math.round(c?.height ?? 64),
    };
  }
}
