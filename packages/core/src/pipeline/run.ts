import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolvePr, cloneAtSha } from "./github.js";
import { scanImports } from "./imports.js";
import { buildDirTree, buildTiles } from "./tiles.js";
import { buildFlowSpecs, assembleExtractedFlow, assembleFallbackFlow } from "./flows.js";
import { extractFlow } from "../llm/flow-extract.js";
import { layoutTile } from "./layout.js";
import { buildOverlay } from "./overlay.js";
import { createLlmClient, pMap } from "../llm/client.js";
import { decorateTile, explainOverlay, summarizePr } from "../llm/decorate.js";
import {
  Tile as TileSchema,
  analysisPrefix,
  prPrefix,
  tileFileName,
  type AnalysisManifest,
} from "../schemas.js";

export interface AnalyzeOptions {
  owner: string;
  repo: string;
  prNumber: number;
  artifactsDir: string; // e.g. ./artifacts
  workDir: string; // clone cache
  skipLlm?: boolean;
  concurrency?: number;
  log?: (msg: string) => void;
}

export async function analyze(opts: AnalyzeOptions): Promise<void> {
  const log = opts.log ?? console.error;
  const llm = createLlmClient();
  const concurrency = opts.concurrency ?? 6;

  log(`Resolving PR ${opts.owner}/${opts.repo}#${opts.prNumber}...`);
  const pr = await resolvePr(opts.owner, opts.repo, opts.prNumber);
  log(`  merge-base ${pr.mergeBaseSha.slice(0, 10)}, head ${pr.headSha.slice(0, 10)}, ${pr.files.length} changed files`);

  const repoDir = path.join(opts.workDir, `${opts.owner}-${opts.repo}-${pr.mergeBaseSha.slice(0, 12)}`);
  log(`Fetching repo at merge-base into ${repoDir}...`);
  await cloneAtSha(opts.owner, opts.repo, pr.mergeBaseSha, repoDir);

  log("Scanning import graph (dependency-cruiser)...");
  const graph = await scanImports(repoDir);
  log(`  ${graph.files.length} code files, ${[...graph.edges.values()].reduce((a, s) => a + s.size, 0)} edges, ${graph.unresolvedImports} unresolved imports`);

  const coverage = {
    analyzedFiles: graph.files.length,
    eligibleFiles: graph.files.length,
    unresolvedImports: graph.unresolvedImports,
  };

  log("Building tile hierarchy...");
  const tree = buildDirTree(graph.files);
  const repoMeta = { owner: opts.owner, name: opts.repo, commitSha: pr.mergeBaseSha };
  const build = buildTiles(tree, graph, repoMeta, coverage);

  const changedFiles = new Set(pr.files.map((f) => f.filename));
  const specs = buildFlowSpecs(graph, changedFiles);

  log(`Extracting ${specs.length} flows${opts.skipLlm ? " (deterministic fallback)" : " (LLM, from source)"}...`);
  const assembled = await pMap(
    specs,
    async (spec) => {
      if (!opts.skipLlm) {
        try {
          const extracted = await extractFlow(llm, repoDir, spec.entry, spec.reachable, spec.title);
          if (extracted) return assembleExtractedFlow(spec, extracted, build, repoMeta, coverage);
          log(`  ! flow ${spec.title}: extraction invalid, using dependency fallback`);
        } catch (e) {
          log(`  ! flow ${spec.title}: ${(e as Error).message} — using dependency fallback`);
        }
      }
      return assembleFallbackFlow(spec, graph, build, changedFiles, repoMeta, coverage);
    },
    opts.concurrency ?? 6,
  );
  build.tiles.push(...assembled.map((a) => a.tile));
  const flowMembership = new Map<string, { tileId: string; nodeId: string }[]>();
  for (const a of assembled) {
    for (const m of a.membership) {
      if (!flowMembership.has(m.file)) flowMembership.set(m.file, []);
      flowMembership.get(m.file)!.push({ tileId: m.tileId, nodeId: m.nodeId });
    }
  }
  const flowList = specs.map((s) => ({ tileId: s.tileId, title: s.title }));
  const flowExplanations = new Map(
    assembled.filter((a) => a.explanation).map((a) => [a.tile.tileId, a.explanation!]),
  );
  log(`  ${build.tiles.length} tiles (${assembled.length} flows, ${assembled.filter((a) => a.extracted).length} LLM-extracted)`);

  log("Computing layouts (ELK)...");
  for (const tile of build.tiles) await layoutTile(tile);

  log("Building PR overlay...");
  const overlayBuild = buildOverlay(pr, build, flowMembership);
  log(`  ${overlayBuild.overlays.size} touched tiles`);

  // --- LLM passes (concurrent per tile) ---
  const explanations = new Map<string, string>(); // tileId -> md
  const overlayExplanations = new Map<string, string>();
  let prSummary = `# PR #${pr.number}: ${pr.title}\n\nby ${pr.author} — [view on GitHub](${pr.url})`;

  if (!opts.skipLlm) {
    log(`LLM: decorating ${build.tiles.length} tiles (concurrency ${concurrency})...`);
    let done = 0;
    await pMap(
      build.tiles,
      async (tile) => {
        // extracted flow tiles already carry their step narrative from extraction
        if (flowExplanations.has(tile.tileId)) {
          explanations.set(tile.tileId, flowExplanations.get(tile.tileId)!);
          return;
        }
        try {
          explanations.set(tile.tileId, await decorateTile(llm, tile));
        } catch (e) {
          log(`  ! decorate ${tile.tileId} failed: ${(e as Error).message}`);
          explanations.set(tile.tileId, `## ${tile.title}\n\n(Explanation generation failed.)`);
        }
        if (++done % 10 === 0) log(`  ${done}/${build.tiles.length}`);
      },
      concurrency,
    );

    log(`LLM: explaining ${overlayBuild.overlays.size} touched tiles...`);
    const tileById = new Map(build.tiles.map((t) => [t.tileId, t]));
    await pMap(
      [...overlayBuild.overlays.values()],
      async (overlay) => {
        const tile = tileById.get(overlay.tileId);
        if (!tile) return;
        try {
          overlayExplanations.set(overlay.tileId, await explainOverlay(llm, tile, overlay, pr));
        } catch (e) {
          log(`  ! overlay ${overlay.tileId} failed: ${(e as Error).message}`);
        }
      },
      concurrency,
    );

    log("LLM: PR summary...");
    try {
      prSummary = await summarizePr(llm, pr, overlayBuild.manifest);
    } catch (e) {
      log(`  ! summary failed: ${(e as Error).message}`);
    }
  } else {
    for (const tile of build.tiles) {
      explanations.set(tile.tileId, `## ${tile.title}\n\n${tile.nodes.length} elements, ${tile.edges.length} import relationships.`);
    }
  }

  // --- write artifacts (manifest last = atomic publish) ---
  const aPrefix = path.join(opts.artifactsDir, analysisPrefix(opts.owner, opts.repo, pr.mergeBaseSha));
  const pPrefix = path.join(opts.artifactsDir, prPrefix(opts.owner, opts.repo, pr.number, pr.headSha));
  await mkdir(path.join(aPrefix, "tiles"), { recursive: true });
  await mkdir(path.join(aPrefix, "index"), { recursive: true });
  await mkdir(path.join(pPrefix, "overlays"), { recursive: true });
  await mkdir(path.join(pPrefix, "patches"), { recursive: true });

  log(`Writing artifacts to ${opts.artifactsDir}...`);
  for (const tile of build.tiles) {
    TileSchema.parse(tile); // pipeline assertion: schema + caps hold
    const json = JSON.stringify(tile);
    if (json.length > 51200) log(`  ! tile ${tile.tileId} is ${(json.length / 1024).toFixed(1)}KB (>50KB budget)`);
    await writeFile(path.join(aPrefix, "tiles", `${tileFileName(tile.tileId)}.json`), json);
    await writeFile(
      path.join(aPrefix, "tiles", `${tileFileName(tile.tileId)}.md`),
      explanations.get(tile.tileId) ?? "",
    );
  }

  const fileToNodesObj: Record<string, { tileId: string; nodeId: string }[]> = {};
  for (const [f, entries] of build.fileToNodes) fileToNodesObj[f] = entries;
  await writeFile(path.join(aPrefix, "index", "file-to-nodes.json"), JSON.stringify(fileToNodesObj));

  for (const [escaped, patch] of overlayBuild.patches) {
    await writeFile(path.join(pPrefix, "patches", `${escaped}.patch`), patch);
  }
  for (const overlay of overlayBuild.overlays.values()) {
    await writeFile(
      path.join(pPrefix, "overlays", `${tileFileName(overlay.tileId)}.json`),
      JSON.stringify(overlay),
    );
    const md = overlayExplanations.get(overlay.tileId);
    if (md) await writeFile(path.join(pPrefix, "overlays", `${tileFileName(overlay.tileId)}.md`), md);
  }
  await writeFile(path.join(pPrefix, "overlays", "pr-summary.md"), prSummary);
  await writeFile(path.join(pPrefix, "overlay-manifest.json"), JSON.stringify(overlayBuild.manifest, null, 2));

  const manifest: AnalysisManifest = {
    schemaVersion: 1,
    repo: repoMeta,
    rootTileId: build.rootTileId,
    tileIds: build.tiles.map((t) => t.tileId),
    flows: flowList,
    coverage,
    generatedAt: new Date().toISOString(),
  };
  await writeFile(path.join(aPrefix, "manifest.json"), JSON.stringify(manifest, null, 2));

  // reviews index for the UI home page
  const reviewsPath = path.join(opts.artifactsDir, "reviews.json");
  let reviews: any[] = [];
  try {
    reviews = JSON.parse(await (await import("node:fs/promises")).readFile(reviewsPath, "utf8"));
  } catch {
    reviews = [];
  }
  reviews = reviews.filter(
    (r) => !(r.owner === opts.owner && r.repo === opts.repo && r.prNumber === pr.number),
  );
  reviews.unshift({
    owner: opts.owner,
    repo: opts.repo,
    prNumber: pr.number,
    title: pr.title,
    author: pr.author,
    baseSha: pr.mergeBaseSha,
    headSha: pr.headSha,
    url: pr.url,
    generatedAt: manifest.generatedAt,
  });
  await writeFile(reviewsPath, JSON.stringify(reviews, null, 2));

  log("Done.");
}
