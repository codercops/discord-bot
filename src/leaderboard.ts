import type { Config, Env, Program } from "./config";
import { searchMergedPrs } from "./github";

export interface MergedPr {
  login: string;
  mergedAt: string;
  url: string;
  title: string;
  repo: string;
  number: number;
}

/** A counted PR as shown under a leaderboard row. */
export type CountedPr = Omit<MergedPr, "login">;

export interface LeaderboardRow {
  login: string;
  count: number;
  /** When they reached their current count: the merge time of their latest counted PR. */
  reachedAt: string;
  /** Their counted PRs, newest first. */
  prs: CountedPr[];
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
  const byUser = new Map<string, { login: string; prs: CountedPr[] }>();
  for (const { login, ...pr } of prs) {
    const key = login.toLowerCase();
    if (opts.excludedUsers.has(key)) continue;
    const entry = byUser.get(key) ?? { login, prs: [] };
    entry.prs.push(pr);
    byUser.set(key, entry);
  }

  const rows = [...byUser.values()].map(({ login, prs }) => {
    // Newest first
    prs.sort((a, b) => b.mergedAt.localeCompare(a.mergedAt) || b.number - a.number);
    return { login, count: prs.length, reachedAt: prs[0]?.mergedAt ?? "", prs };
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

const cacheKey = (program: Program) => `leaderboard:v3:${program.id}`;
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

const recentKey = (program: Program) => `recent-merges:${program.id}`;

/** Merges the webhook saw shortly before that search hadn't indexed yet, kept by `rememberMerges`. */
export async function recentMerges(env: Env, program: Program): Promise<MergedPr[]> {
  return (await env.STATE.get<MergedPr[]>(recentKey(program), "json")) ?? [];
}

/**
 * Keep merges search hasn't indexed yet, for the counts of the merges right after them. Search catches up within
 * seconds, so the next merge drops them again; the TTL clears what is left once merges stop.
 */
export async function rememberMerges(env: Env, program: Program, prs: MergedPr[]): Promise<void> {
  await env.STATE.put(recentKey(program), JSON.stringify(prs), { expirationTtl: CACHE_TTL_SECONDS });
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
