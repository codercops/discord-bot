// The people and companies who sponsor us on GitHub, for the list at /sponsors.
//
// GitHub only shows a third party who sponsors someone right now, not which
// tier they picked or when a one-time payment was made. Our one-time tiers
// promise a place on the list for a month or two, so the bot remembers every
// sponsor it has seen and keeps them listed for KEEP_DAYS after GitHub last
// showed them.
import type { Config, Env } from "./config";
import { graphql } from "./github";

export interface Sponsor {
  login: string;
  /** The display name, or the login when they have none. */
  name: string;
  kind: "user" | "organization";
  /** The accounts they sponsor, out of SPONSOR_ACCOUNTS. */
  sponsoring: string[];
  /** When the bot first saw them. */
  firstSeen: string;
  /** When GitHub last listed them as a sponsor. */
  lastSeen: string;
}

export interface SponsorList {
  /** Current sponsors first, longest-standing first within each group. */
  sponsors: (Sponsor & { current: boolean })[];
  generatedAt: string;
}

/** How long someone stays on the list after GitHub stops showing them: covers the two months of the $250 one-time tier. */
export const KEEP_DAYS = 62;
const DAY_MS = 24 * 60 * 60 * 1000;

const SEEN_KEY = "sponsors:seen:v1";
const CACHE_KEY = "sponsors:list:v1";
const CACHE_TTL_SECONDS = 600;

interface SponsorNode {
  __typename?: string;
  login?: string;
  name?: string | null;
}

const QUERY = `query ($login: String!, $after: String) {
  repositoryOwner(login: $login) {
    ... on Sponsorable {
      sponsors(first: 100, after: $after) {
        nodes { __typename ... on User { login name } ... on Organization { login name } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

interface SponsorsAnswer {
  repositoryOwner: {
    sponsors?: { nodes: SponsorNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
  } | null;
}

/** Everyone GitHub lists as a public sponsor of one account right now. */
export async function fetchSponsors(env: Env, account: string): Promise<{ login: string; name: string; kind: Sponsor["kind"] }[]> {
  const found: { login: string; name: string; kind: Sponsor["kind"] }[] = [];
  let after: string | null = null;
  // 10 pages of 100 is far more than we expect; the cap keeps a bad answer from looping.
  for (let page = 0; page < 10; page++) {
    const data: SponsorsAnswer = await graphql<SponsorsAnswer>(env, QUERY, { login: account, after });
    const sponsors = data.repositoryOwner?.sponsors;
    if (!sponsors) break;
    for (const node of sponsors.nodes) {
      if (!node?.login) continue;
      found.push({
        login: node.login,
        name: node.name?.trim() || node.login,
        kind: node.__typename === "Organization" ? "organization" : "user",
      });
    }
    if (!sponsors.pageInfo.hasNextPage) break;
    after = sponsors.pageInfo.endCursor;
  }
  return found;
}

/**
 * Folds what GitHub shows now into what the bot has seen before: new sponsors
 * are added, current ones get a fresh `lastSeen`, and anyone GitHub hasn't
 * shown for KEEP_DAYS is dropped. Accounts that couldn't be read (`failed`)
 * don't count as "no longer sponsoring".
 */
export function mergeSponsors(
  seen: Record<string, Sponsor>,
  current: { account: string; login: string; name: string; kind: Sponsor["kind"] }[],
  now: Date,
  failed: Set<string> = new Set()
): Record<string, Sponsor> {
  const nowIso = now.toISOString();
  const next: Record<string, Sponsor> = {};
  for (const [key, sponsor] of Object.entries(seen)) {
    if (now.getTime() - Date.parse(sponsor.lastSeen) <= KEEP_DAYS * DAY_MS) next[key] = { ...sponsor };
  }
  // Who each sponsor backs right now, so a stopped sponsorship drops out of `sponsoring`.
  const backing = new Map<string, Set<string>>();
  for (const s of current) {
    const key = s.login.toLowerCase();
    backing.set(key, (backing.get(key) ?? new Set()).add(s.account));
    const before = next[key];
    next[key] = {
      login: s.login,
      name: s.name,
      kind: s.kind,
      sponsoring: before?.sponsoring ?? [],
      firstSeen: before?.firstSeen ?? nowIso,
      lastSeen: nowIso,
    };
  }
  for (const [key, sponsor] of Object.entries(next)) {
    const accounts = backing.get(key);
    if (!accounts) continue;
    // Keep accounts we couldn't read this time, and add the ones they back now.
    sponsor.sponsoring = [...new Set([...sponsor.sponsoring.filter((a) => failed.has(a)), ...accounts])].sort();
  }
  return next;
}

/** The public list: current sponsors first, then recent ones, each group longest-standing first. */
export function listSponsors(seen: Record<string, Sponsor>, now: Date, refreshedAt: string): SponsorList {
  const current = (s: Sponsor) => s.lastSeen === refreshedAt;
  const sponsors = Object.values(seen)
    .filter((s) => now.getTime() - Date.parse(s.lastSeen) <= KEEP_DAYS * DAY_MS)
    .map((s) => ({ ...s, current: current(s) }))
    .sort(
      (a, b) =>
        Number(b.current) - Number(a.current) || a.firstSeen.localeCompare(b.firstSeen) || a.login.localeCompare(b.login)
    );
  return { sponsors, generatedAt: refreshedAt };
}

/**
 * Asks GitHub for the current sponsors of every account in SPONSOR_ACCOUNTS
 * and updates what the bot remembers. Throws only when no account could be
 * read, so a list can't be wiped by one bad answer.
 */
export async function refreshSponsors(env: Env, cfg: Config, now: Date = new Date()): Promise<SponsorList> {
  const results = await Promise.allSettled(cfg.sponsorAccounts.map((account) => fetchSponsors(env, account)));
  const failed = new Set<string>();
  const current: { account: string; login: string; name: string; kind: Sponsor["kind"] }[] = [];
  results.forEach((result, i) => {
    const account = cfg.sponsorAccounts[i]!;
    if (result.status === "rejected") {
      console.error(`sponsors of ${account} could not be read`, result.reason);
      failed.add(account);
      return;
    }
    for (const s of result.value) current.push({ account, ...s });
  });
  if (cfg.sponsorAccounts.length > 0 && failed.size === cfg.sponsorAccounts.length) {
    throw results.find((r): r is PromiseRejectedResult => r.status === "rejected")?.reason ?? new Error("no sponsor account could be read");
  }

  const seen = (await env.STATE.get<Record<string, Sponsor>>(SEEN_KEY, "json")) ?? {};
  const next = mergeSponsors(seen, current, now, failed);
  await env.STATE.put(SEEN_KEY, JSON.stringify(next));
  const list = listSponsors(next, now, now.toISOString());
  await env.STATE.put(CACHE_KEY, JSON.stringify(list), { expirationTtl: CACHE_TTL_SECONDS });
  return list;
}

/**
 * The sponsor list, cached for ten minutes. When GitHub can't be read it
 * falls back to the sponsors the bot remembers, which are never older than a
 * day thanks to the daily refresh.
 */
export async function getSponsors(env: Env, cfg: Config, now: Date = new Date()): Promise<SponsorList> {
  const cached = await env.STATE.get<SponsorList>(CACHE_KEY, "json");
  if (cached) return cached;
  try {
    return await refreshSponsors(env, cfg, now);
  } catch (err) {
    const seen = await env.STATE.get<Record<string, Sponsor>>(SEEN_KEY, "json");
    if (!seen) throw err;
    console.error("sponsors: GitHub failed, serving the remembered list", err);
    const newest = Object.values(seen).reduce((max, s) => (s.lastSeen > max ? s.lastSeen : max), "");
    return listSponsors(seen, now, newest);
  }
}
