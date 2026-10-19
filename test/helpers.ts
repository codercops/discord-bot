import type { Env } from "../src/config";

/** A minimal in-memory stand-in for a KV namespace. */
export class FakeKV {
  store = new Map<string, string>();
  async get(key: string, type?: "json"): Promise<unknown> {
    const value = this.store.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) : value;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  async list(opts: { prefix?: string; limit?: number } = {}) {
    const keys = [...this.store.keys()]
      .filter((k) => k.startsWith(opts.prefix ?? ""))
      .slice(0, opts.limit)
      .map((name) => ({ name }));
    return { keys, list_complete: true, cursor: "" };
  }
}

export const ROADMAPS = [
  { id: "ai-engineer-100", name: "100 Days of AI Engineer", days: 100, url: "https://example.com/ai", forum: "forum-ai", tag: "tag-ai" },
  { id: "gen-ai-21", name: "Gen AI Engineer in 3 Weeks", days: 21, url: "https://example.com/genai", forum: "forum-logs", tag: "tag-genai" },
];

export const OCTOBER = {
  id: "2026-10",
  title: "Hacktoberfest 2026",
  kind: "merged-prs",
  label: "hacktoberfest-accepted",
  start: "2026-10-01T00:00:00Z",
  end: "2026-10-31T23:59:59Z",
  minPrs: 5,
  topN: 5,
  reward: "a CODERCOPS T-shirt and stickers",
  note: "This swag comes from CODERCOPS, separate from Hacktoberfest.",
};

export function makeEnv(overrides: Partial<Env> = {}): Env & { STATE: FakeKV & KVNamespace } {
  return {
    STATE: new FakeKV() as unknown as FakeKV & KVNamespace,
    DISCORD_BOT_TOKEN: "test-bot-token",
    GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
    DISCORD_APPLICATION_ID: "111",
    DISCORD_PUBLIC_KEY: "",
    CHANNEL_RELEASES: "chan-releases",
    CHANNEL_STARTER_ISSUES: "chan-issues",
    CHANNEL_MERGED_PRS: "chan-merged",
    CHANNEL_LEADERBOARD: "chan-leaderboard",
    GITHUB_ORG: "codercops",
    REPOS: "chatcops,ogcops,toolbelt",
    STARTER_LABELS: "good first issue,help wanted",
    EXCLUDED_USERS: "anurag629",
    PROGRAMS: [OCTOBER],
    PUBLIC_URL: "https://bot.example",
    DISCORD_GUILD_ID: "guild-1",
    CHANNEL_WELCOME: "chan-welcome",
    CHANNEL_ROADMAPS: "chan-roadmaps",
    ROLE_TIERS: [
      { minPrs: 5, role: "role-top", name: "Top Contributor" },
      { minPrs: 1, role: "role-contributor", name: "Contributor" },
    ],
    ROADMAPS,
    CHECKIN_UTC_OFFSET_MINUTES: "330",
    DISCORD_INVITE: "https://discord.gg/example",
    ISSUES_URL: "https://github.com/search?q=example",
    ...overrides,
  } as Env & { STATE: FakeKV & KVNamespace };
}

export interface RecordedCall {
  url: string;
  method: string;
  /** Parsed JSON, or the fields of a form-encoded body. */
  body: any;
  /** The Authorization header, when the call had one. */
  auth?: string;
  userAgent?: string;
}

/**
 * A stand-in for the Workers cache. Cloudflare's cache only takes GET
 * requests, and a match without `ignoreMethod` only finds a GET entry, so a
 * HEAD has to be re-keyed as a GET to reach the card.
 */
export class FakeCache {
  /** The stored entries, keyed by address. */
  entries = new Map<string, { body: ArrayBuffer; headers: Headers; status: number }>();

  async match(request: Request, options?: { ignoreMethod?: boolean }): Promise<Response | undefined> {
    if (!options?.ignoreMethod && request.method !== "GET") return undefined;
    const hit = this.entries.get(request.url);
    return hit && new Response(hit.body, { status: hit.status, headers: hit.headers });
  }

  async put(request: Request, response: Response): Promise<void> {
    if (request.method !== "GET") throw new Error("The cache only takes GET requests");
    this.entries.set(request.url, {
      body: await response.arrayBuffer(),
      headers: response.headers,
      status: response.status,
    });
  }

  /** The cache as the Worker sees it. */
  readonly storage = { open: async () => this };
}

/** A context that keeps the work the Worker hands to `waitUntil`, so a test can wait for it. */
export function makeCtx() {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
  return { ctx, settle: () => Promise.all(pending) };
}

function parseBody(body: unknown): unknown {
  if (typeof body !== "string") return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return Object.fromEntries(new URLSearchParams(body));
  }
}

/**
 * Replaces global fetch. Discord calls are recorded and answered with a fake
 * message id; GitHub calls are answered by `github(url)`.
 */
export function mockFetch(
  github: (url: URL) => unknown = () => ({ total_count: 0, items: [] }),
  /** Return a Response to override the default Discord answer for a call. */
  discord: (call: RecordedCall) => Response | undefined = () => undefined
) {
  const calls: RecordedCall[] = [];
  let nextId = 1;
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const body = parseBody(init?.body);
    const headers = new Headers(init?.headers);
    const auth = headers.get("Authorization") ?? undefined;
    const userAgent = headers.get("User-Agent") ?? undefined;
    calls.push({ url: url.href, method, body, auth, userAgent });
    if (url.hostname === "api.github.com") {
      const response = github(url);
      return response instanceof Response ? response : new Response(JSON.stringify(response), { status: 200 });
    }
    const override = discord({ url: url.href, method, body, auth });
    if (override) return override;
    return new Response(JSON.stringify({ id: `msg-${nextId++}` }), { status: 200 });
  };
  globalThis.fetch = impl as typeof fetch;
  return {
    calls,
    discord: () => calls.filter((c) => c.url.startsWith("https://discord.com/")),
    clear: () => void calls.splice(0),
  };
}
