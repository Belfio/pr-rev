# pr-rev — diagram-first PR review

pr-rev reviews a GitHub pull request top-down instead of file-by-file. It runs static
analysis over the repository at the PR's merge-base to build a ground-truth picture of what
exists and how it connects, maps the diff onto that picture, and has an LLM label and explain
it — never invent it. The result is a split-screen review app: navigable diagrams of the
codebase on the left with PR-touched elements highlighted, and LLM explanations, diff
snippets, and a context-aware chat on the right.

The left pane has three views of the same PR:

- **Folders** — a drill-down structure map of the repo (modules → directories → files).
  Double-click a node to descend, breadcrumbs to go back up. Added nodes are green, modified
  amber, removed ghosted.
- **Flows** — the PR's behavior as UX/algorithm step diagrams traced from entrypoints. A
  focused PR ideally touches a *single* flow; the Flows tab makes that legible — it shows
  `N direct · M via shared deps` and turns green when one flow is directly changed, amber
  when the change fans out across several.
- **Data** — entity cards (types, DB schema, enums) with field-level diffs for the PR. It is
  honest about coverage: repos with no discoverable schema say so rather than inventing one.

Two artifact layers make this cheap to recompute: a **base** analysis keyed by the merge-base
SHA (reusable across PRs of the same base) and a **PR overlay** keyed by `(prNumber, headSha)`
(a force-push mints a new overlay without touching the base).

Design docs: [`docs/superpowers/specs/2026-07-17-pr-rev-design.md`](docs/superpowers/specs/2026-07-17-pr-rev-design.md)
and [`docs/superpowers/specs/2026-07-17-triptych-contract.md`](docs/superpowers/specs/2026-07-17-triptych-contract.md).

## Requirements

- **Node 20+** and **pnpm** (`corepack enable` will provide pnpm).
- **git** on the PATH (the pipeline shells out to it for merge-base resolution and a shallow
  fetch of the target repo).
- **GitHub CLI (`gh`), authenticated** — used to resolve the PR and to read/post PR comments.
  Check with `gh auth status`; authenticate with `gh auth login`.
- **An LLM backend** (only needed for explanations — `--skip-llm` needs neither):
  - **Claude CLI mode (default, no key).** If `ANTHROPIC_API_KEY` is *not* set, pr-rev shells
    out to the `claude` CLI (`claude -p`), riding your existing Claude subscription. No API
    key, no per-token billing. The heavy tier uses your configured default model; the light
    (per-tile) tier uses `haiku`.
  - **API-key mode.** Export `ANTHROPIC_API_KEY` and pr-rev calls the Anthropic API directly,
    billed per token. Heavy tier defaults to `claude-opus-4-8`, light tier to
    `claude-haiku-4-5`.

### Cost & latency

- `--skip-llm` is free and fast — structure, flows, and data extraction only, no explanations.
- A full analysis of a ~1000-file repo is roughly 60–120 tile explanations: a few minutes and,
  in API mode, on the order of a few dollars (CLI mode draws on your subscription instead).
  Smaller repos are proportionally cheaper — the sample `Belfio/ourway#67` (216 files) produces
  31 tiles.
- A per-PR overlay re-run is a handful of LLM calls: pennies, ~30 seconds.
- The first analysis of a large repo is the slow one; re-runs against the same base are much
  cheaper (file summaries are cached by content hash).

## Quick start

```sh
pnpm install

# 1. analyze a PR — writes ./artifacts/ (uses gh for GitHub, an LLM backend for explanations)
pnpm analyze owner/repo 123

# 2. run the app (API on :3001, web on :5173)
pnpm dev

# 3. open http://localhost:5173
```

To try the pipeline without any LLM (fast, free, structure-only):

```sh
pnpm analyze owner/repo 123 --skip-llm
```

Analyze more PRs at any time; each appears in the app's review list. Re-run `pnpm dev` is not
needed between analyses — the API serves whatever is in `./artifacts/`.

## How it works

The pipeline (`packages/core`) resolves the PR via `gh`, shallow-fetches the repo at the
merge-base, builds an import graph with dependency-cruiser wired to the repo's `tsconfig.json`
(so path aliases resolve), groups it into a hierarchy of ≤30-node "tiles" with ELK layouts
baked in, maps the diff onto that hierarchy as a separate overlay, extracts flows and data
entities, and has the LLM decorate each tile. Every node/edge ID the LLM emits is validated
against the static graph and dropped if unknown — hallucinated architecture is impossible by
construction.

Artifacts (`./artifacts/`) are immutable JSON/markdown whose local directory layout mirrors
the future S3 key layout byte-for-byte. The API (`packages/functions`, Hono) serves artifacts
and a chat endpoint that hydrates context server-side and streams SSE. The web app
(`packages/web`, Vite + React + React Flow) does zero client-side layout — positions ship in
the tile — and holds only the current tile plus prefetched neighbors.

See the design docs linked above for the full architecture.

## Configuration

All optional; sensible defaults for local use.

| Variable | Applies to | Default | Purpose |
| --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | pipeline, chat | unset | If set, use the Anthropic API instead of the `claude` CLI. |
| `PR_REV_MODEL` | pipeline, chat | API mode: `claude-opus-4-8`; CLI mode: your configured default | Heavy-tier model (synthesis, chat). |
| `PR_REV_LIGHT_MODEL` | pipeline | API mode: `claude-haiku-4-5`; CLI mode: `haiku` | Light-tier model (per-tile decoration). |
| `PORT` | API server + web proxy | `3001` | API port. The web dev server proxies `/api` to this port, so moving one moves both. |
| `WEB_PORT` | web dev server | `5173` | Web dev-server port. |
| `ARTIFACTS_DIR` | API server | `<repo>/artifacts` | Directory the API serves artifacts from. (The `analyze` CLI always writes to `<repo>/artifacts`.) |
| `IMMUTABLE_ARTIFACTS` | API server | unset | When set, send long-lived immutable cache headers. Leave unset for local dev, where artifacts are regenerated in place. |

Example — run the whole stack on alternate ports:

```sh
PORT=3101 WEB_PORT=5273 pnpm dev   # API on :3101, web on :5273 (proxy follows PORT)
```

## Troubleshooting

- **`gh` not authenticated** — analysis fails at the PR-resolution step. Run `gh auth status`,
  then `gh auth login`.
- **`claude: command not found`** — you're in the default (CLI) LLM mode without the Claude
  CLI installed. Either install and log into the `claude` CLI, export `ANTHROPIC_API_KEY` to
  use API mode, or run with `--skip-llm` to skip explanations entirely.
- **First analysis of a large repo is slow** — expected; it's the tile-explanation calls.
  Subsequent runs against the same merge-base are much faster (content-hash summary cache).
  Use `--skip-llm` while iterating on structure.
- **Port already in use** — set `PORT` / `WEB_PORT` (see Configuration).
- **Missing edges / `unresolvedImports` > 0** — the repo's `tsconfig.json` path aliases may not
  fully resolve. Coverage numbers are surfaced honestly rather than hidden; a diagram that
  admits gaps beats one that silently drops edges.

## Project status

Early and local-first. The analyze → serve → browse → chat loop works end-to-end on a clean
machine. Deployment is **not** wired up: `sst.config.ts` (SST v3: StaticSite + streaming
Function + Bucket) is checked in but untested, and the Lambda handler still needs an S3-backed
artifact store — the local server reads from disk. Treat the SST config as a starting point,
not a supported path.

## Security

- **Repo content is analyzed, never executed.** The pipeline clones the target repo with
  `--filter=blob:none` and never runs its install, build, or postinstall scripts. In LLM
  prompts, repo content is quoted as untrusted data, summarization calls are given no tools,
  and outputs are schema-validated.
- **Artifacts stay local.** Analysis output is written under `./artifacts/` on your machine.
  The API validates artifact paths (including symlink resolution) to stay within that
  directory. Nothing is uploaded anywhere by default.
- In CLI mode, prompts go to your local `claude` CLI; in API mode, to the Anthropic API. No
  secrets are placed in prompts.

## License

MIT — see [LICENSE](LICENSE).
