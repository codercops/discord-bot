import type { Config, Env, Program } from "./config";
import type { MergedPr } from "./leaderboard";

export class GithubError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

/**
 * True when GitHub turned down the token, not the request: it expired or was
 * revoked (401), or the organization's token policy blocks it (403 with
 * requests still left). A 403 with none left, or with Retry-After, is a rate limit.
 */
function tokenRefused(res: Response): boolean {
  if (res.status === 401) return true;
  return res.status === 403 && res.headers.get("x-ratelimit-remaining") !== "0" && !res.headers.has("retry-after");
}

async function gh<T>(env: Env, path: string): Promise<T> {
  const url = `https://api.github.com${path}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    // GitHub rejects requests without a User-Agent.
    "User-Agent": "codercops-discord-bot",
  };
  let res = await fetch(url, {
    headers: env.GITHUB_TOKEN ? { ...headers, Authorization: `Bearer ${env.GITHUB_TOKEN}` } : headers,
  });
  // Everything we read is public, so a token GitHub refuses must not take the bot down with it.
  if (env.GITHUB_TOKEN && tokenRefused(res)) {
    console.warn(`GitHub refused GITHUB_TOKEN (${res.status}) for ${path.split("?")[0]}, retrying without it`);
    await res.body?.cancel();
    res = await fetch(url, { headers });
  }
  if (!res.ok) {
    throw new GithubError(res.status, `GitHub ${res.status} for ${path.split("?")[0]}`);
  }
  return (await res.json()) as T;
}

/** Resolves a linked account's current login using the id that survives renames. */
export async function getLoginById(env: Env, githubId: string): Promise<string | null> {
  if (!/^[1-9]\d*$/.test(githubId)) return null;
  const user = await gh<{ id?: number; login?: unknown } | null>(env, `/user/${githubId}`);
  if (!user || String(user.id) !== githubId || typeof user.login !== "string") return null;
  // Apply the same login constraints as the verified Discord connection in oauth.ts.
  return /^[a-z\d](?:[a-z\d-]{0,38})$/i.test(user.login) ? user.login : null;
}

export interface StarterIssue {
  repo: string;
  number: number;
  title: string;
  url: string;
  labels: string[];
}

export interface GithubIssue {
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  state_reason?: string | null;
  labels: { name: string }[];
  assignees: { login: string }[];
  pull_request?: unknown;
}

export async function getIssue(env: Env, cfg: Config, repo: string, number: number): Promise<GithubIssue> {
  return gh<GithubIssue>(env, `/repos/${cfg.org}/${repo}/issues/${number}`);
}

interface ApiIssue {
  number: number;
  title: string;
  html_url: string;
  pull_request?: unknown;
  assignees?: { login: string }[];
  labels: (string | { name?: string })[];
}

const labelNames = (labels: ApiIssue["labels"]): string[] =>
  labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean);

/**
 * Open, unassigned issues in one repo that carry any of `labels` (default: all
 * the starter labels). Newest first.
 */
export async function listStarterIssues(
  env: Env,
  cfg: Config,
  repo: string,
  labels: string[] = cfg.starterLabels
): Promise<StarterIssue[]> {
  const seen = new Map<number, StarterIssue>();
  // The issues API ANDs labels together, so ask once per label and merge.
  for (const label of labels) {
    const query = new URLSearchParams({ state: "open", assignee: "none", labels: label, per_page: "100" });
    const issues = await gh<ApiIssue[]>(env, `/repos/${cfg.org}/${repo}/issues?${query}`);
    for (const issue of issues) {
      if (issue.pull_request) continue;
      const names = labelNames(issue.labels);
      if (names.some((n) => n.toLowerCase() === "blocked")) continue;
      seen.set(issue.number, { repo, number: issue.number, title: issue.title, url: issue.html_url, labels: names });
    }
  }
  return [...seen.values()].sort((a, b) => b.number - a.number);
}

interface SearchResult {
  total_count: number;
  /** Set when GitHub's search timed out, so `items` is only part of the answer, sometimes none of it. */
  incomplete_results?: boolean;
  items: { html_url: string; number: number; title: string; repository_url: string; user: { login: string } | null; pull_request?: { merged_at: string | null } }[];
}

/** The GitHub search query for a program's merged PRs. */
export function mergedPrQuery(
  cfg: Config,
  program: Program,
  { author, dayOnly = false }: { author?: string; dayOnly?: boolean } = {}
): string {
  const date = (d: Date) =>
    dayOnly ? d.toISOString().slice(0, 10) : d.toISOString().replace(/\.\d{3}Z$/, "Z");
  return [
    "is:pr",
    "is:merged",
    ...(author ? [`author:${author}`] : []),
    `label:"${program.label}"`,
    `merged:${date(program.start)}..${date(program.end)}`,
    ...program.repos.map((repo) => `repo:${cfg.org}/${repo}`),
  ].join(" ");
}

/** Every merged PR that counts for a program: labeled, in its repos, merged inside its window. */
export async function searchMergedPrs(env: Env, cfg: Config, program: Program): Promise<MergedPr[]> {
  const q = mergedPrQuery(cfg, program);

  const prs: MergedPr[] = [];
  // The search API returns at most 1000 results (10 pages of 100).
  for (let page = 1; page <= 10; page++) {
    const query = new URLSearchParams({ q, per_page: "100", page: String(page), sort: "created", order: "asc" });
    const result = await gh<SearchResult>(env, `/search/issues?${query}`);
    if (result.incomplete_results) throw new GithubError(503, "GitHub search returned incomplete results");
    for (const item of result.items) {
      const mergedAt = item.pull_request?.merged_at;
      const repo = item.repository_url.split("/").pop();
      if (item.user && mergedAt && repo) prs.push({ login: item.user.login, mergedAt, url: item.html_url, title: item.title, repo, number: item.number });
    }
    if (result.items.length < 100) break;
  }
  return prs;
}

/**
 * How many merged PRs a person has in our repos, at any time. `exceptUrl`
 * leaves one PR out, for the moment right after a merge when GitHub's search
 * index may or may not have it yet.
 */
export async function countMergedPrs(env: Env, cfg: Config, login: string, exceptUrl?: string): Promise<number> {
  const q = ["is:pr", "is:merged", `author:${login}`, ...cfg.repos.map((r) => `repo:${cfg.org}/${r}`)].join(" ");
  const query = new URLSearchParams({ q, per_page: "100" });
  const result = await gh<SearchResult>(env, `/search/issues?${query}`);
  if (result.incomplete_results) throw new GithubError(503, "GitHub search returned incomplete results");
  const listed = exceptUrl !== undefined && result.items.some((item) => item.html_url === exceptUrl);
  return result.total_count - (listed ? 1 : 0);
}
