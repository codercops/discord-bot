import { describe, expect, it } from "vitest";
import { getConfig } from "../src/config";
import { getLeaderboard, invalidateLeaderboard, rankContributors, type MergedPr } from "../src/leaderboard";
import { makeEnv, mockFetch } from "./helpers";

const pr = (login: string, day: number, hour = 0): MergedPr => ({
  login,
  title: `PR ${login}-${day}-${hour}`,
  repo: "toolbelt",
  number: day * 100 + hour,
  mergedAt: `2026-10-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00Z`,
  url: `https://github.com/codercops/toolbelt/pull/${login}-${day}-${hour}`,
});
const many = (login: string, days: number[]) => days.map((d) => pr(login, d));
const opts = { excludedUsers: new Set(["anurag629"]), minPrs: 5, topN: 5 };

describe("rankContributors", () => {
  it("orders by merged PR count, highest first", () => {
    const rows = rankContributors([...many("ada", [1, 2]), ...many("bob", [1, 2, 3]), pr("cy", 4)], opts);
    expect(rows.map((r) => [r.login, r.count])).toEqual([
      ["bob", 3],
      ["ada", 2],
      ["cy", 1],
    ]);
  });

  it("breaks ties by who reached the count first", () => {
    // Both have 2. ada's second PR landed on the 5th, bob's on the 3rd.
    const rows = rankContributors([...many("ada", [1, 5]), ...many("bob", [2, 3])], opts);
    expect(rows.map((r) => r.login)).toEqual(["bob", "ada"]);
    expect(rows[0]?.reachedAt).toBe("2026-10-03T00:00:00Z");
  });

  it("never counts excluded users, whatever the casing", () => {
    const rows = rankContributors([...many("Anurag629", [1, 2, 3]), pr("ada", 1)], opts);
    expect(rows.map((r) => r.login)).toEqual(["ada"]);
  });

  it("treats logins case-insensitively as one person", () => {
    const rows = rankContributors([pr("Ada", 1), pr("ada", 2)], opts);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(2);
  });

  it("only lets people with the minimum number of PRs win", () => {
    const rows = rankContributors([...many("ada", [1, 2, 3, 4, 5]), ...many("bob", [1, 2, 3, 4])], opts);
    expect(rows.map((r) => [r.login, r.qualifies, r.winner])).toEqual([
      ["ada", true, true],
      ["bob", false, false],
    ]);
  });

  it("caps winners at the top N even when more people qualify", () => {
    const prs = ["a", "b", "c", "d", "e", "f"].flatMap((login, i) =>
      // Everyone has 5 PRs; later letters finish later.
      [1, 2, 3, 4, 5].map((d) => pr(login, d + i))
    );
    const rows = rankContributors(prs, opts);
    expect(rows.filter((r) => r.winner).map((r) => r.login)).toEqual(["a", "b", "c", "d", "e"]);
    expect(rows[5]).toMatchObject({ login: "f", qualifies: true, winner: false });
  });

  it("returns fewer winners than N when fewer people qualify", () => {
    const rows = rankContributors([...many("ada", [1, 2, 3, 4, 5, 6]), pr("bob", 1)], opts);
    expect(rows.filter((r) => r.winner).map((r) => r.login)).toEqual(["ada"]);
  });

  it("returns nothing for no PRs", () => {
    expect(rankContributors([], opts)).toEqual([]);
  });
});

describe("getLeaderboard when GitHub search fails", () => {
  const item = (n: number, login = "ada") => ({
    html_url: `https://github.com/codercops/toolbelt/pull/${n}`,
    number: n,
    title: `Fix ${n}`,
    repository_url: "https://api.github.com/repos/codercops/toolbelt",
    user: { login },
    pull_request: { merged_at: `2026-10-0${n}T00:00:00Z` },
  });
  const searches = (calls: { url: string }[]) => calls.filter((c) => c.url.includes("/search/issues")).length;

  // A board with rows, then an expired cache, as on the page between two visits.
  async function boardWithRows() {
    const env = makeEnv();
    const cfg = getConfig(env);
    const program = cfg.programs[0]!;
    mockFetch(() => ({ total_count: 2, items: [item(1), item(2, "bob")] }));
    const good = await getLeaderboard(env, cfg, program);
    await invalidateLeaderboard(env, program);
    return { env, cfg, program, good };
  }

  it.each([
    ["an incomplete answer", () => ({ total_count: 0, incomplete_results: true, items: [] })],
    ["an empty answer", () => ({ total_count: 0, items: [] })],
    ["an error", () => new Response("bad gateway", { status: 502 })],
  ])("serves the last good board on %s and caches it until the next try", async (_name, answer) => {
    const { env, cfg, program, good } = await boardWithRows();
    expect(good.rows).toHaveLength(2);
    const fetched = mockFetch(answer);
    expect(await getLeaderboard(env, cfg, program)).toEqual(good);
    expect(await getLeaderboard(env, cfg, program)).toEqual(good);
    expect(searches(fetched.calls)).toBe(1);
  });

  it("falls back for the weekly post too, but not when fallback is off", async () => {
    const { env, cfg, program, good } = await boardWithRows();
    mockFetch(() => ({ total_count: 0, items: [] }));
    expect(await getLeaderboard(env, cfg, program, { fresh: true })).toEqual(good);
    await expect(getLeaderboard(env, cfg, program, { fresh: true, fallback: false })).rejects.toThrow("had rows before");
  });

  it("takes the new board again once search works", async () => {
    const { env, cfg, program } = await boardWithRows();
    mockFetch(() => ({ total_count: 0, items: [] }));
    await getLeaderboard(env, cfg, program);
    await invalidateLeaderboard(env, program);
    mockFetch(() => ({ total_count: 3, items: [item(1), item(2, "bob"), item(3)] }));
    const board = await getLeaderboard(env, cfg, program);
    expect(board.rows).toEqual([
      expect.objectContaining({ login: "ada", count: 2 }),
      expect.objectContaining({ login: "bob", count: 1 }),
    ]);
  });

  it("still shows an empty board before anything has counted", async () => {
    const env = makeEnv();
    const cfg = getConfig(env);
    mockFetch(() => ({ total_count: 0, items: [] }));
    expect((await getLeaderboard(env, cfg, cfg.programs[0]!)).rows).toEqual([]);
  });

  it("still throws when search fails and there is no earlier board", async () => {
    const env = makeEnv();
    const cfg = getConfig(env);
    mockFetch(() => new Response("bad gateway", { status: 502 }));
    await expect(getLeaderboard(env, cfg, cfg.programs[0]!)).rejects.toThrow("502");
  });
});
