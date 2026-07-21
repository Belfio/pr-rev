# Flows → before/after feature documentation

## Context

The **Flows** tab originally rendered entrypoint-traced **node/edge graphs** (React
Flow), generated from source at the merge-base SHA, with the PR only highlighting which
existing nodes were touched — there was no "after" state anywhere. This reframes Flows
into **documentation**, in the spirit of a hand-maintained `docs/` folder (e.g. a
`payment-flow.md` or `discover-agent-architecture.md`): a prose + ASCII narrative that
explains how a feature worked **before** the PR and how it **changes after**, with each
section clickable for detail (what changed, affected files, the real diff).

House style emulated: one-line purpose → `## At A Glance` ASCII diagram → invariant
bullets → numbered steps (each with `Route:`/`Service:` file paths, "What happens"
bullets, "Important detail:" callouts) → "Flow Summary" recap. **ASCII, not mermaid.**

## Decisions

1. **Generate both states from code** — "before" from the merge-base source (already
   cloned), "after" from the PR's per-file diffs (`PrFile.patch`). No second clone.
2. **One doc per touched feature** — reuse the existing entrypoint flow discovery to
   pick features; keep the `direct`/`shared` classification for ranking/labels.
3. **One doc + change callouts** — a single narrative annotated green=Added /
   amber=Changed / ghost=Removed (the triptych's existing color language).
4. **Split-screen drill-down** — doc outline left; per-section detail right. Replaces
   the Flows graph; Folders and Data tabs untouched.

## Data model (as implemented, `packages/core/src/schemas.ts`)

```ts
interface DocSection {
  id: string;              // stable slug within the doc; fixed across PRs at same base
  ordinal: number;         // 1-based; sole source of the step number
  heading: string;         // clean display text — no leading "###" or "N." (normalized at write time)
  files: string[];         // validated ⊆ graph.files ∪ PR files
  overview: string;        // "What happens" markdown, may be ""
  importantDetail: string; // callout, may be ""
}
interface FeatureDoc {      // BASE narrative, merge-base state, no PR annotations
  slug: string; title: string; purpose: string;
  atAGlance: string;        // RAW ascii (no fence); render in <pre>; may be ""
  coreModel: string[];      // invariant bullets, may be []
  sections: DocSection[];
  summary: string;          // may be ""
}
interface FeatureDocSectionChange {
  change: "added" | "changed" | "removed";
  changeNarrative: string;  // before → after prose, may be ""
  files: string[];
  hunkRefs: HunkRef[];      // reused tile HunkRef; DiffView reads hunkRefs[].patchUri
}
interface FeatureDocOverlay { // PR change layer, keyed by (prNumber, headSha)
  slug: string;
  sectionChanges: Record<string /*sectionId*/, FeatureDocSectionChange>;
  addedSections: DocSection[]; // net-new sections from PR-added files
}
// OverlayManifest gains: features: { slug, title, direct, shared }[]
```

**Rendering contract:** merged sections = base `sections` ++ `addedSections`, ordered by
`ordinal`; apply badge/prose from `sectionChanges[section.id]` (absent ⇒ unchanged).
Every added section is guaranteed a `sectionChanges[id]` entry with `change:"added"`, so
the per-feature badge count is `Object.keys(sectionChanges).length` (no double-count).

## Artifacts

- **Base narrative** (additive cache, PR-independent, keyed by baseSha):
  `analysis/{owner}/{repo}/{baseSha}/docs/feature:<slug>.json` — never overwritten by a
  later PR at the same base; only missing slugs are added.
- **Change overlay** (per PR): `pr/{owner}/{repo}/{n}/{headSha}/overlays/feature:<slug>.json`.
- **Feature list**: `OverlayManifest.features` (PR prefix). `AnalysisManifest.flows` is
  deprecated (always `[]`).
- Filename stem = `featureFileName(slug)` = `("feature:"+slug).replaceAll("/","__")`
  (exported from `@pr-rev/core/schemas`; slugs use dots, so the colon is kept literally).

## Architecture

**`packages/core`.** `src/llm/flow-doc.ts` (replaces `flow-extract.ts`) — heavy tier,
two modes: **full** (no cached base doc → emit `FeatureDoc` + change layer in one call)
and **overlay-only** (cached base doc exists → read it back, ask only for the change
layer keyed to its fixed section ids, guaranteeing section-id stability across PRs at the
same base). `--skip-llm` produces a deterministic skeleton (sections = reachable files
grouped by directory, badges from `changedFiles` membership, no prose). `attributeDiffs()`
(in `pipeline/flows.ts`) selects the PR files backing each feature: `filename` or
`previousFilename` ∈ reachable, or the added file imports/is-imported-by a reachable file,
or it sits under a represented directory. Hallucination guard: `files[]` validated against
`graph.files ∪ PR filenames ∪ previousFilenames`; unknown dropped. Headings normalized to
clean text via `cleanHeading()` at every DocSection construction. `run.ts` no longer
pushes flow tiles into `build.tiles` (removing them from layout/decorate/tile-writes/
manifest); flow branches pruned from `overlay.ts`, `decorate.ts`, `layout.ts`. `hunkRefFor`
hoisted/exported from `overlay.ts`.

**`packages/functions`.** `chat-context.ts`: tileId regex widened to allow `:` (chat on
Flows was already broken by this today); a `feature:` branch hydrates from the base doc +
doc overlay, treats `selectedNodeId` as a `DocSection.id`, and pulls diffs from that
section's `hunkRefs`. Degrades gracefully; never throws. No server route change.

**`packages/web`.** `isFeatureId()` replaces hardcoded `flow:` prefix checks (store view
guard, LeftPane enter/select, prefetch). New `FeatureDocPane.tsx` (left) renders the doc
outline; `TextPane.tsx` gains a feature branch (tile queries gated off, queries the doc +
overlay, renders selected-section detail via the existing `DiffView` from `hunkRefs`).
`FlowsView` is driven by `overlayManifest.features`; React Flow stays for Folders only.

## Known limitation

Diff attribution is intentionally coarse: changes in shared dirs (`src/lib`,
`src/components`) attribute to many features, so some PRs show most/all features as
`direct` with shared sections. Narrowing lever (not yet pulled): drop the bare
directory-adjacency clause, keep import-name overlap only.

## Verification

1. `pnpm analyze <owner>/<repo> <pr>` — base `docs/feature:*.json` (no PR annotations),
   `overlays/feature:*.json` (change layer with `hunkRefs`), `overlay-manifest.features`;
   every `files[]` path ∈ graph ∪ PR files; headings carry no `#`/ordinal prefix.
2. `pnpm analyze … --skip-llm` — deterministic skeleton, added-file sections, no prose.
3. `pnpm dev` → Flows tab: doc renders in house style; badges; chip; deep link
   `?view=flows&tile=feature:<slug>&node=<sectionId>` restores without bouncing to Folders;
   clicking a changed section shows narrative + files + real diff; chat works on the tab.
4. Second PR at the same merge-base → base `docs/` reused (additive), overlay-only LLM
   mode used, sibling overlay consistent.
