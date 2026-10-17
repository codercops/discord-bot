import type { Config, Env, Program } from "./config";
import { searchMergedPrs } from "./github";

export interface MergedPr {
  login: string;
  mergedAt: string;
  url: string;
}

export interface LeaderboardRow {
  login: string;
  count: number;
  /** When they reached their current count: the merge time of their latest counted PR. */
  reachedAt: string;
  /** Has at least the minimum number of merged PRs. */
  qualifies: boolean;
  /** Qualifies and is inside the top N. */
  winner: boolean;
}

export interface RankOptions {
  excludedUsers: Set<string>;
  minPrs: number;
  topN: number;
}

/**
 * Ranks contributors by merged PR count. Ties go to whoever reached that count
 * first. Only people with at least `minPrs` can win, so there can be fewer than
 * `topN` winners.
 */
export function rankContributors(prs: MergedPr[], opts: RankOptions): LeaderboardRow[] {
  const byUser = new Map<string, { login: string; times: string[] }>();
  for (const pr of prs) {
    const key = pr.login.toLowerCase();
    if (opts.excludedUsers.has(key)) continue;
    const entry = byUser.get(key) ?? { login: pr.login, times: [] };
    entry.times.push(pr.mergedAt);
    byUser.set(key, entry);
  }

  const rows = [...byUser.values()].map(({ login, times }) => {
    times.sort();
    return { login, count: times.length, reachedAt: times[times.length - 1] ?? "" };
  });
  rows.sort(
    (a, b) => b.count - a.count || a.reachedAt.localeCompare(b.reachedAt) || a.login.localeCompare(b.login)
  );

  let winners = 0;
  return rows.map((row) => {
    const qualifies = row.count >= opts.minPrs;
    const winner = qualifies && winners < opts.topN;
    if (winner) winners++;
    return { ...row, qualifies, winner };
  });
}

const cacheKey = (program: Program) => `leaderboard:v2:${program.id}`;
const CACHE_TTL_SECONDS = 600;

export interface Leaderboard {
  rows: LeaderboardRow[];
  generatedAt: string;
}

/** Rank PRs and replace a program's cached leaderboard. */
export async function cacheLeaderboard(env: Env, cfg: Config, program: Program, prs: MergedPr[]): Promise<Leaderboard> {
  const board: Leaderboard = {
    rows: rankContributors(prs, {
      excludedUsers: cfg.excludedUsers,
      minPrs: program.minPrs,
      topN: program.topN,
    }),
    generatedAt: new Date().toISOString(),
  };
  await env.STATE.put(cacheKey(program), JSON.stringify(board), { expirationTtl: CACHE_TTL_SECONDS });
  return board;
}

/** A program's leaderboard, cached in KV for a few minutes to stay inside GitHub's search rate limit. */
export async function getLeaderboard(
  env: Env,
  cfg: Config,
  program: Program,
  opts: { fresh?: boolean } = {}
): Promise<Leaderboard> {
  if (!opts.fresh) {
    const cached = await env.STATE.get<Leaderboard>(cacheKey(program), "json");
    if (cached) return cached;
  }
  const prs = await searchMergedPrs(env, cfg, program);
  return cacheLeaderboard(env, cfg, program, prs);
}

export async function invalidateLeaderboard(env: Env, program: Program): Promise<void> {
  await env.STATE.delete(cacheKey(program));
}
