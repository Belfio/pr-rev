import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, keys, queryDefaults, type Review } from "./lib/api";
import { useUi, syncUrl, readUrl } from "./state/store";
import { LeftPane } from "./components/LeftPane";
import { TextPane } from "./components/TextPane";

export function App() {
  const { review, setReview, view, tileId, selectedNodeId, selectedEntityId, setView, navigateTile, selectNode, selectEntity } =
    useUi();
  const reviewsQ = useQuery({ queryKey: keys.reviews(), queryFn: api.reviews, ...queryDefaults, staleTime: 30_000 });

  // capture the deep link synchronously on first render, before any syncUrl effect can clear it
  const initialUrl = useRef(readUrl());
  const restorePending = useRef(initialUrl.current.repo != null);

  useEffect(() => {
    if (!reviewsQ.data || review || !restorePending.current) return;
    restorePending.current = false;
    const url = initialUrl.current;
    if (url.repo && url.pr) {
      const found = reviewsQ.data.find((r) => `${r.owner}/${r.repo}` === url.repo && r.prNumber === url.pr);
      if (found) {
        setReview(found);
        if (url.view !== "folders") setView(url.view);
        if (url.tile !== "root") navigateTile(url.tile);
        if (url.node) selectNode(url.node);
        if (url.entity) selectEntity(url.entity);
      }
    }
  }, [reviewsQ.data]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (restorePending.current) return; // don't clobber the deep link before restore runs
    syncUrl(review, view, tileId, selectedNodeId, selectedEntityId);
  }, [review, view, tileId, selectedNodeId, selectedEntityId]);

  if (!review) return <Home reviews={reviewsQ.data ?? []} loading={reviewsQ.isLoading} onOpen={setReview} />;

  return (
    <div className="layout">
      <header className="topbar">
        <button className="back" onClick={() => setReview(null)}>
          ←
        </button>
        <span className="topbar-title">
          {review.owner}/{review.repo}
          <span className="pr-chip">
            #{review.prNumber} {review.title}
          </span>
        </span>
        <a className="gh-link" href={review.url} target="_blank" rel="noreferrer">
          GitHub ↗
        </a>
      </header>
      <main className="split">
        <div className="left">
          <LeftPane review={review} />
        </div>
        <div className="right">
          <TextPane review={review} />
        </div>
      </main>
    </div>
  );
}

function Home({ reviews, loading, onOpen }: { reviews: Review[]; loading: boolean; onOpen: (r: Review) => void }) {
  return (
    <div className="home">
      <h1 className="home-title">pr-rev</h1>
      <p className="home-sub">diagram-first PR review</p>
      {loading && <p className="muted">loading…</p>}
      {!loading && reviews.length === 0 && (
        <div className="home-empty">
          No analyses yet. Run:
          <pre>pnpm analyze owner/repo 123</pre>
        </div>
      )}
      <div className="review-list">
        {reviews.map((r) => (
          <button key={`${r.owner}/${r.repo}#${r.prNumber}`} className="review-card" onClick={() => onOpen(r)}>
            <div className="review-repo">
              {r.owner}/{r.repo} <span className="pr-num">#{r.prNumber}</span>
            </div>
            <div className="review-title">{r.title}</div>
            <div className="review-meta">
              by {r.author} · analyzed {new Date(r.generatedAt).toLocaleString()}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
