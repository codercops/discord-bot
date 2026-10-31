import { beforeEach, describe, expect, it } from "vitest";
import { getConfig, WELCOME_CRON } from "../src/config";
import worker from "../src/index";
import { welcomeMessage } from "../src/messages";
import { welcomeNewMembers } from "../src/welcome";
import { makeEnv, mockFetch, type RecordedCall } from "./helpers";

const now = new Date("2026-10-12T10:00:00Z");
const minutesAgo = (n: number) => new Date(now.getTime() - n * 60 * 1000).toISOString();
const jsonResponse = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const member = (id: string, joinedMinutesAgo: number, extra: Record<string, unknown> = {}) => ({
  user: { id, username: `user${id}` },
  roles: [],
  joined_at: minutesAgo(joinedMinutesAgo),
  ...extra,
});

/** Serves the member list and the welcome channel's recent messages. Posts get the default answer. */
function server(members: unknown[], channelMessages: unknown[] = []) {
  return (call: RecordedCall): Response | undefined => {
    if (call.method !== "GET") return undefined;
    if (call.url.includes("/guilds/guild-1/members?")) return jsonResponse(members);
    if (call.url.includes("/channels/chan-welcome/messages")) return jsonResponse(channelMessages);
    return undefined;
  };
}

let env = makeEnv();
let cfg = getConfig(env);
beforeEach(() => {
  env = makeEnv();
  cfg = getConfig(env);
});
const posts = (fetched: ReturnType<typeof mockFetch>) => fetched.calls.filter((c) => c.method === "POST");

describe("welcomeNewMembers", () => {
  it("does one cheap check and nothing else when nobody is new", async () => {
    const fetched = mockFetch(undefined, server([member("1", 60 * 24 * 90), member("2", 60 * 24 * 3)]));
    expect(await welcomeNewMembers(env, cfg, now)).toBe(0);
    expect(fetched.calls).toHaveLength(1);
    expect(fetched.calls[0]?.url).toBe("https://discord.com/api/v10/guilds/guild-1/members?limit=1000&after=0");
    expect(env.STATE.store.size).toBe(0);
  });

  it("welcomes a new member once, and notifies only them", async () => {
    const fetched = mockFetch(undefined, server([member("1", 60 * 24 * 90), member("42", 1)]));
    expect(await welcomeNewMembers(env, cfg, now)).toBe(1);
    const post = posts(fetched)[0];
    expect(post?.url).toBe("https://discord.com/api/v10/channels/chan-welcome/messages");
    expect(post?.body.content).toBe("Welcome, <@42>!");
    expect(post?.body.allowed_mentions).toEqual({ parse: [], users: ["42"] });
    expect(env.STATE.store.has("welcomed:42")).toBe(true);

    fetched.clear();
    expect(await welcomeNewMembers(env, cfg, new Date(now.getTime() + 60_000))).toBe(0);
    expect(posts(fetched)).toHaveLength(0);
  });

  it("trusts the channel over storage, so a slow KV write can't cause a second welcome", async () => {
    // Storage hasn't caught up, but the bot's own post from a minute ago is in the channel.
    const earlier = [
      { id: "m1", author: { id: "111" }, mentions: [{ id: "42" }] },
      { id: "m2", author: { id: "999" }, mentions: [{ id: "43" }] },
    ];
    const fetched = mockFetch(undefined, server([member("42", 2), member("43", 1)], earlier));
    expect(await welcomeNewMembers(env, cfg, now)).toBe(1);
    // 43 was only mentioned by another member, so they still get their welcome.
    expect(posts(fetched).map((c) => c.body.content)).toEqual(["Welcome, <@43>!"]);
    expect(env.STATE.store.has("welcomed:42")).toBe(true);
  });

  it("retries a member on the next run if sending the welcome fails", async () => {
    let failSend = true;
    const fetched = mockFetch(undefined, (call) => {
      const base = server([member("42", 1)])(call);
      if (base) return base;
      if (call.method === "POST" && call.url.includes("/channels/chan-welcome/messages") && failSend) {
        return jsonResponse({ message: "Internal Server Error" }, 500);
      }
      return undefined;
    });

    await expect(welcomeNewMembers(env, cfg, now)).rejects.toThrow("Discord 500");
    expect(env.STATE.store.has("welcomed:42")).toBe(false);

    failSend = false;
    fetched.clear();
    expect(await welcomeNewMembers(env, cfg, new Date(now.getTime() + 60_000))).toBe(1);
    expect(posts(fetched).map((c) => c.body.content)).toEqual(["Welcome, <@42>!"]);
    expect(env.STATE.store.has("welcomed:42")).toBe(true);
  });

  it("skips bots, people still on the rules screen and people who joined a while ago", async () => {
    const fetched = mockFetch(
      undefined,
      server([
        member("1", 1, { user: { id: "1", username: "mee6", bot: true } }),
        member("2", 1, { pending: true }),
        member("3", 121),
        { roles: [], joined_at: minutesAgo(1) },
      ])
    );
    expect(await welcomeNewMembers(env, cfg, now)).toBe(0);
    expect(posts(fetched)).toHaveLength(0);
  });

  it("welcomes at most five people per run, oldest first, and the rest on the next one", async () => {
    const crowd = Array.from({ length: 7 }, (_, i) => member(String(10 + i), 7 - i));
    const fetched = mockFetch(undefined, server(crowd));
    expect(await welcomeNewMembers(env, cfg, now)).toBe(5);
    expect(posts(fetched).map((c) => c.body.content)).toEqual([10, 11, 12, 13, 14].map((id) => `Welcome, <@${id}>!`));

    fetched.clear();
    expect(await welcomeNewMembers(env, cfg, now)).toBe(2);
    expect(posts(fetched).map((c) => c.body.content)).toEqual(["Welcome, <@15>!", "Welcome, <@16>!"]);
  });

  it("stays quiet while the Server Members intent is off, or when no welcome channel is set", async () => {
    const fetched = mockFetch(undefined, (call) => (call.url.includes("/members?") ? jsonResponse({ code: 50001 }, 403) : undefined));
    expect(await welcomeNewMembers(env, cfg, now)).toBe(0);
    expect(fetched.calls).toHaveLength(1);

    fetched.clear();
    const off = makeEnv({ CHANNEL_WELCOME: "" });
    expect(await welcomeNewMembers(off, getConfig(off), now)).toBe(0);
    expect(fetched.calls).toHaveLength(0);
  });

  it("lets other Discord errors through so the run shows as failed", async () => {
    mockFetch(undefined, (call) => (call.url.includes("/members?") ? jsonResponse({}, 500) : undefined));
    await expect(welcomeNewMembers(env, cfg, now)).rejects.toThrow("Discord 500");
  });

  it("runs from its own cron", async () => {
    const fetched = mockFetch(undefined, server([member("42", 1)]));
    await worker.scheduled({ cron: WELCOME_CRON, scheduledTime: now.getTime(), noRetry() {} } as ScheduledController, env);
    expect(posts(fetched)).toHaveLength(1);
    // And only from that one: the daily cron doesn't touch the member list.
    fetched.clear();
    await worker.scheduled({ cron: "30 4 * * *", scheduledTime: Date.parse("2026-10-13T04:30:00Z"), noRetry() {} } as ScheduledController, env);
    expect(fetched.calls.some((c) => c.url.includes("/members"))).toBe(false);
  });
});

describe("welcomeMessage", () => {
  it("points to the things a new member can do", () => {
    const message = welcomeMessage("42", cfg, { linking: false, issuesUrl: "https://github.com/search?q=x" });
    const text = message.embeds?.[0]?.description ?? "";
    expect(text).toContain("Say hi in this channel.");
    expect(text).toContain("Run `/issues`");
    expect(text).toContain("Pick a roadmap in <#chan-roadmaps> and log each day with `/checkin`.");
    expect(message.components?.[0]?.components).toEqual([
      { type: 2, style: 5, label: "Find an issue", url: "https://github.com/search?q=x" },
      { type: 2, style: 5, label: "Pick a roadmap", url: "https://discord.com/channels/guild-1/chan-roadmaps" },
    ]);
  });

  it("offers the Link GitHub button only when linking is on", () => {
    const off = welcomeMessage("42", cfg, { linking: false });
    expect(off.embeds?.[0]?.description).not.toContain("Link your GitHub");
    const on = welcomeMessage("42", cfg, { linking: true });
    expect(on.embeds?.[0]?.description).toContain("Link your GitHub with the button below");
    expect(on.components?.[0]?.components[0]).toEqual({ type: 2, style: 1, label: "Link GitHub", custom_id: "link" });
  });

  it("works without a roadmaps channel or any links", () => {
    const bare = makeEnv({ CHANNEL_ROADMAPS: "" });
    const message = welcomeMessage("42", getConfig(bare), { linking: false });
    expect(message.embeds?.[0]?.description).not.toContain("roadmap in");
    expect(message.components).toBeUndefined();
  });
});
