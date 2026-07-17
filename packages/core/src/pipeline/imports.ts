import { cruise } from "dependency-cruiser";
import { existsSync } from "node:fs";
import ts from "typescript";
import path from "node:path";

export interface ImportGraph {
  /** repo-relative file -> repo-relative imported files */
  edges: Map<string, Set<string>>;
  files: string[];
  unresolvedImports: number; // relative/alias imports we could not resolve (npm names excluded)
}

const EXCLUDE_RE =
  "(^|/)(node_modules|dist|build|out|coverage|vendor|\\.next|\\.sst|\\.git|__generated__|generated)(/|$)|\\.(d\\.ts|min\\.js)$";

const EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

export async function scanImports(repoDir: string): Promise<ImportGraph> {
  const tsconfigPath = ["tsconfig.json", "tsconfig.base.json", "jsconfig.json"]
    .map((f) => path.join(repoDir, f))
    .find((p) => existsSync(p));

  const aliasResolver = buildAliasResolver(repoDir, tsconfigPath);

  const result = await cruise([repoDir], {
    exclude: { path: EXCLUDE_RE },
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    ...(tsconfigPath ? { tsConfig: { fileName: tsconfigPath } } : {}),
  });

  const output = typeof result.output === "string" ? JSON.parse(result.output) : result.output;
  const edges = new Map<string, Set<string>>();
  const files: string[] = [];
  let unresolved = 0;

  const rel = (p: string) => path.relative(repoDir, path.resolve(repoDir, p));

  for (const mod of output.modules ?? []) {
    const source = rel(mod.source);
    if (source.startsWith("..")) continue;
    if (!isCodeFile(source)) continue;
    files.push(source);
    for (const dep of mod.dependencies ?? []) {
      let target: string | null = null;
      if (dep.couldNotResolve) {
        // dependency-cruiser's API doesn't apply tsconfig "paths" — resolve aliases
        // and relative stragglers ourselves; bare npm names are expected to fail
        // (no node_modules in the analysis clone) and don't count as coverage gaps.
        target = aliasResolver(dep.module, path.dirname(path.resolve(repoDir, mod.source)));
        if (!target) {
          if (dep.module.startsWith(".") || aliasResolver.isAliasShaped(dep.module)) unresolved++;
          continue;
        }
      } else {
        if (dep.dependencyTypes?.includes("npm") || dep.resolved?.includes("node_modules")) continue;
        target = rel(dep.resolved);
      }
      if (target.startsWith("..") || !isCodeFile(target)) continue;
      if (!edges.has(source)) edges.set(source, new Set());
      edges.get(source)!.add(target);
    }
  }
  return { edges, files: [...new Set(files)].sort(), unresolvedImports: unresolved };
}

interface AliasResolver {
  (spec: string, fromDir: string): string | null;
  isAliasShaped(spec: string): boolean;
}

/**
 * Minimal tsconfig "paths" + relative-import resolver: prefix substitution with
 * extension/index probing. Returns a repo-relative path or null.
 */
function buildAliasResolver(repoDir: string, tsconfigPath: string | undefined): AliasResolver {
  interface AliasRule {
    prefix: string; // "@/" for "@/*"
    exact: boolean;
    targets: string[]; // absolute dir/file prefixes
  }
  const rules: AliasRule[] = [];

  if (tsconfigPath) {
    const cfg = readTsconfigChain(tsconfigPath);
    const baseUrl = path.resolve(path.dirname(tsconfigPath), cfg.baseUrl ?? ".");
    for (const [pattern, targets] of Object.entries(cfg.paths ?? {})) {
      const star = pattern.indexOf("*");
      rules.push({
        prefix: star >= 0 ? pattern.slice(0, star) : pattern,
        exact: star < 0,
        targets: (targets as string[]).map((t) => path.resolve(baseUrl, t.replace("*", ""))),
      });
    }
  }

  const probe = (abs: string): string | null => {
    const candidates = [abs, ...EXTS.map((e) => abs + e), ...EXTS.map((e) => path.join(abs, "index" + e))];
    for (const c of candidates) {
      if (existsSync(c) && isCodeFile(c)) {
        const r = path.relative(repoDir, c);
        if (!r.startsWith("..")) return r;
      }
    }
    return null;
  };

  const resolver = ((spec: string, fromDir: string): string | null => {
    if (spec.startsWith(".")) return probe(path.resolve(fromDir, spec));
    for (const rule of rules) {
      if (rule.exact ? spec === rule.prefix : spec.startsWith(rule.prefix)) {
        const rest = rule.exact ? "" : spec.slice(rule.prefix.length);
        for (const t of rule.targets) {
          const hit = probe(path.join(t, rest));
          if (hit) return hit;
        }
      }
    }
    return null;
  }) as AliasResolver;

  resolver.isAliasShaped = (spec: string) =>
    rules.some((r) => (r.exact ? spec === r.prefix : spec.startsWith(r.prefix))) ||
    spec.startsWith("~/") ||
    spec.startsWith("@/");

  return resolver;
}

/** parse tsconfig via the TypeScript compiler API (JSONC + full `extends` chain) */
function readTsconfigChain(file: string): { baseUrl?: string; paths?: Record<string, string[]> } {
  try {
    const read = ts.readConfigFile(file, ts.sys.readFile);
    if (read.error || !read.config) return {};
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(file));
    return {
      baseUrl: parsed.options.baseUrl,
      paths: parsed.options.paths as Record<string, string[]> | undefined,
    };
  } catch {
    return {};
  }
}

export function isCodeFile(p: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(p) && !/\.d\.ts$/.test(p);
}
