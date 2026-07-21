# PR Triptych — implementation contract (Folders / Flows / Data)

Agreed design (codex discussion rounds 1–2; user requirements authoritative). This is the
interface contract between the pipeline work (packages/core) and the UI work (packages/web).

## Product shape

Left pane gets three fixed primary tabs, always visible per PR:

1. **Folders** — the existing boxed drill-down structure map, unchanged.
2. **Flows** — **before/after feature documentation** (superseded the old step-diagram
   graph; see `2026-07-20-flow-docs-design.md`). Each touched feature is a narrated doc
   in the `platform/docs` house style (purpose → `At A Glance` ASCII → numbered steps),
   describing how it worked before the PR with green=Added / amber=Changed / ghost=Removed
   callouts for the change. Split-screen: doc outline left, per-section detail (what
   changed + real diff hunks) right.
   - Chip in the Flows tab bar: `N direct · M via shared deps`; green when N ≤ 1, amber when N > 1.
   - DIRECT = a PR-changed file backs a documented section of the feature.
   - SHARED = a PR-changed file is in the feature's reachable set but backs no section.
   - Default-open the direct feature when exactly one exists; otherwise show the feature list.
3. **Data** — NEW. Entity cards with field-level PR diffs. Truthful empty states:
   - `status: "none"` → "No data changes in this PR" (entities still browsable)
   - `status: "unsupported"` → "Data analysis unavailable for this repo"

Right pane unchanged (Review | Conversation).

## Artifact contract

### 1. `analysis/{owner}/{repo}/{baseSha}/data.json` (base entities, PR-independent)

```jsonc
{
  "schemaVersion": 1,
  "status": "ok" | "unsupported",
  "sources": ["src/types/database.ts"],          // schema-source files found
  "entities": [
    {
      "id": "Family",                             // exported symbol name (unique per file; suffix ~1 on collision)
      "name": "Family",
      "kind": "object" | "enum",                 // enum = string-literal union
      "provenance": "generated-db" | "app-type" | "migration",
      "definedIn": "src/types/database.ts",
      "fields": [                                 // kind=object: checker-RESOLVED apparent-type members
        { "name": "id", "type": "string", "optional": false }
      ],
      "values": ["happy", "neutral"],            // kind=enum only
      "pos": { "x": 0, "y": 0, "w": 0, "h": 0 }  // ELK precomputed, height = f(field count)
    }
  ],
  "edges": [                                      // resolved-type-text references another entity name
    { "source": "FamilyMember", "target": "MoodEmoji", "label": "references" }
  ],
  "consumers": { "src/types/database.ts": ["src/lib/family-data.ts", "..."] }
  // per defining file: files importing it (existing import graph) = "possible consumers"
}
```

Entity extraction: TypeScript compiler API; for each exported interface/type alias in
schema sources, use the checker's apparent type properties (flattens extends/intersections/
aliases/mapped types). Schema sources: `src/types/**`, `**/*.types.ts`, `types/**` (code files),
capped at 40 entities (largest by field count; log the cut). Enum-like = union of string literals.

### 2. `pr/{owner}/{repo}/{n}/{headSha}/data-overlay.json`

```jsonc
{
  "status": "ok" | "none" | "unsupported",
  "entities": {
    "Family": {
      "status": "added" | "removed" | "modified",
      "fields": { "activity_insights_enabled": { "status": "added", "type": "boolean | null", "prevType": null } },
      "valuesAdded": [], "valuesRemoved": []      // enums
    }
  },
  "addedEntities": [ /* full entity objects, laid out client-side in a band */ ],
  "migrationOps": [
    { "file": "supabase/migrations/006_x.sql", "op": "ALTER TABLE families ADD COLUMN ...", "table": "families" }
  ]
}
```

Head versions of changed schema files fetched at headSha (gh api contents); same extraction;
diff on resolved members (name/type-text/optionality). No rename inference (delete+add shown
as-is). Migration ops: conservative regex for CREATE TABLE / DROP TABLE / ALTER TABLE
ADD|DROP|ALTER COLUMN / RENAME; `table` name-matched against entities when possible.

### 3. Manifest extension (`manifest.json`)

The per-PR feature list lives on the **overlay manifest** (PR prefix), not the base
`manifest.json`: `features: [{ slug, title, direct: boolean, shared: boolean }]`. This
fixes the earlier wart where PR-relative flow classification was written under the
base-analysis prefix — the base narrative (`docs/feature:<slug>.json`) is now an
additive, PR-independent cache, and everything PR-relative (the feature list plus each
feature's change overlay) is keyed by `(prNumber, headSha)`. `AnalysisManifest.flows` is
retained but deprecated (always `[]`).

## UI contract

- View switcher rework: primary tabs `Folders | Flows | Data` (left pane). Flow selection moves
  INTO the Flows tab (its own row/tab strip listing flows, direct ones first, badge counts kept).
- Data tab: React Flow; entity-card custom node — header (icon ⛁/☰, name, provenance chip,
  status badge) + field rows (name : type, optional marker); field rows colored by diff status
  (green added / red struck removed / amber changed with `prev → new` on hover). Added entities
  in a band below. Edges rendered with existing edge styling, label "references".
- Selecting an entity → right pane Review tab shows: provenance, defined-in file, field diff
  table, migration ops touching it, and "Possible consumers (imports the schema module)" list.
- Tab labels carry counts: `Folders (changed files)`, `Flows (direct)`, `Data (changed entities)`.
- URL state: `view=data`, `entity=Family` params, same pattern as tiles.

## File ownership (parallel agents)

- **Agent A (pipeline)**: packages/core/src/pipeline/data.ts (new), run.ts wiring,
  schemas.ts additions, flows classification in manifest. Must not touch packages/web.
- **Agent B (UI)**: packages/web/** only, coding against this contract with a hand-written
  fixture artifact until A's output exists. Must not touch packages/core.
- Server: no changes needed (artifacts route already serves any file under artifacts/).

## Demo

Extend demo PR Belfio/ourway#68 branch with: a new field on `Family` in src/types/database.ts,
a matching supabase/migrations/006_activity_insights.sql, so the triptych shows all three
dimensions. Re-analyze after implementation.
