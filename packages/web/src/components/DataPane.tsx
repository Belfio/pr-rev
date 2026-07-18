import { useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  ReactFlowProvider,
  Handle,
  Position,
  MarkerType,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useQuery } from "@tanstack/react-query";
import { api, keys, queryDefaults } from "../lib/api";
import type { Review, DataArtifact, DataOverlay, DataEntity, EntityOverlay, FieldOverlay } from "../lib/api";
import { dataFixture, dataOverlayFixture } from "../fixtures/data-fixture";
import { useUi } from "../state/store";

const PROVENANCE_ICON: Record<string, string> = {
  "generated-db": "⛁",
  "app-type": "☰",
  migration: "⚑",
};
const PROVENANCE_CHIP: Record<string, string> = {
  "generated-db": "db",
  "app-type": "type",
  migration: "migration",
};

const FIELD_CAP = 14;

/** Shared hook: base data artifact + PR overlay, with a dev-only fixture fallback. */
export function useDataArtifacts(review: Review): {
  data: DataArtifact | null;
  overlay: DataOverlay | null;
  isFixture: boolean;
  isLoading: boolean;
} {
  const dataQ = useQuery({ queryKey: keys.data(review), queryFn: () => api.data(review), ...queryDefaults });
  const overlayQ = useQuery({ queryKey: keys.dataOverlay(review), queryFn: () => api.dataOverlay(review), ...queryDefaults });

  const realData = dataQ.data ?? null;
  const realOverlay = overlayQ.data ?? null;
  // Only fall back to the fixture in dev when there's no real base artifact at all
  // (pre-pipeline). Once real data exists, a missing overlay just means "no data changes".
  const useFixture = import.meta.env.DEV && realData === null && !dataQ.isLoading;

  return {
    data: useFixture ? dataFixture : realData,
    overlay: useFixture ? dataOverlayFixture : realOverlay,
    isFixture: useFixture,
    isLoading: dataQ.isLoading,
  };
}

/** overlay entity keyed by entity id OR name (pipeline keys by symbol id; be lenient) */
// Strict id lookup only: a lenient name fallback would apply another entity's
// overlay to a same-named twin from a different file.
export function entityOverlayFor(overlay: DataOverlay | null, entity: DataEntity): EntityOverlay | undefined {
  return overlay?.entities[entity.id];
}

export type MergedField = {
  name: string;
  type: string;
  optional: boolean;
  overlay?: FieldOverlay;
};

/** union of base fields + overlay-only fields (added, or removed-and-absent-from-base) */
export function mergeFields(entity: DataEntity, ov: EntityOverlay | undefined): MergedField[] {
  const ovFields = ov?.fields ?? {};
  const rows: MergedField[] = entity.fields.map((f) => ({ ...f, overlay: ovFields[f.name] }));
  const baseNames = new Set(entity.fields.map((f) => f.name));
  for (const [name, fo] of Object.entries(ovFields)) {
    // overlay-only rows: added fields carry `type`; removed fields carry only `prevType`
    if (!baseNames.has(name)) rows.push({ name, type: fo.type ?? fo.prevType ?? "?", optional: false, overlay: fo });
  }
  // PR-touched rows first — the display cap must never hide the diff the reviewer came for
  return rows.sort((a, b) => Number(Boolean(b.overlay)) - Number(Boolean(a.overlay)));
}

type EntityNodeData = {
  entity: DataEntity;
  overlay: EntityOverlay | undefined;
  isAdded: boolean;
};

function EntityNodeView({ data, selected }: NodeProps<Node<EntityNodeData>>) {
  const { entity, overlay, isAdded } = data;
  const [expanded, setExpanded] = useState(false);
  const status = overlay?.status ?? (isAdded ? "added" : null);
  const cls = [
    "entity-node",
    status ? `status-${status}` : "",
    selected ? "selected" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const rows = entity.kind === "object" ? mergeFields(entity, overlay) : [];
  const shown = expanded ? rows : rows.slice(0, FIELD_CAP);
  const hidden = rows.length - shown.length;

  return (
    <div className={cls} style={{ width: entity.pos.w || 220 }}>
      <Handle type="target" position={Position.Left} className="handle" />
      <div className="entity-head">
        <span className="entity-icon" title={entity.provenance}>
          {PROVENANCE_ICON[entity.provenance] ?? "▪"}
        </span>
        <span className="entity-name" title={entity.name}>
          {entity.name}
        </span>
        <span className="entity-prov">{PROVENANCE_CHIP[entity.provenance] ?? entity.provenance}</span>
        {status && <span className={`badge badge-${status}`}>{status}</span>}
      </div>

      {entity.kind === "enum" ? (
        <EnumValues entity={entity} overlay={overlay} />
      ) : (
        <div className="entity-fields">
          {shown.map((f) => (
            <FieldRow key={f.name} field={f} />
          ))}
          {hidden > 0 && (
            <button className="entity-more" onClick={(e) => (e.stopPropagation(), setExpanded(true))}>
              +{hidden} more
            </button>
          )}
          {expanded && rows.length > FIELD_CAP && (
            <button className="entity-more" onClick={(e) => (e.stopPropagation(), setExpanded(false))}>
              show less
            </button>
          )}
        </div>
      )}
      <Handle type="source" position={Position.Right} className="handle" />
    </div>
  );
}

function FieldRow({ field }: { field: MergedField }) {
  const st = field.overlay?.status;
  const title =
    st === "changed" && field.overlay
      ? `${field.overlay.prevType ?? "—"} → ${field.overlay.type}`
      : undefined;
  return (
    <div className={`entity-field ${st ? `fld-${st}` : ""}`} title={title}>
      <span className="fld-name">
        {field.name}
        {field.optional && <span className="fld-opt">?</span>}
      </span>
      <span className="fld-type">{st === "changed" && field.overlay ? field.overlay.type : field.type}</span>
    </div>
  );
}

function EnumValues({ entity, overlay }: { entity: DataEntity; overlay: EntityOverlay | undefined }) {
  const removed = new Set(overlay?.valuesRemoved ?? []);
  const added = overlay?.valuesAdded ?? [];
  const base = entity.values ?? [];
  const extra = added.filter((v) => !base.includes(v));
  return (
    <div className="enum-values">
      {base.map((v) => (
        <span key={v} className={`enum-chip ${removed.has(v) ? "val-removed" : ""}`}>
          {v}
        </span>
      ))}
      {extra.map((v) => (
        <span key={v} className="enum-chip val-added">
          {v}
        </span>
      ))}
    </div>
  );
}

const nodeTypes = { entity: EntityNodeView };

function DataInner({ review }: { review: Review }) {
  const { data, overlay, isFixture } = useDataArtifacts(review);
  const { selectedEntityId, selectEntity } = useUi();
  const [opsOpen, setOpsOpen] = useState(true);

  const status: "ok" | "none" | "unsupported" = useMemo(() => {
    if (!data || data.status === "unsupported") return "unsupported";
    if (overlay?.status === "unsupported") return "unsupported";
    return overlay?.status ?? "none";
  }, [data, overlay]);

  const { nodes, edges } = useMemo(() => (data ? toFlow(data, overlay) : { nodes: [], edges: [] }), [data, overlay]);

  const migrationOps = overlay?.migrationOps ?? [];

  if (status === "unsupported") {
    return (
      <div className="diagram-wrap">
        {isFixture && <FixtureChip />}
        <div className="data-empty">Data analysis unavailable for this repository</div>
      </div>
    );
  }

  return (
    <div className="diagram-wrap">
      {isFixture && <FixtureChip />}
      {status === "none" && <div className="data-banner">No data changes in this PR</div>}
      <ReactFlow
        nodes={nodes.map((n) => ({ ...n, selected: n.id === selectedEntityId }))}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => selectEntity(node.id === selectedEntityId ? null : node.id)}
        onPaneClick={() => selectEntity(null)}
        zoomOnDoubleClick={false}
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
      {migrationOps.length > 0 && (
        <div className="migration-strip">
          <button className="migration-head" onClick={() => setOpsOpen((o) => !o)}>
            <span className="migration-caret">{opsOpen ? "▾" : "▸"}</span>
            Migration ops <span className="migration-count">{migrationOps.length}</span>
          </button>
          {opsOpen && (
            <div className="migration-list">
              {migrationOps.map((op, i) => (
                <div key={i} className="migration-op">
                  <code className="migration-file">{op.file}</code>
                  <span className="migration-sql">{op.op}</span>
                  {op.analyzed === false && (
                    <span className="migration-warn" title="This operation could not be statically analyzed">
                      ⚠ not analyzed
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FixtureChip() {
  return (
    <div className="fixture-chip" title="Rendering hand-written fixture data — the analysis pipeline has not produced real data artifacts yet.">
      FIXTURE
    </div>
  );
}

function toFlow(data: DataArtifact, overlay: DataOverlay | null): { nodes: Node<EntityNodeData>[]; edges: Edge[] } {
  const nodes: Node<EntityNodeData>[] = data.entities.map((e) => ({
    id: e.id,
    type: "entity",
    position: { x: e.pos.x, y: e.pos.y },
    data: { entity: e, overlay: entityOverlayFor(overlay, e), isAdded: false },
  }));

  // PR-added entities: reserved band beneath the laid-out entities (client-side layout)
  const added = overlay?.addedEntities ?? [];
  if (added.length > 0) {
    const maxY = Math.max(0, ...data.entities.map((e) => e.pos.y + (e.pos.h || 160)));
    added.forEach((e, i) => {
      nodes.push({
        id: e.id,
        type: "entity",
        position: { x: 40 + (i % 4) * 260, y: maxY + 90 + Math.floor(i / 4) * 240 },
        data: { entity: e, overlay: entityOverlayFor(overlay, e), isAdded: true },
      });
    });
  }

  const edges: Edge[] = data.edges.map((e, i) => ({
    id: `de-${e.source}__${e.target}__${i}`,
    source: e.source,
    target: e.target,
    className: "flow-edge",
    label: e.label,
    style: { strokeWidth: 1 },
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
  }));
  return { nodes, edges };
}

export function DataPane({ review }: { review: Review }) {
  return (
    <ReactFlowProvider>
      <DataInner review={review} />
    </ReactFlowProvider>
  );
}
