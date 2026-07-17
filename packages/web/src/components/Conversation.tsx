import { useState } from "react";
import Markdown from "react-markdown";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, keys } from "../lib/api";
import type { Review, PrMeta } from "../lib/api";

export function Conversation({ review }: { review: Review }) {
  const qc = useQueryClient();
  const metaQ = useQuery({
    queryKey: keys.prMeta(review),
    queryFn: () => api.prMeta(review),
    staleTime: 30_000, // live data — refetch on revisit
    gcTime: 5 * 60 * 1000,
  });
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  async function post() {
    const body = draft.trim();
    if (!body || posting) return;
    setPosting(true);
    setPostError(null);
    try {
      const comment = await api.postComment(review, body);
      setDraft("");
      qc.setQueryData<PrMeta>(keys.prMeta(review), (old) =>
        old ? { ...old, comments: [...old.comments, comment] } : old,
      );
      qc.invalidateQueries({ queryKey: keys.prMeta(review) });
    } catch (e) {
      setPostError((e as Error).message);
    } finally {
      setPosting(false);
    }
  }

  if (metaQ.isLoading) return <div className="text-scroll"><p className="muted">loading conversation…</p></div>;
  if (metaQ.isError || !metaQ.data)
    return <div className="text-scroll"><p className="muted">couldn't load PR conversation</p></div>;
  const meta = metaQ.data;

  return (
    <div className="conversation">
      <div className="text-scroll">
        <section className="text-section">
          <div className="pr-head">
            <span className={`pr-state pr-state-${meta.merged ? "merged" : meta.state}`}>
              {meta.merged ? "merged" : meta.draft ? "draft" : meta.state}
            </span>
            <h2 className="pr-title">
              {meta.title} <span className="pr-num">#{meta.number}</span>
            </h2>
          </div>
          <div className="comment-meta">
            {meta.author} · opened {new Date(meta.createdAt).toLocaleString()} ·{" "}
            <a href={meta.url} target="_blank" rel="noreferrer">
              open on GitHub ↗
            </a>
          </div>
          <div className="pr-body">
            {meta.body ? <Markdown>{meta.body}</Markdown> : <p className="muted">No description.</p>}
          </div>
        </section>

        <section className="text-section">
          <h2 className="section-title">Comments ({meta.comments.length})</h2>
          {meta.comments.length === 0 && <p className="muted">No comments yet.</p>}
          {meta.comments.map((c) => (
            <div key={`${c.kind}-${c.id}`} className="comment">
              <div className="comment-meta">
                {c.authorAvatar && <img className="avatar" src={c.authorAvatar} alt="" />}
                <strong>{c.author}</strong>
                <span>{new Date(c.createdAt).toLocaleString()}</span>
                {c.kind === "review" && c.path && (
                  <code className="comment-anchor">
                    {c.path}
                    {c.line != null ? `:${c.line}` : ""}
                  </code>
                )}
              </div>
              <div className="comment-body">
                <Markdown>{c.body}</Markdown>
              </div>
            </div>
          ))}
        </section>
      </div>

      <div className="composer">
        {postError && <div className="composer-error">{postError}</div>}
        <textarea
          className="chat-input"
          placeholder="Write a comment — posts to the PR on GitHub…"
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              post();
            }
          }}
        />
        <div className="composer-row">
          <span className="muted composer-hint">⌘↵ to post</span>
          <button className="composer-post" onClick={post} disabled={posting || !draft.trim()}>
            {posting ? "Posting…" : "Comment on PR"}
          </button>
        </div>
      </div>
    </div>
  );
}
