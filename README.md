# pr-rev — diagram-first PR review

Review PRs top-down: navigable drill-down diagrams of the repo on the left (PR-touched
elements highlighted), LLM explanations + diffs + context-aware chat on the right.

Design doc: `docs/superpowers/specs/2026-07-17-pr-rev-design.md`

## Quick start

```sh
pnpm install

# analyze a PR (uses gh auth for GitHub, `claude` CLI for LLM — or set ANTHROPIC_API_KEY)
pnpm analyze owner/repo 123

# run the app (API :3001 + web :5173)
pnpm dev
# open http://localhost:5173
```

`pnpm analyze ... --skip-llm` skips explanations (structure-only, fast, free).

## How it works

- **Pipeline** (`packages/core`): resolves the PR via `gh`, shallow-fetches the merge-base,
  builds a ground-truth import graph (dependency-cruiser + tsconfig), constructs a hierarchy
  of ≤30-node "tiles" with ELK layouts baked in, maps the diff onto the hierarchy as a
  separate overlay, and has an LLM decorate (labels/summaries/explanations) — the LLM never
  invents nodes or edges; every ID it emits is validated against the static graph.
- **Artifacts** (`./artifacts`): immutable JSON/markdown keyed by merge-base SHA (base
  analysis, reusable across PRs) and `(pr, headSha)` (overlay). Local layout mirrors the
  future S3 keys byte-for-byte.
- **API** (`packages/functions`): Hono — serves artifacts (immutable cache headers) and a
  chat endpoint that hydrates context server-side and streams SSE.
- **Web** (`packages/web`): Vite + React + React Flow. Zero client-side layout; the browser
  holds only the current tile + prefetched neighbors (TanStack Query, staleTime ∞ /
  gcTime 5min as the eviction policy). Double-click drills down; breadcrumbs go up;
  deep-linkable URLs.

## Deploy (deferred)

`sst.config.ts` is checked in (StaticSite + streaming Function + Bucket). Set an AWS
profile in the config (or `AWS_PROFILE`) and run `sst deploy`. The Lambda artifact/chat
handler (`packages/functions/src/lambda.ts`) still needs an S3-backed artifact store —
the local server reads from disk.
