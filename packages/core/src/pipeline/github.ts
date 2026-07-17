import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

const exec = promisify(execFile);

export interface PrFile {
  filename: string;
  status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";
  previousFilename: string | null;
  patch: string | null; // unified diff hunks for this file (absent for binaries)
}

export interface PrInfo {
  owner: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  url: string;
  baseSha: string; // base branch head
  headSha: string;
  mergeBaseSha: string; // what we analyze against
  files: PrFile[];
}

async function gh(args: string[]): Promise<string> {
  const { stdout } = await exec("gh", args, { maxBuffer: 128 * 1024 * 1024 });
  return stdout;
}

export async function resolvePr(owner: string, repo: string, number: number): Promise<PrInfo> {
  const pr = JSON.parse(await gh(["api", `repos/${owner}/${repo}/pulls/${number}`]));
  const baseSha: string = pr.base.sha;
  const headSha: string = pr.head.sha;
  const compare = JSON.parse(
    await gh(["api", `repos/${owner}/${repo}/compare/${baseSha}...${headSha}`, "--jq", "{merge_base_commit: .merge_base_commit.sha}"]),
  );
  const filesRaw = JSON.parse(
    await gh([
      "api",
      `repos/${owner}/${repo}/pulls/${number}/files`,
      "--paginate",
      "--slurp",
    ]),
  ) as unknown[][];
  const files: PrFile[] = filesRaw.flat().map((f: any) => ({
    filename: f.filename,
    status: f.status,
    previousFilename: f.previous_filename ?? null,
    patch: f.patch ?? null,
  }));
  return {
    owner,
    repo,
    number,
    title: pr.title,
    author: pr.user.login,
    url: pr.html_url,
    baseSha,
    headSha,
    mergeBaseSha: compare.merge_base_commit,
    files,
  };
}

/** Shallow-fetch a single commit into destDir. Never runs repo scripts. */
export async function cloneAtSha(owner: string, repo: string, sha: string, destDir: string): Promise<void> {
  if (existsSync(`${destDir}/.git`)) return; // already materialized (cache by sha in path)
  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });
  const url = `https://github.com/${owner}/${repo}.git`;
  const git = async (...args: string[]) => {
    await exec("git", ["-C", destDir, "-c", "credential.helper=!gh auth git-credential", ...args], {
      maxBuffer: 64 * 1024 * 1024,
    });
  };
  await exec("git", ["init", "-q", destDir]);
  await git("remote", "add", "origin", url);
  await git("fetch", "-q", "--depth", "1", "origin", sha);
  await git("checkout", "-q", "FETCH_HEAD");
}
