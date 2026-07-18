import ts from "typescript";
import ELK from "elkjs/lib/elk.bundled.js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PrInfo } from "./github.js";
import type { ImportGraph } from "./imports.js";
import { isCodeFile } from "./imports.js";
import { cloneAtSha } from "./github.js";
import type {
  DataArtifact,
  DataOverlay,
  DataEntity,
  DataEdge,
  DataField,
  DataOverlayEntity,
  DataOverlayField,
  DataMigrationOp,
} from "../schemas.js";

const elk = new ELK();

// Same flags for base and head so canonical type text is comparable across snapshots.
const TYPE_FLAGS = ts.TypeFormatFlags.NoTruncation;

const MAX_ENTITIES = 40;
const CARD_WIDTH = 240;
const MAX_DISPLAY_FIELDS = 14;

export interface BuildDataOptions {
  owner: string;
  repo: string;
  pr: PrInfo;
  baseDir: string; // merge-base clone dir (already materialized)
  workDir: string; // clone cache root
  graph: ImportGraph; // base import graph (repo-relative)
  log: (msg: string) => void;
}

export interface DataResult {
  artifact: DataArtifact;
  overlay: DataOverlay;
}

/** Files whose exported types we treat as the repo's schema. */
export function isSchemaSource(f: string): boolean {
  if (!isCodeFile(f)) return false;
  return /(^|\/)src\/types\//.test(f) || /(^|\/)types\//.test(f) || /\.types\.ts$/.test(f);
}

const MIGRATION_RE = /(^|\/)(supabase\/migrations|db\/migrations)\/.+\.sql$/i;

function unsupportedArtifact(sources: string[] = []): DataArtifact {
  return { schemaVersion: 1, status: "unsupported", sources, entities: [], edges: [], consumers: {} };
}
function unsupportedOverlay(): DataOverlay {
  return { status: "unsupported", entities: {}, addedEntities: [], migrationOps: [] };
}
function noneOverlay(): DataOverlay {
  return { status: "none", entities: {}, addedEntities: [], migrationOps: [] };
}

/**
 * Build the base Data artifact (PR-independent entity graph) and its PR overlay.
 * Fully resilient: on any failure it returns unsupported artifacts rather than
 * throwing, so the surrounding pipeline never crashes on schema quirks.
 */
export async function buildData(opts: BuildDataOptions): Promise<DataResult> {
  const { log } = opts;
  try {
    const sources = opts.graph.files.filter(isSchemaSource).sort();
    if (sources.length === 0) {
      log("Data: no schema-source files found — unsupported");
      return { artifact: unsupportedArtifact(), overlay: unsupportedOverlay() };
    }
    log(`Data: extracting entities from ${sources.length} schema source(s)...`);

    const base = extractSchema(opts.baseDir, sources, log);

    // Diff on UNCAPPED extractions (capping base and head independently fabricates
    // added/removed entities when one falls on different sides of the cap), and never
    // let an overlay failure (e.g. transient head-clone error) discard a good base artifact.
    let overlay: DataOverlay;
    try {
      overlay = await buildOverlay(opts, sources, base.entities);
    } catch (e) {
      log(`Data: overlay build failed (${(e as Error).message}) — overlay unsupported, base kept`);
      overlay = unsupportedOverlay();
    }

    // Cap what the artifact ships, but always keep entities the PR touched.
    capEntities(base, log, new Set(Object.keys(overlay.entities)));
    await layoutEntities(base.entities, base.edges);

    const consumers = buildConsumers(sources, opts.graph);
    const artifact: DataArtifact = {
      schemaVersion: 1,
      status: "ok",
      sources,
      entities: base.entities,
      edges: base.edges.filter(
        (e) =>
          base.entities.some((x) => x.id === e.source) &&
          base.entities.some((x) => x.id === e.target),
      ),
      consumers,
    };
    log(`Data: ${artifact.entities.length} entities, ${artifact.edges.length} edges`);
    return { artifact, overlay };
  } catch (e) {
    log(`Data: build failed (${(e as Error).message}) — writing unsupported artifacts`);
    return { artifact: unsupportedArtifact(), overlay: unsupportedOverlay() };
  }
}

async function buildOverlay(
  opts: BuildDataOptions,
  sources: string[],
  baseEntities: DataEntity[],
): Promise<DataOverlay> {
  const { pr, log } = opts;
  // Match ALL changed files that look like schema sources — including files newly
  // added by the PR, which are absent from the base graph's source list.
  const changedSchemaSources = [
    ...new Set(pr.files.map((f) => f.filename).filter(isSchemaSource)),
  ];
  const changedMigrations = pr.files
    .map((f) => f.filename)
    .filter((f) => MIGRATION_RE.test(f));

  if (changedSchemaSources.length === 0 && changedMigrations.length === 0) {
    log("Data: no schema or migration changes in PR — overlay status none");
    return noneOverlay();
  }

  // Something schema-relevant changed: take a full head snapshot and re-extract.
  const headDir = path.join(
    opts.workDir,
    `${opts.owner}-${opts.repo}-${pr.headSha.slice(0, 12)}-head`,
  );
  log(`Data: schema/migration changes present — cloning head into ${headDir}...`);
  await cloneAtSha(opts.owner, opts.repo, pr.headSha, headDir);

  // head schema sources = base sources still present at head + changed schema files present at head
  const headSources = [
    ...new Set([...sources, ...changedSchemaSources]),
  ].filter((s) => existsSync(path.join(headDir, s)));
  const head = extractSchema(headDir, headSources, log); // uncapped: diff needs the full set

  const { entities, addedEntities } = diffEntities(baseEntities, head.entities);
  if (addedEntities.length > 0) await layoutEntities(addedEntities, []);

  const entityNames = baseEntities.map((e) => e.name);
  const migrationOps = await parseMigrations(headDir, changedMigrations, entityNames, log);

  const hasEntityChanges = Object.keys(entities).length > 0;
  const status: DataOverlay["status"] =
    hasEntityChanges || migrationOps.length > 0 ? "ok" : "none";
  log(
    `Data: overlay status ${status} — ${Object.keys(entities).length} changed entities, ` +
      `${addedEntities.length} added, ${migrationOps.length} migration ops`,
  );
  return { status, entities, addedEntities, migrationOps };
}

// --- entity extraction -------------------------------------------------------

interface Extracted {
  entities: DataEntity[];
  edges: DataEdge[];
}

function readCompilerOptions(repoDir: string): ts.CompilerOptions {
  const tsconfigPath = ["tsconfig.json", "tsconfig.base.json", "jsconfig.json"]
    .map((f) => path.join(repoDir, f))
    .find((p) => existsSync(p));
  const base: ts.CompilerOptions = {
    noEmit: true,
    skipLibCheck: true,
    allowJs: true,
    strict: false,
  };
  if (!tsconfigPath) return base;
  try {
    const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, path.dirname(tsconfigPath));
    return {
      ...parsed.options,
      noEmit: true,
      skipLibCheck: true,
      incremental: false,
      composite: false,
      declaration: false,
      declarationMap: false,
      tsBuildInfoFile: undefined,
    };
  } catch {
    return base;
  }
}

function isExported(node: ts.Declaration): boolean {
  return (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0;
}

const norm = (p: string) => path.normalize(p);

/** Run the compiler over the schema sources and pull exported entities + reference edges. */
function extractSchema(repoDir: string, sources: string[], log: (m: string) => void): Extracted {
  const rootNames = sources.map((s) => path.resolve(repoDir, s));
  const program = ts.createProgram({ rootNames, options: readCompilerOptions(repoDir) });
  const checker = program.getTypeChecker();

  interface Collected {
    id: string;
    name: string;
    decl: ts.InterfaceDeclaration | ts.TypeAliasDeclaration;
    symbol: ts.Symbol;
    definedInRel: string;
    absFile: string; // ts's own fileName, normalized
    provenance: DataEntity["provenance"];
  }

  const collected: Collected[] = [];

  for (const relSrc of sources) {
    const abs = path.resolve(repoDir, relSrc);
    const sf = program.getSourceFile(abs);
    if (!sf) {
      log(`Data: could not load ${relSrc} into program (skipped)`);
      continue;
    }
    const text = sf.getFullText();
    const provenance: DataEntity["provenance"] =
      path.basename(sf.fileName) === "database.ts" || /export\s+interface\s+Database\b/.test(text)
        ? "generated-db"
        : "app-type";
    const definedInRel = path.relative(repoDir, sf.fileName);
    for (const stmt of sf.statements) {
      if (!ts.isInterfaceDeclaration(stmt) && !ts.isTypeAliasDeclaration(stmt)) continue;
      if (!isExported(stmt)) continue;
      const symbol = checker.getSymbolAtLocation(stmt.name);
      if (!symbol) continue;
      const name = stmt.name.text;
      collected.push({
        id: name, // may be disambiguated below when the same name is exported from several files
        name,
        decl: stmt,
        symbol,
        definedInRel,
        absFile: norm(sf.fileName),
        provenance,
      });
    }
  }

  // Disambiguate duplicate names with a STABLE suffix derived from the defining file
  // (never from iteration order — order-derived ids re-pair wrongly across base/head
  // snapshots when a file is added or removed).
  const nameCounts = new Map<string, number>();
  for (const c of collected) nameCounts.set(c.name, (nameCounts.get(c.name) ?? 0) + 1);
  for (const c of collected) {
    if ((nameCounts.get(c.name) ?? 0) > 1) c.id = `${c.name}@${c.definedInRel}`;
  }

  // file+name -> entity id, for resolving reference edges to extracted entities
  const declKeyToId = new Map<string, string>();
  for (const c of collected) declKeyToId.set(`${c.absFile}::${c.name}`, c.id);

  const entities: DataEntity[] = [];
  const edgeSet = new Set<string>();
  const edges: DataEdge[] = [];

  for (const c of collected) {
    const declared = checker.getDeclaredTypeOfSymbol(c.symbol);

    // enum-like: type alias whose declared type is a union of string literals
    if (ts.isTypeAliasDeclaration(c.decl) && declared.isUnion() && declared.types.length > 0 &&
      declared.types.every((t) => t.isStringLiteral())) {
      const values = declared.types.map((t) => (t as ts.StringLiteralType).value);
      entities.push({
        id: c.id,
        name: c.name,
        kind: "enum",
        provenance: c.provenance,
        definedIn: c.definedInRel,
        fields: [],
        values,
        pos: { x: 0, y: 0, w: 0, h: 0 },
      });
      continue;
    }

    // object: checker-resolved apparent-type members
    const apparent = checker.getApparentType(declared);
    const props = checker.getPropertiesOfType(apparent);
    const fields: DataField[] = [];
    for (const prop of props) {
      const propType = checker.getTypeOfSymbolAtLocation(prop, c.decl);
      fields.push({
        name: prop.getName(),
        type: checker.typeToString(propType, c.decl, TYPE_FLAGS),
        optional: (prop.flags & ts.SymbolFlags.Optional) !== 0,
      });
      // reference edges: which extracted entity does this field point at?
      const targetId = resolveReference(prop, propType, checker, declKeyToId, c.id);
      if (targetId) {
        const key = `${c.id}->${targetId}`;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          edges.push({ source: c.id, target: targetId, label: "references" });
        }
      }
    }
    entities.push({
      id: c.id,
      name: c.name,
      kind: "object",
      provenance: c.provenance,
      definedIn: c.definedInRel,
      fields,
      values: [],
      pos: { x: 0, y: 0, w: 0, h: 0 },
    });
  }

  return { entities, edges };
}

/**
 * Which extracted entity a field points at. Walks both the resolved property
 * type (catches `Foo[]`, non-null aliases, nested references) and the field's
 * syntactic type node (catches `Foo | null`, where the alias is flattened out of
 * the resolved union), unwrapping arrays/unions/generics but NOT descending into
 * inline object literals. Returns the id only when exactly one entity matches.
 */
function resolveReference(
  prop: ts.Symbol,
  type: ts.Type,
  checker: ts.TypeChecker,
  declKeyToId: Map<string, string>,
  selfId: string,
): string | null {
  const symbols = new Set<ts.Symbol>();

  // 1. resolved-type walk
  const seen = new Set<ts.Type>();
  const walkType = (t: ts.Type) => {
    if (seen.has(t)) return;
    seen.add(t);
    if (t.aliasSymbol) symbols.add(t.aliasSymbol);
    const sym = t.getSymbol();
    if (sym) symbols.add(sym);
    if (t.isUnionOrIntersection()) {
      for (const x of t.types) walkType(x);
      return;
    }
    const objectFlags = (t.flags & ts.TypeFlags.Object) !== 0 ? (t as ts.ObjectType).objectFlags : 0;
    if (objectFlags & ts.ObjectFlags.Reference) {
      for (const a of checker.getTypeArguments(t as ts.TypeReference)) walkType(a);
    }
  };
  walkType(type);

  // 2. syntactic type-node walk (preserves `X | null` alias references)
  const typeNode = (prop.valueDeclaration ?? prop.declarations?.[0]) as
    | ts.PropertySignature
    | ts.PropertyDeclaration
    | undefined;
  const walkNode = (node: ts.TypeNode) => {
    if (ts.isTypeReferenceNode(node)) {
      let sym = checker.getSymbolAtLocation(node.typeName);
      if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
      if (sym) symbols.add(sym);
      for (const a of node.typeArguments ?? []) walkNode(a); // Array<Foo>, Record<string, Foo>
    } else if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
      for (const x of node.types) walkNode(x);
    } else if (ts.isArrayTypeNode(node)) {
      walkNode(node.elementType);
    } else if (ts.isParenthesizedTypeNode(node)) {
      walkNode(node.type);
    } else if (ts.isTupleTypeNode(node)) {
      for (const el of node.elements) walkNode(el);
    }
    // deliberately do not descend into TypeLiteral (inline object shapes)
  };
  if (typeNode?.type) walkNode(typeNode.type);

  const matched = new Set<string>();
  for (const sym of symbols) {
    const name = sym.getName();
    for (const d of sym.getDeclarations() ?? []) {
      const id = declKeyToId.get(`${norm(d.getSourceFile().fileName)}::${name}`);
      if (id && id !== selfId) matched.add(id);
    }
  }
  return matched.size === 1 ? [...matched][0]! : null; // ambiguous or none -> omit
}

/** Keep the 40 largest entities (by displayed-row count), always retaining `keep`; log any cut. */
function capEntities(ex: Extracted, log: (m: string) => void, keep: Set<string> = new Set()): void {
  if (ex.entities.length <= MAX_ENTITIES) return;
  const rows = (e: DataEntity) => (e.kind === "enum" ? e.values.length : e.fields.length);
  ex.entities.sort((a, b) => Number(keep.has(b.id)) - Number(keep.has(a.id)) || rows(b) - rows(a));
  const cut = ex.entities.slice(MAX_ENTITIES);
  log(`Data: capping at ${MAX_ENTITIES} entities — cut ${cut.map((e) => e.id).join(", ")}`);
  ex.entities = ex.entities.slice(0, MAX_ENTITIES);
  const kept = new Set(ex.entities.map((e) => e.id));
  ex.edges = ex.edges.filter((e) => kept.has(e.source) && kept.has(e.target));
}

// --- consumers (reverse import lookup) --------------------------------------

function buildConsumers(sources: string[], graph: ImportGraph): Record<string, string[]> {
  const sourceSet = new Set(sources);
  const consumers: Record<string, string[]> = {};
  for (const s of sources) consumers[s] = [];
  for (const [importer, targets] of graph.edges) {
    for (const t of targets) {
      if (sourceSet.has(t) && importer !== t) consumers[t]!.push(importer);
    }
  }
  for (const s of sources) consumers[s] = [...new Set(consumers[s])].sort();
  return consumers;
}

// --- ELK layout for entity cards --------------------------------------------

async function layoutEntities(entities: DataEntity[], edges: DataEdge[]): Promise<void> {
  if (entities.length === 0) return;
  const ids = new Set(entities.map((e) => e.id));
  const rows = (e: DataEntity) => (e.kind === "enum" ? e.values.length : e.fields.length);
  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.spacing.nodeNode": "40",
      "elk.layered.spacing.nodeNodeBetweenLayers": "80",
    },
    children: entities.map((e) => ({
      id: e.id,
      width: CARD_WIDTH,
      height: 44 + 22 * Math.min(rows(e), MAX_DISPLAY_FIELDS),
    })),
    edges: edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e, i) => ({ id: `de${i}`, sources: [e.source], targets: [e.target] })),
  };
  const res = await elk.layout(graph);
  const byId = new Map(res.children?.map((c) => [c.id, c]) ?? []);
  for (const e of entities) {
    const c = byId.get(e.id);
    e.pos = {
      x: Math.round(c?.x ?? 0),
      y: Math.round(c?.y ?? 0),
      w: Math.round(c?.width ?? CARD_WIDTH),
      h: Math.round(c?.height ?? 44),
    };
  }
}

// --- base/head diff ----------------------------------------------------------

function diffEntities(
  base: DataEntity[],
  head: DataEntity[],
): { entities: Record<string, DataOverlayEntity>; addedEntities: DataEntity[] } {
  // Pair snapshots by declaration identity (file + exported name), NOT by display id —
  // ids carry disambiguation suffixes that can differ between base and head when a
  // same-named entity appears or disappears elsewhere. Overlay records are keyed by
  // the BASE entity's id when one exists (that's what the artifact/UI knows).
  const key = (e: DataEntity) => `${e.definedIn}::${e.name}`;
  const baseByKey = new Map(base.map((e) => [key(e), e]));
  const headByKey = new Map(head.map((e) => [key(e), e]));
  const entities: Record<string, DataOverlayEntity> = {};
  const addedEntities: DataEntity[] = [];

  for (const h of head) {
    const b = baseByKey.get(key(h));
    if (!b) {
      addedEntities.push(h);
      entities[h.id] = {
        status: "added",
        fields: {},
        valuesAdded: h.kind === "enum" ? h.values : [],
        valuesRemoved: [],
      };
      continue;
    }
    if (b.kind === "enum" || h.kind === "enum") {
      const bv = new Set(b.values);
      const hv = new Set(h.values);
      const valuesAdded = h.values.filter((v) => !bv.has(v));
      const valuesRemoved = b.values.filter((v) => !hv.has(v));
      if (valuesAdded.length > 0 || valuesRemoved.length > 0 || b.kind !== h.kind) {
        entities[b.id] = { status: "modified", fields: {}, valuesAdded, valuesRemoved };
      }
      continue;
    }
    const bf = new Map(b.fields.map((f) => [f.name, f]));
    const hf = new Map(h.fields.map((f) => [f.name, f]));
    const fields: Record<string, DataOverlayField> = {};
    for (const [name, f] of hf) {
      const prev = bf.get(name);
      if (!prev) fields[name] = { status: "added", type: f.type, prevType: null };
      else if (prev.type !== f.type || prev.optional !== f.optional)
        fields[name] = { status: "changed", type: f.type, prevType: prev.type };
    }
    for (const [name, f] of bf) {
      if (!hf.has(name)) fields[name] = { status: "removed", type: null, prevType: f.type };
    }
    if (Object.keys(fields).length > 0) {
      entities[b.id] = { status: "modified", fields, valuesAdded: [], valuesRemoved: [] };
    }
  }

  for (const b of base) {
    if (!headByKey.has(key(b))) {
      entities[b.id] = { status: "removed", fields: {}, valuesAdded: [], valuesRemoved: [] };
    }
  }
  return { entities, addedEntities };
}

// --- migration parsing -------------------------------------------------------

async function parseMigrations(
  headDir: string,
  files: string[],
  entityNames: string[],
  log: (m: string) => void,
): Promise<DataMigrationOp[]> {
  const ops: DataMigrationOp[] = [];
  for (const file of files) {
    const abs = path.join(headDir, file);
    if (!existsSync(abs)) continue; // removed in PR, or not present at head
    let sql: string;
    try {
      sql = await readFile(abs, "utf8");
    } catch (e) {
      log(`Data: could not read migration ${file} (${(e as Error).message})`);
      continue;
    }
    ops.push(...parseMigrationSql(sql, file, entityNames));
  }
  return ops;
}

// Strip a schema qualifier ("public.families" -> "families") BEFORE normalizing,
// so qualified SQL table names can still match entity names.
const normTable = (s: string) => (s.toLowerCase().split(".").pop() ?? "").replace(/[_"'`]/g, "");

/** Resolve a raw SQL table name to an entity name on a confident match, else keep it raw. */
function matchTable(raw: string, entityNames: string[]): string {
  const t = normTable(raw);
  for (const name of entityNames) {
    const n = normTable(name);
    if (n === t || `${n}s` === t) return name;
  }
  return raw.replace(/["'`]/g, "");
}

function parseMigrationSql(sql: string, file: string, entityNames: string[]): DataMigrationOp[] {
  const ops: DataMigrationOp[] = [];
  // Strip line/block comments AND dollar-quoted bodies (function definitions etc. —
  // the ';'s inside `$$ ... $$` would otherwise fragment one statement into garbage
  // ops), then split conservatively on ';'.
  const cleaned = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, " $body$ ");
  for (const rawStmt of cleaned.split(";")) {
    const stmt = rawStmt.replace(/\s+/g, " ").trim();
    if (!stmt) continue;
    const op = recognize(stmt, file, entityNames);
    ops.push(op);
  }
  return ops;
}

const IDENT = `(?:"[^"]+"|\`[^\`]+\`|[\\w.]+)`;

function recognize(stmt: string, file: string, entityNames: string[]): DataMigrationOp {
  const label = (s: string) => (s.length > 160 ? `${s.slice(0, 157)}...` : s);
  let m: RegExpMatchArray | null;

  if ((m = stmt.match(new RegExp(`^CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})`, "i")))) {
    return { file, op: label(stmt), table: matchTable(m[1]!, entityNames), analyzed: true };
  }
  if ((m = stmt.match(new RegExp(`^DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(${IDENT})`, "i")))) {
    return { file, op: label(stmt), table: matchTable(m[1]!, entityNames), analyzed: true };
  }
  if ((m = stmt.match(new RegExp(`^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(${IDENT})\\s+(ADD|DROP|ALTER|RENAME)\\b`, "i")))) {
    return { file, op: label(stmt), table: matchTable(m[1]!, entityNames), analyzed: true };
  }
  // anything else in a changed migration file: recorded but not analyzed
  return { file, op: stmt.length > 80 ? `${stmt.slice(0, 77)}...` : stmt, table: null, analyzed: false };
}
