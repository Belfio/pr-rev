import { useState } from "react";
import Markdown from "react-markdown";
import { useQuery } from "@tanstack/react-query";
import { api, keys, queryDefaults, isFeatureId, featureSlug, mergeDocSections } from "../lib/api";
import type { Review, DataArtifact, DataEntity, DataOverlay } from "../lib/api";
import { useUi } from "../state/store";
import { DiffView } from "./DiffView";
import { Chat } from "./Chat";
import { Conversation } from "./Conversation";
import { useDataArtifacts, entityOverlayFor, mergeFields } from "./DataPane";

export function TextPane({ review }: { review: Review }) {
  const [tab, setTab] = useState<"review" | "conversation">("review");
  const { view, tileId, selectedNodeId } = useUi();
  const isFeature = isFeatureId(tileId);
  const metaQ = useQuery({
    queryKey: keys.prMeta(review),
    queryFn: () => api.prMeta(review),
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
  });

  // Feature ids have no tile/overlay artifacts and these fetchers throw on 404 — gate
  // them off for features (the feature branch renders from featureDoc + doc overlay).
  const tileQ = useQuery({ queryKey: keys.tile(review, tileId), queryFn: () => api.tile(review, tileId), enabled: !isFeature, ...queryDefaults });
  const tileMdQ = useQuery({ queryKey: keys.tileMd(review, tileId), queryFn: () => api.tileMd(review, tileId), enabled: !isFeature, ...queryDefaults });
  const overlayQ = useQuery({ queryKey: keys.overlay(review, tileId), queryFn: () => api.overlay(review, tileId), enabled: !isFeature, ...queryDefaults });
  const overlayMdQ = useQuery({ queryKey: keys.overlayMd(review, tileId), queryFn: () => api.overlayMd(review, tileId), enabled: !isFeature, ...queryDefaults });
  const prSummaryQ = useQuery({ queryKey: keys.prSummary(review), queryFn: () => api.prSummary(review), ...queryDefaults });

  const tile = tileQ.data;
  const overlay = overlayQ.data ?? null;

  const selectedNode =
    selectedNodeId != null
      ? (tile?.nodes.find((n) => n.id === selectedNodeId) ??
        overlay?.addedNodes.find((n) => n.id === selectedNodeId) ??
        null)
      : null;
  const selectedOverlay = selectedNodeId != null ? (overlay?.nodes[selectedNodeId] ?? null) : null;

  return (
    <div className="text-pane">
      <div className="pane-tabs">
        <button className={`pane-tab ${tab === "review" ? "pane-tab-active" : ""}`} onClick={() => setTab("review")}>
          Review
        </button>
        <button
          className={`pane-tab ${tab === "conversation" ? "pane-tab-active" : ""}`}
          onClick={() => setTab("conversation")}
        >
          Conversation{metaQ.data ? ` (${metaQ.data.comments.length})` : ""}
        </button>
      </div>
      {tab === "conversation" ? (
        <Conversation review={review} />
      ) : view === "data" ? (
        <>
          <div className="text-scroll">
            <DataReview review={review} />
          </div>
          <Chat review={review} />
        </>
      ) : isFeature ? (
        <>
          <div className="text-scroll">
            <FeatureReview review={review} />
          </div>
          <Chat review={review} />
        </>
      ) : (
        <>
      <div className="text-scroll">
        {selectedNode ? (
          <section className="text-section">
            <h2 className="section-title">
              {selectedNode.label}
              {selectedOverlay && <span className={`badge badge-${selectedOverlay.status}`}>{selectedOverlay.status}</span>}
            </h2>
            {selectedNode.summary && <p className="node-summary">{selectedNode.summary}</p>}
            {selectedOverlay?.changeSummary && (
              <p className="change-summary">
                <strong>This PR:</strong> {selectedOverlay.changeSummary}
              </p>
            )}
            {selectedOverlay?.renamedFrom && (
              <p className="change-summary">Renamed from <code>{selectedOverlay.renamedFrom}</code></p>
            )}
            {selectedNode.anchors.length > 0 && (
              <p className="anchors">
                {selectedNode.anchors.map((a) => (
                  <code key={a.file}>{a.file}</code>
                ))}
              </p>
            )}
            {selectedOverlay?.hunkRefs.map((h) => (
              <DiffView key={h.patchUri} review={review} hunkRef={h} />
            ))}
            {selectedOverlay && selectedOverlay.hunkRefs.length === 0 && (
              <p className="muted">Changed via files inside this container — drill in for detail.</p>
            )}
          </section>
        ) : (
          <>
            {tileId === "root" && (
              <section className="text-section">
                <h2 className="section-title">PR summary</h2>
                {prSummaryQ.isLoading ? <p className="muted">loading…</p> : <Markdown>{prSummaryQ.data ?? ""}</Markdown>}
              </section>
            )}
            {overlayMdQ.data && (
              <section className="text-section changed-section">
                <h2 className="section-title">Changes in this view</h2>
                <Markdown>{overlayMdQ.data}</Markdown>
              </section>
            )}
            <section className="text-section">
              <h2 className="section-title">About this view</h2>
              {tileMdQ.isLoading ? <p className="muted">loading…</p> : <Markdown>{tileMdQ.data ?? ""}</Markdown>}
            </section>
          </>
        )}
      </div>
      <Chat review={review} />
        </>
      )}
    </div>
  );
}

// Right-pane detail for a selected feature (Flows tab). A selected section shows its
// change narrative, files, and diffs; with nothing selected we show the doc summary and
// a per-section change index (replacing the old per-tile "About this view" markdown).
function FeatureReview({ review }: { review: Review }) {
  const { tileId, selectedNodeId } = useUi();
  const slug = featureSlug(tileId);

  const docQ = useQuery({
    queryKey: keys.featureDoc(review, slug),
    queryFn: () => api.featureDoc(review, slug),
    ...queryDefaults,
  });
  const overlayQ = useQuery({
    queryKey: keys.featureDocOverlay(review, slug),
    queryFn: () => api.featureDocOverlay(review, slug),
    ...queryDefaults,
  });

  const doc = docQ.data ?? null;
  const overlay = overlayQ.data ?? null;
  const sections = mergeDocSections(doc, overlay);
  const changes = overlay?.sectionChanges ?? {};

  if (docQ.isLoading) return <p className="muted">loading…</p>;
  if (!doc) return <p className="muted">Feature doc unavailable.</p>;

  const selected = selectedNodeId != null ? sections.find((s) => s.id === selectedNodeId) ?? null : null;

  if (selected) {
    const change = changes[selected.id];
    return (
      <section className="text-section">
        <h2 className="section-title">
          {selected.heading}
          {change && <span className={`badge badge-${change.change}`}>{change.change}</span>}
        </h2>
        {selected.overview && (
          <div className="node-summary">
            <Markdown>{selected.overview}</Markdown>
          </div>
        )}
        {selected.importantDetail && (
          <p className="change-summary">
            <strong>Important detail:</strong> {selected.importantDetail}
          </p>
        )}
        {change?.changeNarrative && (
          <p className="change-summary">
            <strong>What changed:</strong> {change.changeNarrative}
          </p>
        )}
        {selected.files.length > 0 && (
          <p className="anchors">
            {selected.files.map((f) => (
              <code key={f}>{f}</code>
            ))}
          </p>
        )}
        {(change?.hunkRefs ?? []).map((h) => (
          <DiffView key={h.patchUri} review={review} hunkRef={h} />
        ))}
        {change && change.hunkRefs.length === 0 && (
          <p className="muted">Changed in this PR — no line-level diff attributed to this section.</p>
        )}
        {!change && <p className="muted">Unchanged in this PR.</p>}
      </section>
    );
  }

  return (
    <>
      <section className="text-section">
        <h2 className="section-title">{doc.title}</h2>
        {doc.summary ? <Markdown>{doc.summary}</Markdown> : <p className="muted">Select a section for detail.</p>}
      </section>
      <section className="text-section">
        <h2 className="section-title">Sections changed in this PR</h2>
        {Object.keys(changes).length === 0 ? (
          <p className="muted">No sections of this feature changed in this PR.</p>
        ) : (
          <ul className="feature-change-index">
            {sections
              .filter((s) => changes[s.id])
              .map((s) => (
                <li key={s.id}>
                  <span className={`badge badge-${changes[s.id]!.change}`}>{changes[s.id]!.change}</span>{" "}
                  {s.heading}
                </li>
              ))}
          </ul>
        )}
      </section>
    </>
  );
}

function findEntity(data: DataArtifact | null, overlay: DataOverlay | null, id: string | null): DataEntity | null {
  if (!id) return null;
  return (
    data?.entities.find((e) => e.id === id) ??
    overlay?.addedEntities.find((e) => e.id === id) ??
    null
  );
}

// DB tables are snake_case + plural ("families"); entities are PascalCase + singular
// ("Family"). Compare on a normalized singular snake_case stem so the two line up.
function toSnake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}
function singular(s: string): string {
  if (s.endsWith("ies")) return s.slice(0, -3) + "y";
  if (s.endsWith("es")) return s.slice(0, -2);
  if (s.endsWith("s")) return s.slice(0, -1);
  return s;
}
function migrationOpsForEntity(overlay: DataOverlay | null, entity: DataEntity) {
  const target = toSnake(entity.name);
  return (overlay?.migrationOps ?? []).filter((op) => {
    if (!op.table) return false;
    const t = op.table.toLowerCase();
    return t === target || singular(t) === target || singular(t) === singular(target);
  });
}

function DataReview({ review }: { review: Review }) {
  const { data, overlay } = useDataArtifacts(review);
  const { selectedEntityId } = useUi();
  const entity = findEntity(data, overlay, selectedEntityId);

  if (!entity) {
    return (
      <section className="text-section">
        <h2 className="section-title">Data model</h2>
        <p className="muted">Select an entity to see its provenance, field-level diff, and possible consumers.</p>
        {data && data.sources.length > 0 && (
          <p className="anchors">
            {data.sources.map((s) => (
              <code key={s}>{s}</code>
            ))}
          </p>
        )}
      </section>
    );
  }

  const ov = entityOverlayFor(overlay, entity);
  const rows = entity.kind === "object" ? mergeFields(entity, ov) : [];
  const ops = migrationOpsForEntity(overlay, entity);
  const consumers = data?.consumers[entity.definedIn] ?? [];

  return (
    <>
      <section className="text-section">
        <h2 className="section-title">
          {entity.name}
          {ov && <span className={`badge badge-${ov.status}`}>{ov.status}</span>}
        </h2>
        <p className="entity-meta">
          <span className="entity-prov">{entity.provenance}</span>
          <span className="muted">defined in</span>
          <code>{entity.definedIn}</code>
        </p>
      </section>

      {entity.kind === "enum" ? (
        <section className="text-section">
          <h2 className="section-title">Values</h2>
          <div className="enum-values">
            {(entity.values ?? []).map((v) => (
              <span key={v} className={`enum-chip ${ov?.valuesRemoved?.includes(v) ? "val-removed" : ""}`}>
                {v}
              </span>
            ))}
            {(ov?.valuesAdded ?? [])
              .filter((v) => !(entity.values ?? []).includes(v))
              .map((v) => (
                <span key={v} className="enum-chip val-added">
                  {v}
                </span>
              ))}
          </div>
        </section>
      ) : (
        <section className="text-section">
          <h2 className="section-title">Fields</h2>
          <table className="diff-table">
            <thead>
              <tr>
                <th>field</th>
                <th>before</th>
                <th>after</th>
                <th>status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => {
                const st = f.overlay?.status;
                const before =
                  st === "added" ? "—" : st === "changed" ? (f.overlay?.prevType ?? "—") : st === "removed" ? (f.overlay?.prevType ?? f.type) : f.type;
                const after = st === "removed" ? "—" : st === "changed" || st === "added" ? f.overlay!.type : f.type;
                return (
                  <tr key={f.name} className={st ? `fld-${st}` : ""}>
                    <td className="dt-name">
                      {f.name}
                      {f.optional && <span className="fld-opt">?</span>}
                    </td>
                    <td className="dt-type">{before}</td>
                    <td className="dt-type">{after}</td>
                    <td>{st ? <span className={`badge badge-${st}`}>{st}</span> : <span className="muted">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {ops.length > 0 && (
        <section className="text-section">
          <h2 className="section-title">Migration ops</h2>
          {ops.map((op, i) => (
            <div key={i} className="migration-op">
              <code className="migration-file">{op.file}</code>
              <span className="migration-sql">{op.op}</span>
              {op.analyzed === false && <span className="migration-warn">⚠ not analyzed</span>}
            </div>
          ))}
        </section>
      )}

      <section className="text-section">
        <h2 className="section-title">Possible consumers</h2>
        <p className="muted">Files importing the schema module.</p>
        {consumers.length > 0 ? (
          <p className="anchors">
            {consumers.map((c) => (
              <code key={c}>{c}</code>
            ))}
          </p>
        ) : (
          <p className="muted">None found.</p>
        )}
      </section>
    </>
  );
}
