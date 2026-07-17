import { useState } from "react";
import Markdown from "react-markdown";
import { useQuery } from "@tanstack/react-query";
import { api, keys, queryDefaults } from "../lib/api";
import type { Review } from "../lib/api";
import { useUi } from "../state/store";
import { DiffView } from "./DiffView";
import { Chat } from "./Chat";
import { Conversation } from "./Conversation";

export function TextPane({ review }: { review: Review }) {
  const [tab, setTab] = useState<"review" | "conversation">("review");
  const { tileId, selectedNodeId } = useUi();
  const metaQ = useQuery({
    queryKey: keys.prMeta(review),
    queryFn: () => api.prMeta(review),
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
  });

  const tileQ = useQuery({ queryKey: keys.tile(review, tileId), queryFn: () => api.tile(review, tileId), ...queryDefaults });
  const tileMdQ = useQuery({ queryKey: keys.tileMd(review, tileId), queryFn: () => api.tileMd(review, tileId), ...queryDefaults });
  const overlayQ = useQuery({ queryKey: keys.overlay(review, tileId), queryFn: () => api.overlay(review, tileId), ...queryDefaults });
  const overlayMdQ = useQuery({ queryKey: keys.overlayMd(review, tileId), queryFn: () => api.overlayMd(review, tileId), ...queryDefaults });
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
