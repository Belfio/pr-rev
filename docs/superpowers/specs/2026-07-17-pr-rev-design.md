# pr-rev — Diagram-First PR Review Tool

**Date:** 2026-07-17
**Status:** Approved direction (user pre-approved build; design synthesized from codex high-reasoning pass + planning agent + own analysis)

## Problem

AI-assisted development produces more code than file-by-file review can absorb. The reviewer needs top-down comprehension — what areas does this PR touch, what new dependencies cross those areas, what path does the changed behavior take — with the ability to drill down to the exact hunks that support the answer.

## Product shape

Split-screen review app for a GitHub `repo + PR#`:

- **Left pane — navigable diagrams.** Hierarchical, map-like. Root = codebase/module map. Click a node → drill into its child diagram. PR-touched elements highlighted (added = green, modified = amber, removed = ghosted red). Breadcrumbs to go up. Diagram kinds: `module-map` (MVP), `flow`, `infra`, `datastructure` (later).
- **Right pane — the textual bit.** Pre-generated LLM explanation of the current tile (what this is + what the PR changes here), diff snippets for the selected node, and a chat input scoped to the current view.

## Core principles (load-bearing)

1. **Static analysis decides what exists and what connects. The LLM decides what's important, how to label it, and how to explain it.** The LLM never invents nodes or edges; every ID it references is validated against the static graph and dropped if unknown. This eliminates hallucinated architecture as a class.
2. **Map tiles, not one big graph.** The pipeline pre-computes small immutable JSON tiles — one per drill-down level — with ELK layout baked in. Hard caps: ≤30 nodes, ≤60 edges per tile; overflow clusters into an "other (n)" node with its own child tile. A tile is one small fetch (8–25KB target, 50KB asserted in the pipeline).
3. **Base/overlay split.** Base analysis is keyed by the PR's **merge-base SHA** and reusable across PRs. The PR overlay (statuses, hunk refs, change explanations) is keyed by `(prNumber, headSha)` — a force-push mints a new overlay without touching base artifacts.
4. **Local-first, cloud-shaped.** Local artifact directory mirrors the S3 key layout byte-for-byte. SST deploy later swaps the storage backend, not the format.
5. **Honest coverage.** Every tile carries `coverage` (analyzed files, unresolved imports). A diagram silently missing edges is worse than one that admits gaps.
6. **Repo content is untrusted input.** Never execute repo code/install scripts. In prompts, repo content is quoted data; summarization calls have no tools; strict JSON outputs.

## Artifact layout (local dir == future S3 keys)

```
artifacts/
  analysis/{owner}/{repo}/{baseSha}/
    manifest.json                      # root tileId, tile index, coverage, stats
    tiles/{tilePath}.json              # graph tile (nodes/edges/layout)
    tiles/{tilePath}.md                # pre-generated explanation
    index/file-to-nodes.json           # reverse index: file → [(tileId, nodeId)]
  pr/{owner}/{repo}/{prNumber}/{headSha}/
    overlay-manifest.json              # touchedTiles rollup — drives all highlighting
    overlays/{tilePath}.json           # per-tile diff overlay
    overlays/{tilePath}.md             # "what this PR changes here"
    overlays/pr-summary.md             # whole-PR explanation (root right pane)
    patches/{escaped-path}.patch       # raw per-file hunks, fetched lazily
```

`{tilePath}` uses `__` as the path separator in filenames (e.g. `root__packages.api__handlers`).

### Tile ID scheme

Path-based logical IDs under the SHA namespace: `root`, `root/app`, `root/app/routes`. Identity = `(owner, repo, baseSha, tilePath)`.
**Not** content-addressed: content hashes cascade (leaf change → parent childTileId changes → parent hash changes → … → root), killing incremental regeneration and prefetchable URLs. Content-addressing lives only in the file-summary LLM cache (keyed by file content hash), which makes re-runs nearly free.

### Tile schema (abridged)

```jsonc
{
  "schemaVersion": 1,
  "tileId": "root/app",
  "kind": "module-map",              // "module-map" | "flow" | "infra" | "datastructure"
  "title": "App",
  "parentTileId": "root",
  "breadcrumbs": [{ "tileId": "root", "title": "acme/shop" }],   // denormalized for deep links
  "repo": { "owner": "...", "name": "...", "commitSha": "..." },
  "coverage": { "analyzedFiles": 318, "eligibleFiles": 332, "unresolvedImports": 7 },
  "nodes": [{
    "id": "n:auth",                  // stable slug, unique within tile
    "kind": "module",                // service|module|file|function|datastore|external
    "label": "Auth",
    "summary": "JWT issuance and session validation",    // LLM one-liner
    "anchors": [{ "file": "src/auth.ts", "startLine": 1, "endLine": 214 }],  // SHA from envelope
    "childTileId": "root/app/auth",  // null = leaf
    "stats": { "files": 4, "loc": 890 },
    "pos": { "x": 40, "y": 120, "w": 180, "h": 64 }      // precomputed ELK layout
  }],
  "edges": [{
    "id": "e:auth->db", "source": "n:auth", "target": "n:db",
    "kind": "import",                // import|call|reads|writes|dataflow
    "weight": 7                      // bundled underlying imports
  }],
  "explanation": { "uri": "tiles/root__app.md" }
}
```

### Overlay schema (abridged)

`overlay-manifest.json`: `touchedTiles: { [tileId]: { status, counts: {added, modified, removed} } }` — one tiny fetch drives breadcrumb badges and node glow everywhere.

Per-tile overlay: `nodes: { [nodeId]: { status, changeSummary, hunkRefs: [{file, patchUri, hunkIndices, oldRange, newRange}] } }`, plus `addedNodes` (full node objects for files new in the PR, laid out in a reserved "new in this PR" band — no client layout), `addedEdges`, `removedNodeIds` (rendered ghosted, never dropped).

## Pipeline (`analyze owner/repo prNumber`)

1. **Resolve PR** via `gh`: base/head SHAs, **merge-base**, changed files with statuses + renames, raw diff (local git three-dot, not the truncating API).
2. **Clone** at merge-base (`--filter=blob:none`, shallow). Never run install/build scripts.
3. **Import graph**: dependency-cruiser wired to the repo's `tsconfig.json` (path aliases resolved — the #1 silent failure mode). Log unresolved-import counts into `coverage`.
4. **Hierarchy**: directory tree post-processed — workspace boundaries (`pnpm-workspace.yaml`, package.json workspaces) are authoritative top-level groupings; collapse single-child chains; merge tiny dirs; split >30-entry dirs via "other (n)" clustering. Deny-list `dist/`, generated, vendored; respect `.gitignore`.
5. **LLM decorate** (per tile, concurrent): input = node/edge lists + member file export signatures; output = strict JSON (title, node summaries) + explanation markdown. Validate every referenced ID; drop unknowns; one retry with validation feedback, then deterministic fallback labels.
6. **ELK layout** (elkjs, layered) per tile; positions written into tile JSON.
7. **Diff overlay**: map hunks → nodes via the reverse index (old-side line ranges — anchors are pinned at baseSha); renames via `previous_filename`; added files routed by directory-prefix walk; rollup statuses up the parent chain → `overlay-manifest.json`.
8. **Overlay explanations**: one LLM call per touched tile ("what this PR changes here", change one-liners per node) + one PR summary.
9. Write everything; manifest last (atomic publish).

**LLM adapter** (`LlmClient` interface): `ClaudeCliClient` shells to `claude -p` (rides the user's subscription, zero keys needed locally) and `AnthropicApiClient` (used when `ANTHROPIC_API_KEY` is set; required for deployed mode). Structured outputs are prompt-enforced JSON, schema-validated, one retry.

**Cost/latency** (≈1000-file repo): ~60–120 tiles, a few dollars, a few minutes at concurrency ~8. Re-runs nearly free via the content-hash summary cache. Per-PR overlay: ~3–15 tile calls, pennies, ~30s.

## Frontend (Vite + React SPA)

- **React Flow (@xyflow/react)** — nodes are plain React components (kind icon, diff badge, count pill, hover-prefetch). Perf objections void by construction: tiles cap at 30 nodes.
- **Zero client layout** — positions ship in the tile. First paint = fetch + parse + render.
- **Drill-down** = viewport trick: animate zoom into the clicked node's bbox (~180ms) while fading, swap child tile, animate to identity. Child is already cached (prefetch on hover). Reverse for breadcrumb-up.
- **State**: TanStack Query owns all artifact fetches — keys `['tile', sha, tileId]` etc., `staleTime: Infinity` (SHA-keyed = immutable), `gcTime ≈ 5min` as the eviction policy. No hand-rolled LRU. Zustand holds only UI state (current tile, selection, chat). Browser holds ~5–10 tiles ≈ 200–500KB regardless of repo size.
- **Right pane**: react-markdown for base + overlay explanations (stacked), diff snippets for the selected node fetched from `patches/` and rendered per-hunk, chat at the bottom.
- **Chat**: client POSTs `{tileId, selectedNodeId, prNumber, message, history}`; the **server** hydrates context (tile JSON + explanations + overlay + referenced hunks) and streams SSE. The browser never assembles prompts.
- **URL state**: `/r/{owner}/{repo}/pr/{n}?tile=...&node=...` — deep-linkable, browser back/forward works.

## Service architecture

pnpm monorepo:

```
packages/core/        # schemas (zod), pipeline, LLM adapters, CLI (pr-rev analyze)
packages/functions/   # Hono API: artifact serving, analyze trigger, chat SSE
packages/web/         # Vite React SPA
sst.config.ts         # SST v3
```

- **Local dev**: `pnpm analyze <owner/repo> <pr>` writes `./artifacts/`; Hono serves artifacts + chat on :3001; Vite on :5173 proxies `/api`.
- **SST (deploy-ready, deferred)**: `StaticSite` (web) + `ApiGatewayV2`/Function (API + chat via Lambda response streaming) + `Bucket` (artifacts) + `Task` (Fargate analyzer — repos don't fit Lambda's 15min/10GB envelope) + `Dynamo` (job status). AWS profile intentionally unset pending the user's choice ("stg" account not found among local profiles).

## MVP cut (this build)

**In**: TS/JS repos; module-map tiles at all depths; PR overlay + highlighting; per-tile explanations + PR summary; diff snippets; streaming chat; drill-down with prefetch + animated transitions; local pipeline CLI; SST config checked in.
**Out (deferred)**: flow/infra/datastructure tile kinds, function-level nodes, `.prmap.yml` overrides, incremental baseline refresh, GitHub App/webhooks, deploy, auth, review-comment publishing.

## Failure modes actively mitigated

1. tsconfig path aliases silently dropping edges → wire tsconfig into dependency-cruiser day one; surface `unresolvedImports` in the UI.
2. Flat 500-file dirs → node cap + "other" clustering in MVP, not later.
3. LLM referencing unknown IDs → validate-and-drop, log rejects.
4. Analyzing branch tip instead of merge-base → always `git merge-base`.
5. Generated/vendored code dominating → deny-list + .gitignore.
6. Rename+heavy-edit as add+delete → accepted, labeled in UI copy.
7. Explanation/diagram desync → tile .md regenerated in the same job as tile .json, always.
8. Prompt injection from repo content → quoted-data framing, no tools, strict JSON, no secrets in prompts.

## Success criteria

Reviewer opens a real PR and can answer, in under a minute: which architectural areas does this PR touch; what new/removed dependencies cross them; which exact hunks support that — without reading the full file list. Tile fetches <50KB; drill-down feels instant (<200ms perceived with prefetch).
