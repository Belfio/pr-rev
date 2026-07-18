import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function gh(args: string[]): Promise<string> {
  const { stdout } = await exec("gh", args, { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

export interface PrComment {
  id: number;
  author: string;
  authorAvatar: string | null;
  body: string;
  createdAt: string;
  kind: "discussion" | "review";
  /** review comments are anchored to a file (and usually a line) */
  path: string | null;
  line: number | null;
}

export interface PrMeta {
  number: number;
  title: string;
  body: string;
  author: string;
  state: string; // open | closed
  draft: boolean;
  merged: boolean;
  url: string;
  createdAt: string;
  comments: PrComment[];
}

export function assertSafeRepo(owner: string, repo: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(owner) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo)) {
    throw new Error("invalid repo ref");
  }
}

export function assertSafeRepoRef(owner: string, repo: string, num: number): void {
  assertSafeRepo(owner, repo);
  if (!Number.isInteger(num) || num <= 0) throw new Error("invalid PR number");
}

export interface PrListItem {
  number: number;
  title: string;
  author: string;
  draft: boolean;
  createdAt: string;
  headSha: string;
  url: string;
}

export async function listOpenPrs(owner: string, repo: string): Promise<PrListItem[]> {
  assertSafeRepo(owner, repo);
  const raw = await gh(["api", `repos/${owner}/${repo}/pulls?state=open&per_page=50`]);
  const prs = JSON.parse(raw) as any[];
  return prs.map(
    (p): PrListItem => ({
      number: p.number,
      title: p.title,
      author: p.user?.login ?? "unknown",
      draft: Boolean(p.draft),
      createdAt: p.created_at,
      headSha: p.head?.sha ?? "",
      url: p.html_url,
    }),
  );
}

export async function getPrMeta(owner: string, repo: string, num: number): Promise<PrMeta> {
  assertSafeRepoRef(owner, repo, num);
  const base = `repos/${owner}/${repo}`;
  const [prRaw, issueCommentsRaw, reviewCommentsRaw] = await Promise.all([
    gh(["api", `${base}/pulls/${num}`]),
    gh(["api", `${base}/issues/${num}/comments`, "--paginate", "--slurp"]),
    gh(["api", `${base}/pulls/${num}/comments`, "--paginate", "--slurp"]),
  ]);
  const pr = JSON.parse(prRaw);
  const issueComments = (JSON.parse(issueCommentsRaw) as any[][]).flat();
  const reviewComments = (JSON.parse(reviewCommentsRaw) as any[][]).flat();

  const comments: PrComment[] = [
    ...issueComments.map(
      (c): PrComment => ({
        id: c.id,
        author: c.user?.login ?? "unknown",
        authorAvatar: c.user?.avatar_url ?? null,
        body: c.body ?? "",
        createdAt: c.created_at,
        kind: "discussion",
        path: null,
        line: null,
      }),
    ),
    ...reviewComments.map(
      (c): PrComment => ({
        id: c.id,
        author: c.user?.login ?? "unknown",
        authorAvatar: c.user?.avatar_url ?? null,
        body: c.body ?? "",
        createdAt: c.created_at,
        kind: "review",
        path: c.path ?? null,
        line: c.line ?? c.original_line ?? null,
      }),
    ),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? "",
    author: pr.user?.login ?? "unknown",
    state: pr.state,
    draft: Boolean(pr.draft),
    merged: Boolean(pr.merged),
    url: pr.html_url,
    createdAt: pr.created_at,
    comments,
  };
}

export async function postPrComment(
  owner: string,
  repo: string,
  num: number,
  body: string,
): Promise<PrComment> {
  assertSafeRepoRef(owner, repo, num);
  if (typeof body !== "string" || body.trim().length === 0) throw new Error("empty comment");
  if (body.length > 60000) throw new Error("comment too long");
  const { stdout } = await exec(
    "gh",
    ["api", "-X", "POST", `repos/${owner}/${repo}/issues/${num}/comments`, "-f", `body=${body}`],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  const c = JSON.parse(stdout);
  return {
    id: c.id,
    author: c.user?.login ?? "you",
    authorAvatar: c.user?.avatar_url ?? null,
    body: c.body ?? body,
    createdAt: c.created_at ?? new Date().toISOString(),
    kind: "discussion",
    path: null,
    line: null,
  };
}
