import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { boardSvg, boardVersion, cardSvg, escapeXml, fitMono, progressBar } from "../src/card";
import { getConfig } from "../src/config";
import worker from "../src/index";
import { contributorPage, noticePage } from "../src/page";
import { FakeCache, makeCtx, makeEnv, mockFetch } from "./helpers";

// The real module needs the WebAssembly rasterizer and the font files, which
// only the Workers bundler can load. The route is tested with a stand-in.
const rendered: string[] = [];
vi.mock("../src/card-image", () => ({
  fetchAvatar: async (login: string) => (login === "noavatar" ? undefined : "data:image/png;base64,AAAA"),
  renderPng: async (svg: string) => {
    rendered.push(svg);
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  },
}));

const program = getConfig(makeEnv()).programs[0]!;
const row = (login: string, count: number, qualifies = false, winner = false) => ({ login, count, reachedAt: "2026-10-05T00:00:00Z", prs: [], qualifies, winner });
const during = new Date("2026-10-12T04:30:00Z");

describe("card layout helpers", () => {
  it("escapes text for XML", () => {
    expect(escapeXml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });

  it("shrinks long names to fit and never grows past the maximum", () => {
    expect(fitMono("ada", 800, 68)).toBe(68);
    expect(fitMono("a".repeat(39), 800, 68)).toBe(34);
    expect(0.6 * fitMono("a".repeat(39), 800, 68) * 39).toBeLessThanOrEqual(800);
    expect(fitMono("", 800, 68)).toBe(68);
  });

  it("draws one segment per PR needed and fills the merged ones", () => {
    const bar = progressBar(4, 5, 100, 500, "#0f0");
    expect(bar.match(/<rect/g)).toHaveLength(5);
    expect(bar.match(/fill="#0f0"/g)).toHaveLength(4);
    // More merged than needed still fills five, not more.
    expect(progressBar(9, 5, 100, 500, "#0f0").match(/fill="#0f0"/g)).toHaveLength(5);
    // The last segment ends where the bar ends.
    const last = /x="([\d.]+)"[^>]*width="([\d.]+)"/.exec(bar.split("\n").pop()!)!;
    expect(Number(last[1]) + Number(last[2])).toBeCloseTo(350, 0);
  });

  it("switches to one track when there would be too many segments", () => {
    const bar = progressBar(10, 20, 100, 500, "#0f0");
    expect(bar.match(/<rect/g)).toHaveLength(2);
    expect(bar).toContain('width="125"');
    expect(progressBar(1, 0, 0, 0, "#0f0")).toBe("");
  });
});

describe("cardSvg", () => {
  const base = { program, rank: 1, of: 15, site: "oss.example", avatar: "data:image/png;base64,AAAA" };

  it("shows the person, the program, their count, their rank and where the card lives", () => {
    const svg = cardSvg({ ...base, row: row("ada", 4), chip: { text: "1 more to qualify", kind: "progress" } });
    expect(svg).toContain('viewBox="0 0 1200 630"');
    expect(svg).toContain(">ada</text>");
    expect(svg).toContain(">Hacktoberfest 2026</text>");
    expect(svg).toContain(">4</text>");
    expect(svg).toContain(">pull requests</text>");
    expect(svg).toContain(">#1</text>");
    expect(svg).toContain(">of 15 contributors</text>");
    expect(svg).toContain(">1 MORE TO QUALIFY</text>");
    expect(svg).toContain(">oss.example</text>");
    expect(svg).toContain('<image href="data:image/png;base64,AAAA"');
  });

  it("uses singular wording, the right accent for winners, and no chip when there is none", () => {
    const one = cardSvg({ ...base, of: 1, row: row("ada", 1), chip: null });
    expect(one).toContain(">pull request</text>");
    expect(one).toContain(">of 1 contributor</text>");
    expect(one).not.toContain('rx="23"');
    const winner = cardSvg({ ...base, row: row("ada", 6, true, true), chip: { text: "Winner", kind: "top" } });
    expect(winner).toContain(">WINNER</text>");
    expect(winner.match(/#e3b341/g)!.length).toBeGreaterThan(2);
  });

  it("falls back to the first letter when there is no avatar", () => {
    const svg = cardSvg({ ...base, avatar: undefined, row: row("ada", 4), chip: null });
    expect(svg).not.toContain("<image");
    expect(svg).toContain(">A</text>");
  });

  it("escapes everything that isn't ours", () => {
    const evil = { ...program, title: `<script>"x"</script>`, repos: ["a&b"] };
    const svg = cardSvg({ ...base, program: evil, site: "<host>", row: row("ada", 4), chip: { text: "<b>", kind: "top" } });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;&quot;x&quot;&lt;/script&gt;");
    expect(svg).toContain("a&amp;b");
    expect(svg).toContain("&lt;host&gt;");
    expect(svg).toContain("&lt;B&gt;");
  });
});

describe("boardSvg", () => {
  const after = new Date("2026-11-03T00:00:00Z");
  const six = [
    row("ada", 7, true, true),
    row("bob", 6, true, true),
    row("cy", 5, true, true),
    row("dee", 3),
    row("eve", 2),
    row("fay", 1),
  ];
  const pic = "data:image/png;base64,AAAA";
  const base = { program, rows: six, avatars: [pic, pic, undefined, pic, pic], now: during, site: "oss.example" };

  it("shows the program, where it stands, the top five and the totals", () => {
    const svg = boardSvg(base);
    expect(svg).toContain('viewBox="0 0 1200 630"');
    expect(svg).toContain(">Hacktoberfest 2026 leaderboard</text>");
    expect(svg).toContain(">20 DAYS LEFT</text>");
    expect(svg).toContain(">6 contributors  ·  24 merged PRs</text>");
    for (const [i, login] of ["ada", "bob", "cy", "dee", "eve"].entries()) {
      expect(svg).toContain(`>#${i + 1}</text>`);
      expect(svg).toContain(`>${login}</text>`);
    }
    expect(svg.indexOf(">ada</text>")).toBeLessThan(svg.indexOf(">eve</text>"));
    expect(svg).toContain(">7 PRs</text>");
    // The sixth person counts in the totals but isn't drawn.
    expect(svg).not.toContain(">#6</text>");
    expect(svg).not.toContain(">fay</text>");
    expect(svg).toContain(">oss.example</text>");
  });

  it("falls back to the first letter for a missing avatar", () => {
    const svg = boardSvg(base);
    expect(svg.match(/<image /g)).toHaveLength(4);
    expect(svg).toContain(">C</text>");
  });

  it("marks the people in the top N, and calls them winners once it's over", () => {
    const running = boardSvg(base);
    expect(running.match(/>TOP 5<\/text>/g)).toHaveLength(3);
    const ended = boardSvg({ ...base, now: after });
    expect(ended).toContain(">FINAL RESULTS</text>");
    expect(ended.match(/>WINNER<\/text>/g)).toHaveLength(3);
    expect(ended).not.toContain("TOP 5");
    expect(ended).not.toContain("DAYS LEFT");
  });

  it("draws fewer rows when fewer people are on the board, with singular wording", () => {
    const two = boardSvg({ ...base, rows: six.slice(0, 2), avatars: [pic, pic] });
    expect(two).toContain(">#2</text>");
    expect(two).not.toContain(">#3</text>");
    expect(two).toContain(">2 contributors  ·  13 merged PRs</text>");
    const one = boardSvg({ ...base, rows: [row("ada", 1)], avatars: [undefined] });
    expect(one).toContain(">1 contributor  ·  1 merged PR</text>");
    expect(one).toContain(">1 PR</text>");
    expect(one).toContain(">A</text>");
  });

  it("has an empty state", () => {
    const empty = boardSvg({ ...base, rows: [], avatars: [] });
    expect(empty).toContain(">0 contributors  ·  0 merged PRs</text>");
    expect(empty).toContain(">No merged pull requests yet</text>");
    expect(empty).toContain(">Pick an issue and be the first.</text>");
    expect(empty).not.toContain(">#1</text>");
    const ended = boardSvg({ ...base, rows: [], avatars: [], now: after });
    expect(ended).toContain(">No merged pull requests were counted</text>");
    expect(ended).not.toContain("Pick an issue");
    expect(boardSvg({ ...base, rows: [], avatars: [], now: new Date("2026-09-01T00:00:00Z") })).toContain(">STARTS OCT 1</text>");
  });

  it("fits a 39 character login before the top N mark", () => {
    const long = "a".repeat(39);
    const svg = boardSvg({ ...base, rows: [row(long, 9, true, true)], avatars: [pic] });
    const size = fitMono(long, 600, 30);
    expect(svg).toContain(`font-size="${size}" fill="#e6e9ef">${long}</text>`);
    const markLeft = Number(/<rect x="(\d+)" y="\d+" width="\d+" height="30"/.exec(svg)![1]);
    expect(212 + 0.6 * size * long.length).toBeLessThan(markLeft);
  });

  it("escapes everything that isn't ours", () => {
    const evil = { ...program, title: `<script>"x"</script>`, repos: ["a&b"] };
    const svg = boardSvg({ ...base, program: evil, site: "<host>", rows: [row("<b>&", 1)], avatars: [`x"/><script>`] });
    expect(svg).not.toContain("<script>");
    expect(svg).not.toContain("<b>");
    expect(svg).toContain("&lt;script&gt;&quot;x&quot;&lt;/script&gt; leaderboard");
    expect(svg).toContain(">&lt;b&gt;&amp;</text>");
    expect(svg).toContain('href="x&quot;/&gt;&lt;script&gt;"');
    expect(boardSvg({ ...base, rows: [row("<b>", 1)], avatars: [undefined] })).toContain(">&lt;</text>");
    expect(svg).toContain("a&amp;b");
    expect(svg).toContain("&lt;host&gt;");
  });
});

describe("boardVersion", () => {
  const rows = [row("ada", 7, true, true), row("bob", 6, true, true), row("cy", 2)];

  it("stays the same while nothing on the image changes", () => {
    expect(boardVersion(rows, program, during)).toBe(boardVersion([...rows], program, new Date(during.getTime() + 60_000)));
    expect(boardVersion(rows, program, during)).toMatch(/^[a-z0-9]+$/);
  });

  it("changes when the top five, their counts, the totals or the program's state change", () => {
    const v = boardVersion(rows, program, during);
    expect(boardVersion([row("ada", 8, true, true), rows[1]!, rows[2]!], program, during)).not.toBe(v);
    expect(boardVersion([rows[1]!, rows[0]!, rows[2]!], program, during)).not.toBe(v);
    expect(boardVersion([...rows, row("dee", 1)], program, during)).not.toBe(v);
    expect(boardVersion(rows, program, new Date("2026-11-03T00:00:00Z"))).not.toBe(v);
    expect(boardVersion([], program, during)).not.toBe(v);
  });
});

describe("contributorPage", () => {
  const links = {
    self: "https://oss.example/leaderboard/2026-10/u/ada",
    image: "https://oss.example/leaderboard/2026-10/u/ada.png?v=4-1-15-running",
    board: "/leaderboard/2026-10",
    prs: "https://github.com/search?q=x&type=pullrequests",
    issues: "https://github.com/search?q=issues",
    discord: "https://discord.gg/example",
  };
  const generatedAt = new Date(during.getTime() - 8 * 60_000).toISOString();
  const html = contributorPage({ program, row: row("ada", 4), rank: 1, of: 15, generatedAt }, links, during);

  it("shows the card and says where the person stands", () => {
    expect(html).toContain("<h1>ada</h1>");
    expect(html).toContain("4 merged pull requests in Hacktoberfest 2026. 1st of 15 on the leaderboard.");
    expect(html).toContain('<img src="https://oss.example/leaderboard/2026-10/u/ada.png?v=4-1-15-running" width="1200" height="630"');
    expect(html).toContain("<b>1 more to qualify</b>");
    expect(html).toContain('<a href="/leaderboard/2026-10">Hacktoberfest 2026 leaderboard</a>');
  });

  it("has what a share preview needs", () => {
    expect(html).toContain('<meta property="og:image" content="https://oss.example/leaderboard/2026-10/u/ada.png?v=4-1-15-running">');
    expect(html).toContain('<meta property="og:image:width" content="1200">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain('<link rel="canonical" href="https://oss.example/leaderboard/2026-10/u/ada">');
  });

  it("offers sharing, a download and the link itself", () => {
    expect(html).toContain('href="https://www.linkedin.com/sharing/share-offsite/?url=https%3A%2F%2Foss.example%2Fleaderboard%2F2026-10%2Fu%2Fada"');
    expect(html).toContain("https://twitter.com/intent/tweet?text=4+merged+pull+requests+in+Hacktoberfest+2026.&amp;url=https%3A%2F%2Foss.example");
    expect(html).toContain('download="codercops-2026-10-ada.png"');
    expect(html).toContain('<input readonly value="https://oss.example/leaderboard/2026-10/u/ada"');
  });

  it("handles one PR, one contributor and a finished program", () => {
    const single = contributorPage({ program, row: row("ada", 1), rank: 1, of: 1, generatedAt }, links, during);
    expect(single).toContain("1 merged pull request in Hacktoberfest 2026. 1st of 1 on the leaderboard.");
    expect(single).toContain("of 1 contributor</span>");
    const ended = contributorPage({ program, row: row("ada", 2), rank: 11, of: 15, generatedAt }, links, new Date("2026-11-03T00:00:00Z"));
    expect(ended).toContain("11th of 15");
    expect(ended).toContain("<b>Took part</b><span>final result</span>");
  });

  it("dates the footer by when the board was generated, not when the page was requested", () => {
    const stamp = `${generatedAt.slice(0, 16).replace("T", " ")} UTC`;
    expect(html).toContain(`<time datetime="${generatedAt}">${stamp}</time>`);
    expect(html).not.toContain(during.toISOString());
  });

  it("still uses the current time for the program status", () => {
    const late = contributorPage(
      { program, row: row("ada", 2), rank: 11, of: 15, generatedAt },
      links,
      new Date("2026-11-03T00:00:00Z")
    );
    expect(late).toContain("<b>Took part</b><span>final result</span>");
    expect(late).toContain(`datetime="${generatedAt}"`);
  });
});

describe("noticePage links", () => {
  it("shows supplied links with the cta styling and escapes labels and destinations", () => {
    const html = noticePage("No card yet", ["Nothing here."], false, "No card", [
      { label: `<script>"label"</script>`, href: `https://example.com/?a="b"&c=<d>` },
    ]);
    expect(html).toContain('<div class="cta">');
    expect(html).toContain('href="https://example.com/?a=&quot;b&quot;&amp;c=&lt;d&gt;"');
    expect(html).toContain("&lt;script&gt;&quot;label&quot;&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("leaves pages without links as they were", () => {
    const html = noticePage("GitHub linked", ["Everything is linked."], true);
    expect(html).not.toContain('<div class="cta">');
    expect(html).toContain('<section class="rules">\n<p>Everything is linked.</p>\n</section>\n<p class="status running">Done</p>');
  });
});

describe("GET /leaderboard/{id}/u/{login}", () => {
  let env = makeEnv();
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const search = () => ({
    total_count: 3,
    items: [
      { html_url: "https://github.com/codercops/toolbelt/pull/1", number: 1, title: "Fix a thing", repository_url: "https://api.github.com/repos/codercops/toolbelt", user: { login: "Ada" }, pull_request: { merged_at: "2026-10-02T00:00:00Z" } },
      { html_url: "https://github.com/codercops/toolbelt/pull/2", number: 2, title: "Fix a thing", repository_url: "https://api.github.com/repos/codercops/toolbelt", user: { login: "Ada" }, pull_request: { merged_at: "2026-10-03T00:00:00Z" } },
      { html_url: "https://github.com/codercops/toolbelt/pull/3", number: 3, title: "Fix a thing", repository_url: "https://api.github.com/repos/codercops/toolbelt", user: { login: "noavatar" }, pull_request: { merged_at: "2026-10-03T00:00:00Z" } },
    ],
  });
  beforeEach(() => {
    env = makeEnv();
    rendered.length = 0;
  });
  const get = (path: string) => worker.fetch(new Request(`https://bot.example${path}`), env, ctx);

  it("serves the page, whatever the casing of the login, with only its own images allowed", async () => {
    mockFetch(search);
    const res = await get("/leaderboard/2026-10/u/ada");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toContain("img-src 'self'");
    const html = await res.text();
    expect(html).toContain("<h1>Ada</h1>");
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg">');
    expect(html).toContain("2 merged pull requests in Hacktoberfest 2026. 1st of 2 on the leaderboard.");
    // The image address carries the numbers, so previews refresh when they change.
    expect(html).toContain("https://bot.example/leaderboard/2026-10/u/Ada.png?v=2-1-2-");
    const prs = /href="(https:\/\/github\.com\/search\?[^"]+)"/.exec(html)![1]!.replace(/&amp;/g, "&");
    expect(new URL(prs).searchParams.get("q")).toBe(
      'org:codercops is:pr is:merged author:Ada label:"hacktoberfest-accepted" merged:2026-10-01..2026-10-31'
    );
  });

  it("serves the card as a PNG drawn from the same numbers", async () => {
    mockFetch(search);
    const res = await get("/leaderboard/2026-10/u/Ada.png?v=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=600");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toContain(">Ada</text>");
    expect(rendered[0]).toContain(">#1</text>");
    expect(rendered[0]).toContain(">bot.example</text>");
    expect(rendered[0]).toContain("<image href=");

    await get("/leaderboard/2026-10/u/noavatar.png");
    expect(rendered[1]).toContain(">N</text>");
    expect(rendered[1]).toContain(">#2</text>");
  });

  it("answers 404 for people without counted PRs, unknown programs and odd names", async () => {
    mockFetch(search);
    const page = await get("/leaderboard/2026-10/u/bob");
    expect(page.status).toBe(404);
    const html = await page.text();
    expect(html).toContain("<h1>No card yet</h1>");
    expect(html).toContain("bob has no counted pull requests in Hacktoberfest 2026.");
    expect(html).toContain('<a href="/leaderboard/2026-10">See the leaderboard</a>');
    expect(html).toContain('<a href="https://github.com/search?q=example">Find an issue</a>');
    expect(html).not.toContain("The leaderboard is at");
    expect((await get("/leaderboard/2026-10/u/bob.png")).status).toBe(404);
    expect((await get("/leaderboard/2025-01/u/ada")).status).toBe(404);
    expect((await get("/leaderboard/2026-10/u/-ada")).status).toBe(404);
    expect((await get("/leaderboard/2026-10/u/a/b")).status).toBe(404);
    expect((await get(`/leaderboard/2026-10/u/${"a".repeat(40)}`)).status).toBe(404);
    expect(rendered).toHaveLength(0);
  });

  it("answers 503 when GitHub can't be reached", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 403 })) as typeof fetch;
    const res = await get("/leaderboard/2026-10/u/ada");
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("60");
  });

  it("links every row of the leaderboard to that person's card", async () => {
    mockFetch(search);
    const html = await (await get("/leaderboard/2026-10")).text();
    expect(html).toContain('<a class="cardlink" href="/leaderboard/2026-10/u/Ada"');
  });
});

describe("HEAD /leaderboard/{id}/u/{login}", () => {
  let env = makeEnv();
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const search = () => ({
    total_count: 1,
    items: [{ html_url: "https://github.com/codercops/toolbelt/pull/1", number: 1, title: "Fix a thing", repository_url: "https://api.github.com/repos/codercops/toolbelt", user: { login: "Ada" }, pull_request: { merged_at: "2026-10-02T00:00:00Z" } }],
  });
  const get = (path: string) => worker.fetch(new Request(`https://bot.example${path}`), env, ctx);
  const head = (path: string) => worker.fetch(new Request(`https://bot.example${path}`, { method: "HEAD" }), env, ctx);
  beforeEach(() => {
    env = makeEnv();
    rendered.length = 0;
  });

  it("answers the page like the GET, with no body", async () => {
    mockFetch(search);
    const res = await head("/leaderboard/2026-10/u/ada");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toContain("img-src 'self'");
    expect(await res.text()).toBe("");
  });

  it("answers the card like the GET, with the image headers and no body", async () => {
    mockFetch(search);
    const res = await head("/leaderboard/2026-10/u/Ada.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=600");
    expect(await res.text()).toBe("");
  });

  it("still 404s a HEAD for a person without a card", async () => {
    mockFetch(search);
    const res = await head("/leaderboard/2026-10/u/bob.png");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });
});

describe("the card cache", () => {
  let env = makeEnv();
  const search = () => ({
    total_count: 1,
    items: [{ html_url: "https://github.com/codercops/toolbelt/pull/1", number: 1, title: "Fix a thing", repository_url: "https://api.github.com/repos/codercops/toolbelt", user: { login: "Ada" }, pull_request: { merged_at: "2026-10-02T00:00:00Z" } }],
  });
  let cache: FakeCache;
  beforeEach(() => {
    env = makeEnv();
    rendered.length = 0;
    cache = new FakeCache();
    (globalThis as { caches?: unknown }).caches = cache.storage;
  });
  afterEach(() => {
    delete (globalThis as { caches?: unknown }).caches;
  });
  const get = (path: string) => worker.fetch(new Request(`https://bot.example${path}`), env, makeCtx().ctx);
  const head = (path: string) => worker.fetch(new Request(`https://bot.example${path}`, { method: "HEAD" }), env, makeCtx().ctx);

  it("finds the card a GET stored, so a HEAD doesn't draw it again", async () => {
    mockFetch(search);
    const { ctx, settle } = makeCtx();
    const get1 = await worker.fetch(new Request("https://bot.example/leaderboard/2026-10/u/Ada.png"), env, ctx);
    expect(get1.status).toBe(200);
    await settle();
    expect(rendered).toHaveLength(1);

    const res = await worker.fetch(new Request("https://bot.example/leaderboard/2026-10/u/Ada.png", { method: "HEAD" }), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(await res.text()).toBe("");
    // The card was already drawn, so the HEAD did not draw it a second time.
    expect(rendered).toHaveLength(1);
  });

  it("never stores an empty body under the card's address", async () => {
    mockFetch(search);
    const { ctx, settle } = makeCtx();
    await worker.fetch(new Request("https://bot.example/leaderboard/2026-10/u/Ada.png", { method: "HEAD" }), env, ctx);
    await settle();
    const keys = [...cache.entries.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^https:\/\/bot\.example\/leaderboard\/2026-10\/u\/Ada\.png\?v=1-1-1-/);
    const stored = cache.entries.get(keys[0]!);
    expect(stored).toBeDefined();
    expect(stored!.body.byteLength).toBeGreaterThan(0);

    // A GET after the HEAD still gets the whole picture.
    const res = await worker.fetch(new Request("https://bot.example/leaderboard/2026-10/u/Ada.png"), env, ctx);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("draws the card once per version, whatever ?v= or letter case the address has", async () => {
    mockFetch(search);
    const { ctx, settle } = makeCtx();
    for (const path of ["/leaderboard/2026-10/u/Ada.png?v=1", "/leaderboard/2026-10/u/ada.png?v=2", "/leaderboard/2026-10/u/ADA.png", "/leaderboard/2026-10/u/Ada.png?v=x&y=z"]) {
      const res = await worker.fetch(new Request(`https://bot.example${path}`), env, ctx);
      expect(res.status).toBe(200);
      await settle();
    }
    expect(rendered).toHaveLength(1);
    expect(cache.entries.size).toBe(1);
  });
});

describe("GET /leaderboard/{id}.png", () => {
  let env = makeEnv();
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const pr = (n: number, login: string) => ({
    html_url: `https://github.com/codercops/toolbelt/pull/${n}`,
    number: n,
    title: `PR ${n}`,
    repository_url: "https://api.github.com/repos/codercops/toolbelt",
    user: { login },
    pull_request: { merged_at: `2026-10-0${(n % 9) + 1}T00:00:00Z` },
  });
  const search = () => ({ total_count: 3, items: [pr(1, "Ada"), pr(2, "Ada"), pr(3, "noavatar")] });
  beforeEach(() => {
    env = makeEnv();
    rendered.length = 0;
  });
  const get = (path: string) => worker.fetch(new Request(`https://bot.example${path}`), env, ctx);
  const head = (path: string) => worker.fetch(new Request(`https://bot.example${path}`, { method: "HEAD" }), env, ctx);

  it("serves the board as a PNG, cached like the contributor card", async () => {
    mockFetch(search);
    const res = await get("/leaderboard/2026-10.png?v=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=600");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toContain('viewBox="0 0 1200 630"');
    expect(rendered[0]).toContain(">Hacktoberfest 2026 leaderboard</text>");
    expect(rendered[0]).toContain(">Ada</text>");
    expect(rendered[0]).toContain(">2 contributors  ·  3 merged PRs</text>");
    expect(rendered[0]).toContain(">bot.example</text>");
    // Ada's avatar came back, noavatar's didn't.
    expect(rendered[0]!.match(/<image /g)).toHaveLength(1);
    expect(rendered[0]).toContain(">N</text>");
  });

  it("draws five people at most, each with their avatar", async () => {
    const logins = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"];
    mockFetch(() => ({ total_count: 7, items: logins.map((l, i) => pr(i + 1, l)) }));
    await get("/leaderboard/2026-10.png");
    expect(rendered[0]!.match(/<image /g)).toHaveLength(5);
    expect(rendered[0]).not.toContain(">a6</text>");
  });

  it("draws an empty board", async () => {
    mockFetch();
    const res = await get("/leaderboard/2026-10.png");
    expect(res.status).toBe(200);
    expect(rendered[0]).toContain(">0 contributors  ·  0 merged PRs</text>");
    expect(rendered[0]).not.toContain(">#1</text>");
  });

  it("answers 404 for an unknown program and 503 when GitHub can't be reached", async () => {
    mockFetch(search);
    expect((await get("/leaderboard/2025-01.png")).status).toBe(404);
    expect((await get("/leaderboard/Bad.png")).status).toBe(404);
    expect(rendered).toHaveLength(0);
    globalThis.fetch = (async () => new Response("{}", { status: 403 })) as typeof fetch;
    const res = await get("/leaderboard/2026-10.png");
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("60");
  });

  it("answers a HEAD like the GET, with no body", async () => {
    mockFetch(search);
    const res = await head("/leaderboard/2026-10.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=600");
    expect(await res.text()).toBe("");
    expect((await head("/leaderboard/2025-01.png")).status).toBe(404);
  });

  it("is the page's share image, with a version that follows the top five", async () => {
    mockFetch(search);
    const html = await (await get("/leaderboard/2026-10")).text();
    const image = /<meta property="og:image" content="([^"]+)">/.exec(html)![1]!;
    expect(image).toMatch(/^https:\/\/bot\.example\/leaderboard\/2026-10\.png\?v=[a-z0-9]+$/);
    expect(html).toContain(`<meta name="twitter:image" content="${image}">`);
    // The current program's page points at the same permanent address.
    expect(await (await get("/leaderboard")).text()).toContain(`content="${image}"`);

    env = makeEnv();
    mockFetch(() => ({ total_count: 4, items: [pr(1, "Ada"), pr(2, "Ada"), pr(3, "noavatar"), pr(4, "noavatar")] }));
    const changed = await (await get("/leaderboard/2026-10")).text();
    expect(/<meta property="og:image" content="([^"]+)">/.exec(changed)![1]).not.toBe(image);
  });
});

describe("the board image cache", () => {
  let env = makeEnv();
  const search = () => ({
    total_count: 1,
    items: [{ html_url: "https://github.com/codercops/toolbelt/pull/1", number: 1, title: "Fix a thing", repository_url: "https://api.github.com/repos/codercops/toolbelt", user: { login: "Ada" }, pull_request: { merged_at: "2026-10-02T00:00:00Z" } }],
  });
  let cache: FakeCache;
  beforeEach(() => {
    env = makeEnv();
    rendered.length = 0;
    cache = new FakeCache();
    (globalThis as { caches?: unknown }).caches = cache.storage;
  });
  afterEach(() => {
    delete (globalThis as { caches?: unknown }).caches;
  });

  it("draws the image once and serves the stored copy to the next GET and HEAD", async () => {
    mockFetch(search);
    const { ctx, settle } = makeCtx();
    const url = "https://bot.example/leaderboard/2026-10.png?v=x";
    expect((await worker.fetch(new Request(url), env, ctx)).status).toBe(200);
    await settle();
    expect(rendered).toHaveLength(1);
    const again = await worker.fetch(new Request(url), env, ctx);
    expect([...new Uint8Array(await again.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const res = await worker.fetch(new Request(url, { method: "HEAD" }), env, ctx);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(await res.text()).toBe("");
    expect(rendered).toHaveLength(1);
  });

  it("never stores an empty body when a HEAD comes first", async () => {
    mockFetch(search);
    const { ctx, settle } = makeCtx();
    await worker.fetch(new Request("https://bot.example/leaderboard/2026-10.png", { method: "HEAD" }), env, ctx);
    await settle();
    const keys = [...cache.entries.keys()];
    expect(keys).toHaveLength(1);
    const stored = cache.entries.get(keys[0]!);
    expect(stored).toBeDefined();
    expect(stored!.body.byteLength).toBeGreaterThan(0);
  });

  it("draws the image once per board version, whatever ?v= the address has", async () => {
    mockFetch(search);
    const { ctx, settle } = makeCtx();
    const html = await (await worker.fetch(new Request("https://bot.example/leaderboard/2026-10"), env, ctx)).text();
    const image = /<meta property="og:image" content="([^"]+)">/.exec(html)![1]!;
    for (const query of ["?v=1", "?v=2", "", "?v=x&y=z"]) {
      const res = await worker.fetch(new Request(`https://bot.example/leaderboard/2026-10.png${query}`), env, ctx);
      expect(res.status).toBe(200);
      await settle();
    }
    expect(rendered).toHaveLength(1);
    // Stored under the address the page shares, so a preview of it finds the copy.
    expect([...cache.entries.keys()]).toEqual([image]);
  });

  it("draws a new image once the board changes", async () => {
    mockFetch(search);
    const { ctx, settle } = makeCtx();
    await worker.fetch(new Request("https://bot.example/leaderboard/2026-10.png?v=1"), env, ctx);
    await settle();
    env = makeEnv();
    mockFetch(() => ({ ...search(), total_count: 2, items: [...search().items, { ...search().items[0]!, html_url: "https://github.com/codercops/toolbelt/pull/2", number: 2 }] }));
    await worker.fetch(new Request("https://bot.example/leaderboard/2026-10.png?v=1"), env, ctx);
    await settle();
    expect(rendered).toHaveLength(2);
    expect(cache.entries.size).toBe(2);
  });
});
