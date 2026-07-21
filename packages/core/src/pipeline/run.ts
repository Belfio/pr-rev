import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { resolvePr, cloneAtSha } from "./github.js";
import { scanImports } from "./imports.js";
import { buildDirTree, buildTiles } from "./tiles.js";
import { buildFlowSpecs, attributeDiffs } from "./flows.js";
import {
  generateFeatureDoc,
  generateFeatureDocOverlay,
  buildSkeletonFeatureDoc,
  classifyFeature,
  type FeatureResult,
} from "../llm/flow-doc.js";
import { layoutTile } from "./layout.js";
import { buildOverlay } from "./overlay.js";
import { buildData } from "./data.js";
import { createLlmClient, pMap } from "../llm/client.js";
import { decorateTile, explainOverlay, summarizePr } from "../llm/decorate.js";
import {
  Tile as TileSchema,
  DataArtifact as DataArtifactSchema,
  DataOverlay as DataOverlaySchema,
  FeatureDoc as FeatureDocSchema,
  FeatureDocOverlay as FeatureDocOverlaySchema,
  analysisPrefix,
  prPrefix,
  tileFileName,
  featureFileName,
  type AnalysisManifest,
  type FeatureDoc,
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

  log("Computing layouts (ELK)...");
  for (const tile of build.tiles) await layoutTile(tile);

  log("Building PR overlay...");
  const overlayBuild = buildOverlay(pr, build);
  log(`  ${overlayBuild.overlays.size} touched tiles`);

  // --- Feature docs (before/after documentation, replaces flow diagrams) ---
  // Validation set for dropping hallucinated paths: the static graph plus all PR
  // filenames (added files are never in the merge-base graph).
  const validFiles = new Set<string>(graph.files);
  for (const f of pr.files) {
    validFiles.add(f.filename);
    if (f.previousFilename) validFiles.add(f.previousFilename);
  }
  const baseDocsDir = path.join(
    opts.artifactsDir,
    analysisPrefix(opts.owner, opts.repo, pr.mergeBaseSha),
    "docs",
  );
  const readCachedBaseDoc = async (slug: string): Promise<FeatureDoc | null> => {
    const p = path.join(baseDocsDir, `${featureFileName(slug)}.json`);
    if (!existsSync(p)) return null;
    try {
      return FeatureDocSchema.parse(JSON.parse(await readFile(p, "utf8")));
    } catch {
      return null; // stale/invalid cache: regenerate
    }
  };

  log(`Generating ${specs.length} feature docs${opts.skipLlm ? " (deterministic skeleton)" : " (LLM, from source + diffs)"}...`);
  const featureResults = await pMap(
    specs,
    async (spec): Promise<FeatureResult> => {
      const attributed = attributeDiffs(spec, pr.files);
      const existingBase = await readCachedBaseDoc(spec.slug);

      const skeleton = (): FeatureResult => {
        const { doc, baseDocToWrite, overlay } = buildSkeletonFeatureDoc(
          spec,
          attributed,
          validFiles,
          existingBase,
        );
        const { direct, shared } = classifyFeature(spec, doc, overlay, attributed);
        return { slug: spec.slug, title: doc.title, baseDocToWrite, doc, overlay, direct, shared };
      };

      // --skip-llm never generates prose: reuse a cached base doc as-is (any
      // generator — never downgrade an llm doc), else write a skeleton.
      if (opts.skipLlm) return skeleton();

      // A cached base doc is a hit (→ overlay-only) ONLY when it's an llm doc.
      // A missing or skeleton base doc runs FULL mode and (re)writes the base — the
      // single allowed overwrite: the one-way skeleton→llm upgrade.
      const cachedLlm = existingBase?.generator === "llm";
      try {
        if (cachedLlm) {
          log(`  · feature ${spec.title}: cached llm base doc — overlay-only mode`);
          const overlay = await generateFeatureDocOverlay(llm, existingBase!, spec, attributed, validFiles);
          if (overlay) {
            const { direct, shared } = classifyFeature(spec, existingBase!, overlay, attributed);
            return { slug: spec.slug, title: existingBase!.title, baseDocToWrite: null, doc: existingBase!, overlay, direct, shared };
          }
        } else {
          log(`  · feature ${spec.title}: ${existingBase ? "upgrading skeleton base doc" : "new base doc"} — full mode`);
          const full = await generateFeatureDoc(llm, repoDir, spec, attributed, validFiles);
          if (full) {
            const { direct, shared } = classifyFeature(spec, full.doc, full.overlay, attributed);
            return { slug: spec.slug, title: full.doc.title, baseDocToWrite: full.doc, doc: full.doc, overlay: full.overlay, direct, shared };
          }
        }
        log(`  ! feature ${spec.title}: generation invalid, using skeleton`);
      } catch (e) {
        log(`  ! feature ${spec.title}: ${(e as Error).message} — using skeleton`);
      }
      return skeleton();
    },
    opts.concurrency ?? 6,
  );
  overlayBuild.manifest.features = featureResults.map((r) => ({
    slug: r.slug,
    title: r.title,
    direct: r.direct,
    shared: r.shared,
  }));
  log(`  ${featureResults.length} feature docs (${featureResults.filter((r) => r.baseDocToWrite).length} new base docs)`);

  log("Building Data artifact (schema entities + PR overlay)...");
  const data = await buildData({
    owner: opts.owner,
    repo: opts.repo,
    pr,
    baseDir: repoDir,
    workDir: opts.workDir,
    graph,
    log,
  });

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
  await mkdir(path.join(aPrefix, "docs"), { recursive: true });
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

  // Feature docs: base doc is an ADDITIVE cache (write only missing slugs, never
  // overwrite a base doc from an earlier PR at the same merge-base); the doc
  // overlay is per-PR and always written.
  for (const r of featureResults) {
    // baseDocToWrite is set only for a brand-new base doc or a skeleton→llm upgrade;
    // it is null for overlay-only (cached llm) and for --skip-llm reusing a cached doc.
    // So writing whenever it is set preserves additivity AND performs the one allowed
    // overwrite (the upgrade) — an llm doc is never written over.
    if (r.baseDocToWrite) {
      FeatureDocSchema.parse(r.baseDocToWrite);
      await writeFile(
        path.join(aPrefix, "docs", `${featureFileName(r.slug)}.json`),
        JSON.stringify(r.baseDocToWrite),
      );
    }
    FeatureDocOverlaySchema.parse(r.overlay);
    await writeFile(
      path.join(pPrefix, "overlays", `${featureFileName(r.slug)}.json`),
      JSON.stringify(r.overlay),
    );
  }
  await writeFile(path.join(pPrefix, "overlay-manifest.json"), JSON.stringify(overlayBuild.manifest, null, 2));

  // Data artifacts (validate against the contract schemas before publishing)
  DataArtifactSchema.parse(data.artifact);
  DataOverlaySchema.parse(data.overlay);
  await writeFile(path.join(aPrefix, "data.json"), JSON.stringify(data.artifact));
  await writeFile(path.join(pPrefix, "data-overlay.json"), JSON.stringify(data.overlay));

  const manifest: AnalysisManifest = {
    schemaVersion: 1,
    repo: repoMeta,
    rootTileId: build.rootTileId,
    tileIds: build.tiles.map((t) => t.tileId),
    flows: [], // deprecated: feature list moved to OverlayManifest.features
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
