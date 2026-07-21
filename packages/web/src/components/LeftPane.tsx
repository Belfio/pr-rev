import { useQuery, useQueries, useQueryClient } from "@tanstack/react-query";
import { api, keys, queryDefaults, prefetchData, prefetchFeatureDoc, isFeatureId } from "../lib/api";
import type { Review, OverlayManifest, DataOverlay, FeatureListItem, FeatureDocOverlay } from "../lib/api";
import { useUi } from "../state/store";
import { DiagramPane } from "./DiagramPane";
import { FeatureDocPane } from "./FeatureDocPane";
import { DataPane, useDataArtifacts } from "./DataPane";

function touchedTotal(m: OverlayManifest | null, tileId: string): number | null {
  const t = m?.touchedTiles[tileId];
  return t ? t.counts.added + t.counts.modified + t.counts.removed : null;
}

function changedEntityCount(overlay: DataOverlay | null): number | null {
  if (!overlay || overlay.status === "unsupported") return null;
  const ids = new Set(Object.keys(overlay.entities));
  for (const e of overlay.addedEntities) ids.add(e.id);
  return ids.size;
}

export function LeftPane({ review }: { review: Review }) {
  const qc = useQueryClient();
  const { view, tileId, setView, navigateTile } = useUi();

  const manifestQ = useQuery({ queryKey: keys.manifest(review), queryFn: () => api.manifest(review), ...queryDefaults });
  const overlayManifestQ = useQuery({
    queryKey: keys.overlayManifest(review),
    queryFn: () => api.overlayManifest(review),
    ...queryDefaults,
  });
  const { overlay: dataOverlay } = useDataArtifacts(review);

  const manifest = manifestQ.data ?? null;
  const overlayManifest = overlayManifestQ.data ?? null;
  const features = overlayManifest?.features ?? [];
  const directFeatures = features.filter((f) => f.direct);

  const rootTileId = manifest?.rootTileId ?? "root";
  const foldersCount = touchedTotal(overlayManifest, rootTileId);
  const flowsCount = overlayManifest ? directFeatures.length : null;
  const dataCount = changedEntityCount(dataOverlay);

  const enterFolders = () => {
    setView("folders");
    if (isFeatureId(tileId)) navigateTile(rootTileId);
  };
  const enterFlows = () => {
    const entering = view !== "flows";
    setView("flows");
    // auto-open the single direct feature; otherwise fall to the overview list
    if (entering && directFeatures.length === 1) {
      const slug = directFeatures[0]!.slug;
      prefetchFeatureDoc(qc, review, slug);
      navigateTile(`feature:${slug}`);
    }
  };
  const enterData = () => {
    prefetchData(qc, review);
    setView("data");
  };

  return (
    <div className="left-pane">
      <div className="primary-tabs">
        <PrimaryTab label="Folders" count={foldersCount} active={view === "folders"} onClick={enterFolders} />
        <PrimaryTab label="Flows" count={flowsCount} active={view === "flows"} onClick={enterFlows} />
        <PrimaryTab label="Data" count={dataCount} active={view === "data"} onClick={enterData} />
      </div>
      <div className="primary-content">
        {view === "folders" && <DiagramPane review={review} />}
        {view === "flows" && <FlowsView review={review} features={features} />}
        {view === "data" && <DataPane review={review} />}
      </div>
    </div>
  );
}

function PrimaryTab({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number | null;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`primary-tab ${active ? "primary-tab-active" : ""}`} onClick={onClick}>
      {label}
      {count != null && count > 0 && <span className="primary-count">{count}</span>}
    </button>
  );
}

function FlowsView({ review, features }: { review: Review; features: FeatureListItem[] }) {
  const qc = useQueryClient();
  const { tileId, navigateTile } = useUi();

  // Per-feature change badge = number of changed sections in that feature's doc overlay
  // (added-section ids are already keys of sectionChanges, so this does not double-count).
  const overlayResults = useQueries({
    queries: features.map((f) => ({
      queryKey: keys.featureDocOverlay(review, f.slug),
      queryFn: () => api.featureDocOverlay(review, f.slug),
      ...queryDefaults,
    })),
  });
  const changeCounts = new Map<string, number>();
  features.forEach((f, i) => {
    const ov = overlayResults[i]?.data as FeatureDocOverlay | null | undefined;
    if (ov) changeCounts.set(f.slug, Object.keys(ov.sectionChanges).length);
  });

  if (features.length === 0) {
    return <div className="data-empty">No feature docs were generated for this PR</div>;
  }

  const direct = features.filter((f) => f.direct);
  const rest = features.filter((f) => !f.direct); // shared-only / untouched, de-emphasized
  const nDirect = direct.length;
  const mShared = features.filter((f) => f.shared && !f.direct).length;
  const chipClass = nDirect <= 1 ? "flow-chip-ok" : "flow-chip-warn";
  const selected = isFeatureId(tileId) ? tileId : null;

  const select = (slug: string) => {
    prefetchFeatureDoc(qc, review, slug);
    navigateTile(`feature:${slug}`);
  };

  const featureButton = (f: FeatureListItem, dimmed: boolean) => {
    const id = `feature:${f.slug}`;
    const count = changeCounts.get(f.slug);
    return (
      <button
        key={f.slug}
        className={`view-tab ${selected === id ? "view-tab-active" : ""} ${dimmed ? "view-tab-dim" : ""}`}
        onClick={() => select(f.slug)}
        title={dimmed ? `${f.title} — changed only via shared dependencies` : f.title}
      >
        {f.title}
        {count != null && count > 0 && <span className="crumb-badge">{count}</span>}
      </button>
    );
  };

  return (
    <div className="flows-view">
      <div className="flow-bar">
        <div className="flow-tabs">
          {direct.map((f) => featureButton(f, false))}
          {rest.map((f) => featureButton(f, true))}
        </div>
        <span className={`flow-chip ${chipClass}`} title="A PR should be designed around one feature.">
          {nDirect} direct · {mShared} via shared deps
        </span>
      </div>
      {selected ? (
        <div className="flow-diagram">
          <FeatureDocPane review={review} />
        </div>
      ) : (
        <div className="flow-overview">
          <p className="muted">Select a feature to read its before/after documentation.</p>
          <div className="flow-overview-list">
            {direct.map((f) => featureButton(f, false))}
            {rest.map((f) => featureButton(f, true))}
          </div>
        </div>
      )}
    </div>
  );
}
