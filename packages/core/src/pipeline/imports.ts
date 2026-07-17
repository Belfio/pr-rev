import { cruise } from "dependency-cruiser";
import { existsSync } from "node:fs";
import path from "node:path";

export interface ImportGraph {
  /** repo-relative file -> repo-relative imported files */
  edges: Map<string, Set<string>>;
  files: string[];
  unresolvedImports: number;
}

const EXCLUDE_RE =
  "(^|/)(node_modules|dist|build|out|coverage|vendor|\\.next|\\.sst|\\.git|__generated__|generated)(/|$)|\\.(d\\.ts|min\\.js)$";

export async function scanImports(repoDir: string): Promise<ImportGraph> {
  const tsconfigPath = ["tsconfig.json", "tsconfig.base.json", "jsconfig.json"]
    .map((f) => path.join(repoDir, f))
    .find((p) => existsSync(p));

  const result = await cruise(
    [repoDir],
    {
      exclude: { path: EXCLUDE_RE },
      doNotFollow: { path: "node_modules" },
      tsPreCompilationDeps: true,
      ...(tsconfigPath ? { ruleSet: {}, tsConfig: { fileName: tsconfigPath } } : {}),
    },
    undefined,
    tsconfigPath ? { tsConfig: { fileName: tsconfigPath } } : undefined,
  );

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
      if (dep.couldNotResolve) {
        unresolved++;
        continue;
      }
      if (dep.dependencyTypes?.includes("npm") || dep.resolved?.includes("node_modules")) continue;
      const target = rel(dep.resolved);
      if (target.startsWith("..") || !isCodeFile(target)) continue;
      if (!edges.has(source)) edges.set(source, new Set());
      edges.get(source)!.add(target);
    }
  }
  return { edges, files: [...new Set(files)].sort(), unresolvedImports: unresolved };
}

export function isCodeFile(p: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(p) && !/\.d\.ts$/.test(p);
}
