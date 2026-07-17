import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  useReactFlow,
  ReactFlowProvider,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, keys, prefetchTile, queryDefaults } from "../lib/api";
import type { Review, Tile, TileOverlay, TileNode, OverlayManifest } from "../lib/api";
import { useUi } from "../state/store";

const KIND_ICON: Record<string, string> = {
  module: "▣",
  file: "▤",
  cluster: "⊞",
  service: "◈",
  function: "ƒ",
  datastore: "⛁",
  external: "☁",
};

type FlowNodeData = {
  tileNode: TileNode;
  status: string | null;
  changeCount: number;
  isRemoved: boolean;
  isNew: boolean;
};

function TileNodeView({ data, selected }: NodeProps<Node<FlowNodeData>>) {
  const { tileNode, status, isRemoved, isNew } = data;
  const cls = [
    "tile-node",
    status ? `status-${status}` : "",
    isRemoved ? "status-removed" : "",
    isNew && !status ? "status-added" : "",
    tileNode.childTileId ? "drillable" : "",
    selected ? "selected" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls} style={{ width: tileNode.pos.w || 170, minHeight: tileNode.pos.h || 64 }}>
      <Handle type="target" position={Position.Left} className="handle" />
      <div className="node-head">
        <span className="node-icon">{KIND_ICON[tileNode.kind] ?? "▪"}</span>
        <span className="node-label" title={tileNode.label}>
          {tileNode.label}
        </span>
        {tileNode.childTileId && <span className="drill-hint">⤵</span>}
      </div>
      <div className="node-sub">
        {status && <span className={`badge badge-${status}`}>{status}</span>}
        {tileNode.stats.files > 1 && <span className="node-files">{tileNode.stats.files} files</span>}
      </div>
      <Handle type="source" position={Position.Right} className="handle" />
    </div>
  );
}

const nodeTypes = { tile: TileNodeView };

function DiagramInner({ review }: { review: Review }) {
  const qc = useQueryClient();
  const { tileId, selectedNodeId, navigateTile, selectNode, setTransitioning, transitioning } = useUi();
  const { fitView, getNode } = useReactFlow();
  const pendingNav = useRef<string | null>(null);

  const tileQ = useQuery({ queryKey: keys.tile(review, tileId), queryFn: () => api.tile(review, tileId), ...queryDefaults });
  const overlayQ = useQuery({ queryKey: keys.overlay(review, tileId), queryFn: () => api.overlay(review, tileId), ...queryDefaults });
  const manifestQ = useQuery({
    queryKey: keys.overlayManifest(review),
    queryFn: () => api.overlayManifest(review),
    ...queryDefaults,
  });

  const tile = tileQ.data;
  const overlay = overlayQ.data ?? null;
  const manifest = manifestQ.data ?? null;

  const { nodes, edges } = useMemo(
    () => (tile ? toFlow(tile, overlay, manifest) : { nodes: [], edges: [] }),
    [tile, overlay, manifest],
  );

  // prefetch children of PR-touched nodes when idle — the paths a reviewer will walk
  useEffect(() => {
    if (!tile) return;
    const cb = () => {
      for (const n of tile.nodes) {
        if (n.childTileId && (overlay?.nodes[n.id] || manifest?.touchedTiles[n.childTileId])) {
          prefetchTile(qc, review, n.childTileId);
        }
      }
    };
    const id = "requestIdleCallback" in window ? requestIdleCallback(cb) : setTimeout(cb, 400);
    return () => ("requestIdleCallback" in window ? cancelIdleCallback(id as number) : clearTimeout(id as number));
  }, [tile, overlay, manifest, qc, review]);

  useEffect(() => {
    // after tile swap, fade back in and fit
    if (transitioning === "out" && tile) {
      requestAnimationFrame(() => {
        fitView({ padding: 0.15, duration: 220 });
        setTransitioning("in");
        setTimeout(() => setTransitioning(null), 240);
      });
    }
  }, [tileId, tile]); // eslint-disable-line react-hooks/exhaustive-deps

  const drillInto = useCallback(
    (nodeId: string, childTileId: string) => {
      prefetchTile(qc, review, childTileId);
      pendingNav.current = childTileId;
      setTransitioning("out");
      const n = getNode(nodeId);
      if (n) {
        fitView({ nodes: [{ id: nodeId }], padding: 0.05, duration: 180 });
      }
      setTimeout(() => {
        if (pendingNav.current) {
          navigateTile(pendingNav.current);
          pendingNav.current = null;
        }
      }, 180);
    },
    [qc, review, navigateTile, setTransitioning, fitView, getNode],
  );

  // selection re-renders replace React Flow's node DOM, which breaks native dblclick
  // pairing — so detect double-clicks ourselves from click timestamps.
  const lastClick = useRef<{ id: string; t: number }>({ id: "", t: 0 });
  const onNodeClick = useCallback(
    (_: unknown, node: Node) => {
      const now = Date.now();
      const child = (node.data as FlowNodeData).tileNode.childTileId;
      if (child && lastClick.current.id === node.id && now - lastClick.current.t < 400) {
        lastClick.current = { id: "", t: 0 };
        drillInto(node.id, child);
        return;
      }
      lastClick.current = { id: node.id, t: now };
      selectNode(node.id === selectedNodeId ? null : node.id);
    },
    [selectNode, selectedNodeId, drillInto],
  );

  const onNodeMouseEnter = useCallback(
    (_: unknown, node: Node) => {
      const child = (node.data as FlowNodeData).tileNode.childTileId;
      if (child) prefetchTile(qc, review, child);
    },
    [qc, review],
  );

  if (tileQ.isLoading) return <div className="pane-loading">loading tile…</div>;
  if (tileQ.isError || !tile) return <div className="pane-loading">tile failed to load</div>;

  return (
    <div className={`diagram-wrap ${transitioning === "out" ? "fade-out" : transitioning === "in" ? "fade-in" : ""}`}>
      <Breadcrumbs tile={tile} manifest={manifest} onNavigate={(id) => { setTransitioning("out"); setTimeout(() => navigateTile(id), 140); }} />
      <ReactFlow
        nodes={nodes.map((n) => ({ ...n, selected: n.id === selectedNodeId }))}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onNodeMouseEnter={onNodeMouseEnter}
        zoomOnDoubleClick={false}
        onPaneClick={() => selectNode(null)}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
      >
        <Background gap={24} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
      {tile.coverage.unresolvedImports > 0 && (
        <div className="coverage-note" title="Imports the static analyzer could not resolve — some edges may be missing.">
          ⚠ {tile.coverage.unresolvedImports} unresolved imports — some edges may be missing
        </div>
      )}
    </div>
  );
}

function Breadcrumbs({
  tile,
  manifest,
  onNavigate,
}: {
  tile: Tile;
  manifest: OverlayManifest | null;
  onNavigate: (tileId: string) => void;
}) {
  const trail = [...tile.breadcrumbs, { tileId: tile.tileId, title: tile.title }];
  return (
    <div className="breadcrumbs">
      {trail.map((b, i) => {
        const touched = manifest?.touchedTiles[b.tileId];
        const last = i === trail.length - 1;
        return (
          <span key={b.tileId} className="crumb-wrap">
            {i > 0 && <span className="crumb-sep">›</span>}
            <button className={`crumb ${last ? "crumb-current" : ""}`} disabled={last} onClick={() => onNavigate(b.tileId)}>
              {b.title}
              {touched && <span className="crumb-badge">{touched.counts.added + touched.counts.modified + touched.counts.removed}</span>}
            </button>
          </span>
        );
      })}
    </div>
  );
}

function toFlow(
  tile: Tile,
  overlay: TileOverlay | null,
  manifest: OverlayManifest | null,
): { nodes: Node<FlowNodeData>[]; edges: Edge[] } {
  const nodes: Node<FlowNodeData>[] = tile.nodes.map((n) => {
    const ov = overlay?.nodes[n.id];
    const childTouched = n.childTileId ? manifest?.touchedTiles[n.childTileId] : undefined;
    const removed = overlay?.removedNodeIds.includes(n.id) ?? false;
    return {
      id: n.id,
      type: "tile",
      position: { x: n.pos.x, y: n.pos.y },
      data: {
        tileNode: n,
        status: ov?.status ?? (childTouched ? "modified" : null),
        changeCount: childTouched ? childTouched.counts.added + childTouched.counts.modified + childTouched.counts.removed : 0,
        isRemoved: removed,
        isNew: false,
      },
    };
  });

  // PR-added nodes: reserved band beneath the laid-out diagram (no client layout)
  if (overlay && overlay.addedNodes.length > 0) {
    const maxY = Math.max(0, ...tile.nodes.map((n) => n.pos.y + n.pos.h));
    overlay.addedNodes.forEach((n, i) => {
      const status = overlay.nodes[n.id]?.status ?? "added";
      nodes.push({
        id: n.id,
        type: "tile",
        position: { x: 20 + (i % 4) * 200, y: maxY + 80 + Math.floor(i / 4) * 90 },
        data: {
          tileNode: { ...n, pos: { ...n.pos, w: 180, h: 64 } },
          status,
          changeCount: 0,
          isRemoved: status === "removed",
          isNew: true,
        },
      });
    });
  }

  const maxWeight = Math.max(1, ...tile.edges.map((e) => e.weight));
  const edges: Edge[] = tile.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    className: "flow-edge",
    style: { strokeWidth: 1 + (e.weight / maxWeight) * 3 },
    label: e.weight > 1 ? String(e.weight) : undefined,
  }));
  for (const e of overlay?.addedEdges ?? []) {
    edges.push({ id: e.id, source: e.source, target: e.target, className: "flow-edge edge-added", style: { strokeWidth: 2 } });
  }
  return { nodes, edges };
}

export function DiagramPane({ review }: { review: Review }) {
  return (
    <ReactFlowProvider>
      <DiagramInner review={review} />
    </ReactFlowProvider>
  );
}
