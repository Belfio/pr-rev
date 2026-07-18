import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, keys, queryDefaults, prefetchData, prefetchTile } from "../lib/api";
import type { Review, AnalysisManifest, OverlayManifest, DataOverlay } from "../lib/api";
import { useUi, type PrimaryView } from "../state/store";
import { DiagramPane } from "./DiagramPane";
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
  const flows = manifest?.flows ?? [];
  const directFlows = flows.filter((f) => f.direct);

  const rootTileId = manifest?.rootTileId ?? "root";
  const foldersCount = touchedTotal(overlayManifest, rootTileId);
  const flowsCount = manifest ? directFlows.length : null;
  const dataCount = changedEntityCount(dataOverlay);

  const enterFolders = () => {
    setView("folders");
    if (tileId.startsWith("flow:")) navigateTile(rootTileId);
  };
  const enterFlows = () => {
    const entering = view !== "flows";
    setView("flows");
    // auto-open the single direct flow; otherwise fall to the overview list
    if (entering) {
      if (directFlows.length === 1) navigateTile(directFlows[0]!.tileId);
      else if (tileId.startsWith("flow:")) navigateTile(rootTileId);
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
        {view === "flows" && (
          <FlowsView review={review} manifest={manifest} overlayManifest={overlayManifest} />
        )}
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

function FlowsView({
  review,
  manifest,
  overlayManifest,
}: {
  review: Review;
  manifest: AnalysisManifest | null;
  overlayManifest: OverlayManifest | null;
}) {
  const qc = useQueryClient();
  const { tileId, navigateTile } = useUi();
  const flows = manifest?.flows ?? [];

  if (flows.length === 0) {
    return <div className="data-empty">No user flows were extracted for this repository</div>;
  }

  // Manifests generated before flow classification existed have no direct/shared
  // booleans — render those neutrally (no dimming, no chip) instead of asserting a
  // false "0 direct · 0 shared" classification.
  const classified = flows.some((f) => f.direct !== undefined || f.shared !== undefined);
  const direct = classified ? flows.filter((f) => f.direct) : flows;
  const rest = classified ? flows.filter((f) => !f.direct) : []; // shared-only, de-emphasized
  const nDirect = direct.length;
  const mShared = flows.filter((f) => f.shared && !f.direct).length;
  const chipClass = nDirect <= 1 ? "flow-chip-ok" : "flow-chip-warn";
  const selected = tileId.startsWith("flow:") ? tileId : null;

  const select = (id: string) => {
    prefetchTile(qc, review, id);
    navigateTile(id);
  };

  const flowButton = (f: { tileId: string; title: string; shared?: boolean }, dimmed: boolean) => {
    const total = touchedTotal(overlayManifest, f.tileId);
    return (
      <button
        key={f.tileId}
        className={`view-tab ${selected === f.tileId ? "view-tab-active" : ""} ${dimmed ? "view-tab-dim" : ""}`}
        onClick={() => select(f.tileId)}
        title={dimmed ? `${f.title} — changed only via shared dependencies` : f.title}
      >
        {f.title.replace(/^Flow: /, "⇢ ")}
        {total != null && <span className="crumb-badge">{total}</span>}
      </button>
    );
  };

  return (
    <div className="flows-view">
      <div className="flow-bar">
        <div className="flow-tabs">
          {direct.map((f) => flowButton(f, false))}
          {rest.map((f) => flowButton(f, true))}
        </div>
        {classified && (
          <span className={`flow-chip ${chipClass}`} title="A PR should be designed around one user flow.">
            {nDirect} direct · {mShared} via shared deps
          </span>
        )}
      </div>
      {selected ? (
        <div className="flow-diagram">
          <DiagramPane review={review} />
        </div>
      ) : (
        <div className="flow-overview">
          <p className="muted">Select a flow to inspect its steps.</p>
          <div className="flow-overview-list">
            {direct.map((f) => flowButton(f, false))}
            {rest.map((f) => flowButton(f, true))}
          </div>
        </div>
      )}
    </div>
  );
}
