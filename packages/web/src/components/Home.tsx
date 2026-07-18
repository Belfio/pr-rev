import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, keys, type Review, type PrListItem } from "../lib/api";

const LAST_REPO_KEY = "pr-rev:lastRepo";

function parseRepo(input: string): { owner: string; repo: string } | null {
  const m = input.trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/);
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

export function Home({
  reviews,
  loading,
  onOpen,
  onRefetchReviews,
}: {
  reviews: Review[];
  loading: boolean;
  onOpen: (r: Review) => void;
  onRefetchReviews: () => void;
}) {
  const [repoInput, setRepoInput] = useState(() => localStorage.getItem(LAST_REPO_KEY) ?? "");
  const [loaded, setLoaded] = useState<{ owner: string; repo: string } | null>(null);

  // auto-load the last-used repo on mount
  useEffect(() => {
    const saved = localStorage.getItem(LAST_REPO_KEY);
    if (saved) setLoaded(parseRepo(saved));
  }, []);

  const load = () => {
    const parsed = parseRepo(repoInput);
    if (!parsed) return;
    localStorage.setItem(LAST_REPO_KEY, `${parsed.owner}/${parsed.repo}`);
    setLoaded(parsed);
  };

  return (
    <div className="home">
      <h1 className="home-title">pr-rev</h1>
      <p className="home-sub">diagram-first PR review</p>

      <div className="repo-picker">
        <input
          className="repo-input"
          placeholder="owner/repo"
          value={repoInput}
          onChange={(e) => setRepoInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && load()}
          spellCheck={false}
          autoCapitalize="none"
        />
        <button className="repo-load" onClick={load} disabled={!parseRepo(repoInput)}>
          Load
        </button>
      </div>

      {loaded && <OpenPrs owner={loaded.owner} repo={loaded.repo} reviews={reviews} onOpen={onOpen} onRefetchReviews={onRefetchReviews} />}

      <div className="home-section-head">Analyzed reviews</div>
      {loading && <p className="muted">loading…</p>}
      {!loading && reviews.length === 0 && (
        <div className="home-empty">
          No analyses yet. Load a repo above and click <strong>Analyze</strong> on a PR, or run:
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

function OpenPrs({
  owner,
  repo,
  reviews,
  onOpen,
  onRefetchReviews,
}: {
  owner: string;
  repo: string;
  reviews: Review[];
  onOpen: (r: Review) => void;
  onRefetchReviews: () => void;
}) {
  const prsQ = useQuery({
    queryKey: keys.openPrs(owner, repo),
    queryFn: () => api.openPrs(owner, repo),
    staleTime: 30_000,
    retry: false,
  });

  const reviewByPr = useMemo(() => {
    const m = new Map<number, Review>();
    for (const r of reviews) if (r.owner === owner && r.repo === repo) m.set(r.prNumber, r);
    return m;
  }, [reviews, owner, repo]);

  return (
    <div className="open-prs">
      <div className="home-section-head">
        Open pull requests <span className="muted">· {owner}/{repo}</span>
      </div>
      {prsQ.isLoading && <p className="muted">loading open PRs…</p>}
      {prsQ.isError && <p className="composer-error">{(prsQ.error as Error).message}</p>}
      {prsQ.data && prsQ.data.length === 0 && <p className="muted">No open pull requests.</p>}
      <div className="review-list">
        {prsQ.data?.map((pr) => (
          <PrRow
            key={pr.number}
            owner={owner}
            repo={repo}
            pr={pr}
            review={reviewByPr.get(pr.number) ?? null}
            onOpen={onOpen}
            onRefetchReviews={onRefetchReviews}
          />
        ))}
      </div>
    </div>
  );
}

function PrRow({
  owner,
  repo,
  pr,
  review,
  onOpen,
  onRefetchReviews,
}: {
  owner: string;
  repo: string;
  pr: PrListItem;
  review: Review | null;
  onOpen: (r: Review) => void;
  onRefetchReviews: () => void;
}) {
  const [started, setStarted] = useState(false);

  const jobQ = useQuery({
    queryKey: keys.analyzeJob(owner, repo, pr.number),
    queryFn: () => api.analyzeJob(owner, repo, pr.number),
    enabled: started,
    refetchInterval: (q) => {
      const s = q.state.data?.state;
      return s === "done" || s === "error" ? false : 2000;
    },
  });

  const job = jobQ.data ?? null;

  // when a run finishes, pull the fresh reviews list so the row can flip to "Open review"
  useEffect(() => {
    if (job?.state === "done") onRefetchReviews();
  }, [job?.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    setStarted(true);
    try {
      await api.startAnalysis(owner, repo, pr.number);
    } catch (e) {
      // surface start failures through the job panel's error slot
      jobQ.refetch();
      return;
    }
    jobQ.refetch();
  };

  const active = started && (!job || job.state === "queued" || job.state === "running");
  const errored = job?.state === "error";
  const stale = review != null && review.headSha !== pr.headSha;
  const fresh = review != null && review.headSha === pr.headSha;

  const lastLog = job?.log?.[job.log.length - 1];

  return (
    <div className="pr-row">
      <div className="pr-row-main">
        <div className="review-repo">
          <span className="pr-num">#{pr.number}</span> {pr.draft && <span className="pr-draft-chip">draft</span>}
        </div>
        <div className="review-title">{pr.title}</div>
        <div className="review-meta">by {pr.author}</div>
        {active && (
          <div className="pr-progress">
            <span className="spinner" /> {job?.state === "running" ? (lastLog ?? "analyzing…") : "queued…"}
          </div>
        )}
        {errored && <div className="composer-error">Analysis failed: {job?.error ?? "unknown error"}</div>}
      </div>
      <div className="pr-row-actions">
        {active ? null : errored ? (
          <button className="pr-action" onClick={start}>
            Retry
          </button>
        ) : fresh ? (
          <button className="pr-action pr-action-open" onClick={() => onOpen(review!)}>
            Open review →
          </button>
        ) : stale ? (
          <>
            <button className="pr-action pr-action-open" onClick={() => onOpen(review!)}>
              Open (stale)
            </button>
            <button className="pr-action" onClick={start}>
              Re-analyze
            </button>
          </>
        ) : (
          <button className="pr-action" onClick={start}>
            Analyze
          </button>
        )}
      </div>
    </div>
  );
}
