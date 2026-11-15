import { afterEach, describe, expect, it, vi } from "vitest";
import { DAILY_CRON } from "../src/config";
import worker from "../src/index";
import { KEEP_DAYS, listSponsors, mergeSponsors, type Sponsor } from "../src/sponsors";
import { makeCtx, makeEnv, mockFetch } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-15T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

const sponsor = (login: string, over: Partial<Sponsor> = {}): Sponsor => ({
  login,
  name: login,
  kind: "user",
  sponsoring: ["anurag629"],
  firstSeen: daysAgo(40),
  lastSeen: daysAgo(1),
  ...over,
});

/** A GraphQL answer listing `logins` as the sponsors of one account. */
const answer = (nodes: { login: string; name?: string | null; org?: boolean }[]) => ({
  data: {
    repositoryOwner: {
      sponsors: {
        nodes: nodes.map((n) => ({ __typename: n.org ? "Organization" : "User", login: n.login, name: n.name ?? null })),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  },
});

describe("mergeSponsors", () => {
  it("adds a new sponsor and refreshes one it already knows", () => {
    const seen = { ada: sponsor("ada") };
    const next = mergeSponsors(
      seen,
      [
        { account: "anurag629", login: "ada", name: "Ada L.", kind: "user" },
        { account: "codercops", login: "Acme", name: "Acme Inc", kind: "organization" },
      ],
      NOW
    );
    expect(next.ada).toMatchObject({ name: "Ada L.", firstSeen: daysAgo(40), lastSeen: NOW.toISOString(), sponsoring: ["anurag629"] });
    expect(next.acme).toMatchObject({ login: "Acme", kind: "organization", firstSeen: NOW.toISOString(), sponsoring: ["codercops"] });
  });

  it(`keeps someone GitHub stopped showing for ${KEEP_DAYS} days, then drops them`, () => {
    const seen = { recent: sponsor("recent", { lastSeen: daysAgo(KEEP_DAYS - 1) }), old: sponsor("old", { lastSeen: daysAgo(KEEP_DAYS + 1) }) };
    const next = mergeSponsors(seen, [], NOW);
    expect(Object.keys(next)).toEqual(["recent"]);
    expect(next.recent!.lastSeen).toBe(daysAgo(KEEP_DAYS - 1));
  });

  it("lists every account someone sponsors, once", () => {
    const next = mergeSponsors(
      {},
      [
        { account: "codercops", login: "ada", name: "Ada", kind: "user" },
        { account: "anurag629", login: "ADA", name: "Ada", kind: "user" },
      ],
      NOW
    );
    expect(Object.keys(next)).toEqual(["ada"]);
    expect(next.ada!.sponsoring).toEqual(["anurag629", "codercops"]);
  });

  it("doesn't treat an account it couldn't read as a stopped sponsorship", () => {
    const seen = { ada: sponsor("ada", { sponsoring: ["anurag629", "codercops"] }) };
    const next = mergeSponsors(seen, [{ account: "anurag629", login: "ada", name: "Ada", kind: "user" }], NOW, new Set(["codercops"]));
    expect(next.ada!.sponsoring).toEqual(["anurag629", "codercops"]);
    const stopped = mergeSponsors(seen, [{ account: "anurag629", login: "ada", name: "Ada", kind: "user" }], NOW);
    expect(stopped.ada!.sponsoring).toEqual(["anurag629"]);
  });
});

describe("listSponsors", () => {
  it("puts current sponsors first, longest-standing first", () => {
    const refreshed = NOW.toISOString();
    const list = listSponsors(
      {
        newer: sponsor("newer", { firstSeen: daysAgo(5), lastSeen: refreshed }),
        lapsed: sponsor("lapsed", { firstSeen: daysAgo(90), lastSeen: daysAgo(10) }),
        older: sponsor("older", { firstSeen: daysAgo(50), lastSeen: refreshed }),
      },
      NOW,
      refreshed
    );
    expect(list.sponsors.map((s) => [s.login, s.current])).toEqual([
      ["older", true],
      ["newer", true],
      ["lapsed", false],
    ]);
  });
});

describe("GET /sponsors", () => {
  afterEach(() => vi.useRealTimers());
  const ctx = makeCtx().ctx;
  const sponsorEnv = () => makeEnv({ GITHUB_TOKEN: "test-token", SPONSOR_ACCOUNTS: "codercops,anurag629" });

  it("lists the sponsors of every account, escaped, and remembers them", async () => {
    const fetched = mockFetch((url, body) => {
      expect(url.pathname).toBe("/graphql");
      return body.variables.login === "anurag629" ? answer([{ login: "ada", name: "<b>Ada</b>" }, { login: "acme", name: "Acme", org: true }]) : answer([]);
    });
    const env = sponsorEnv();
    const res = await worker.fetch(new Request("https://oss.example/sponsors"), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toContain("img-src 'self' https://github.com");
    const html = await res.text();
    expect(html).toContain("&lt;b&gt;Ada&lt;/b&gt;");
    expect(html).not.toContain("<b>Ada</b>");
    expect(html).toContain('<li class="organization">');
    expect(html).toContain('href="https://github.com/sponsors/anurag629"');
    expect(fetched.calls.filter((c) => c.url === "https://api.github.com/graphql").map((c) => c.body.variables.login)).toEqual([
      "codercops",
      "anurag629",
    ]);
    expect(fetched.calls[0]!.auth).toBe("Bearer test-token");
    expect(Object.keys(JSON.parse(env.STATE.store.get("sponsors:seen:v1")!))).toEqual(["ada", "acme"]);
  });

  it("serves the same list as JSON", async () => {
    mockFetch((_url, body) => (body.variables.login === "codercops" ? answer([{ login: "acme", name: "Acme", org: true }]) : answer([])));
    const res = await worker.fetch(new Request("https://oss.example/sponsors.json"), sponsorEnv(), ctx);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const body = (await res.json()) as any;
    expect(body.becomeASponsor).toBe("https://github.com/sponsors/anurag629");
    expect(body.sponsors).toEqual([
      expect.objectContaining({ login: "acme", name: "Acme", kind: "organization", current: true, url: "https://github.com/acme" }),
    ]);
  });

  it("says so when nobody sponsors yet", async () => {
    mockFetch(() => answer([]));
    const html = await (await worker.fetch(new Request("https://oss.example/sponsors"), sponsorEnv(), ctx)).text();
    expect(html).toContain("Nobody sponsors the projects yet.");
  });

  it("keeps a sponsor GitHub stopped showing, as a recent sponsor", async () => {
    mockFetch(() => answer([]));
    const env = sponsorEnv();
    env.STATE.store.set("sponsors:seen:v1", JSON.stringify({ ada: sponsor("ada", { firstSeen: daysAgo(40), lastSeen: daysAgo(3) }) }));
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const html = await (await worker.fetch(new Request("https://oss.example/sponsors"), env, ctx)).text();
    expect(html).toContain("Recent sponsor");
  });

  it("serves the remembered list when GitHub fails", async () => {
    mockFetch(() => new Response("boom", { status: 502 }));
    const env = sponsorEnv();
    env.STATE.store.set("sponsors:seen:v1", JSON.stringify({ ada: sponsor("ada", { lastSeen: new Date().toISOString() }) }));
    const res = await worker.fetch(new Request("https://oss.example/sponsors"), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(">ada</a>");
  });

  it("still lists one account's sponsors when the other can't be read", async () => {
    mockFetch((_url, body) => (body.variables.login === "codercops" ? new Response("boom", { status: 502 }) : answer([{ login: "ada" }])));
    const res = await worker.fetch(new Request("https://oss.example/sponsors"), sponsorEnv(), ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(">ada</a>");
  });

  it("answers 503 when it has no token and nothing remembered", async () => {
    const fetched = mockFetch();
    const res = await worker.fetch(new Request("https://oss.example/sponsors"), makeEnv(), ctx);
    expect(res.status).toBe(503);
    expect(fetched.calls).toHaveLength(0);
  });

  it("reads GitHub at most once while the list is cached", async () => {
    const fetched = mockFetch(() => answer([]));
    const env = sponsorEnv();
    await worker.fetch(new Request("https://oss.example/sponsors"), env, ctx);
    await worker.fetch(new Request("https://oss.example/sponsors.json"), env, ctx);
    expect(fetched.calls).toHaveLength(2);
  });

  it("moves to the public address from workers.dev", async () => {
    mockFetch();
    const res = await worker.fetch(new Request("https://bot.someone.workers.dev/sponsors"), makeEnv(), ctx);
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("https://bot.example/sponsors");
  });
});

describe("daily sponsor refresh", () => {
  it("remembers sponsors even when nobody opens the page", async () => {
    mockFetch(() => answer([{ login: "ada" }]));
    const env = makeEnv({ GITHUB_TOKEN: "test-token", SPONSOR_ACCOUNTS: "anurag629" });
    // A Tuesday: no leaderboard posts, only the refresh.
    await worker.scheduled({ cron: DAILY_CRON, scheduledTime: Date.parse("2026-11-17T04:30:00Z"), noRetry() {} } as ScheduledController, env);
    const seen = JSON.parse(env.STATE.store.get("sponsors:seen:v1")!);
    expect(seen.ada).toMatchObject({ login: "ada", lastSeen: "2026-11-17T04:30:00.000Z" });
  });
});
