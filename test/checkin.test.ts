import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyCheckin, currentStreak, daysBetween, localDate, rankStreaks, recordCheckin, type CheckinRecord } from "../src/checkin";
import { runCommand } from "../src/commands";
import { DAILY_CRON, getConfig } from "../src/config";
import worker from "../src/index";
import { checkinPost, streaksMessage } from "../src/messages";
import { makeEnv, mockFetch, ROADMAPS } from "./helpers";

const ai = ROADMAPS[0]!;
const genai = ROADMAPS[1]!;
const who = { userId: "u1", name: "Ada" };

const record = (over: Partial<CheckinRecord> = {}): CheckinRecord => ({
  userId: "u1", name: "Ada", roadmap: ai.id, threadId: "t1", day: 3, checkins: 3, lastDate: "2026-10-10", streak: 3, bestStreak: 3, ...over,
});

describe("dates", () => {
  it("uses the community time zone for the calendar date", () => {
    // 19:00 UTC is already the next day in IST (UTC+5:30).
    expect(localDate(new Date("2026-10-11T19:00:00Z"), 330)).toBe("2026-10-12");
    expect(localDate(new Date("2026-10-11T18:29:00Z"), 330)).toBe("2026-10-11");
    expect(localDate(new Date("2026-10-11T19:00:00Z"), 0)).toBe("2026-10-11");
  });

  it("counts days between dates, across month ends", () => {
    expect(daysBetween("2026-10-10", "2026-10-11")).toBe(1);
    expect(daysBetween("2026-10-31", "2026-11-01")).toBe(1);
    expect(daysBetween("2026-10-10", "2026-10-10")).toBe(0);
    expect(daysBetween("2026-10-08", "2026-10-11")).toBe(3);
  });
});

describe("applyCheckin", () => {
  it("starts at day 1 with a streak of 1", () => {
    const r = applyCheckin(null, { ...who, roadmap: ai, today: "2026-10-11" });
    expect(r).toMatchObject({ ok: true, finished: false, record: { day: 1, checkins: 1, streak: 1, bestStreak: 1, lastDate: "2026-10-11", threadId: null } });
  });

  it("continues the day number and the streak on the next day", () => {
    const r = applyCheckin(record(), { ...who, roadmap: ai, today: "2026-10-11" });
    expect(r).toMatchObject({ ok: true, record: { day: 4, checkins: 4, streak: 4, bestStreak: 4, threadId: "t1" } });
  });

  it("allows only one check-in per day", () => {
    const r = applyCheckin(record(), { ...who, roadmap: ai, today: "2026-10-10" });
    expect(r).toMatchObject({ ok: false, reason: "already-today" });
  });

  it("resets the streak after a missed day but keeps the best streak and the day count", () => {
    const r = applyCheckin(record({ streak: 7, bestStreak: 9 }), { ...who, roadmap: ai, today: "2026-10-12" });
    expect(r).toMatchObject({ ok: true, record: { day: 4, streak: 1, bestStreak: 9 } });
  });

  it("lets someone start or jump ahead with an explicit day, but never go back", () => {
    expect(applyCheckin(null, { ...who, roadmap: ai, today: "2026-10-11", day: 30 })).toMatchObject({ ok: true, record: { day: 30, checkins: 1 } });
    expect(applyCheckin(record(), { ...who, roadmap: ai, today: "2026-10-11", day: 10 })).toMatchObject({ ok: true, record: { day: 10 } });
    expect(applyCheckin(record(), { ...who, roadmap: ai, today: "2026-10-11", day: 3 })).toMatchObject({ ok: false, reason: "day-not-ahead" });
    expect(applyCheckin(record(), { ...who, roadmap: ai, today: "2026-10-11", day: 2 })).toMatchObject({ ok: false, reason: "day-not-ahead" });
  });

  it("rejects days outside the roadmap", () => {
    for (const day of [0, -1, 101, 1.5]) {
      expect(applyCheckin(null, { ...who, roadmap: ai, today: "2026-10-11", day })).toMatchObject({ ok: false, reason: "day-out-of-range" });
    }
  });

  it("marks the last day as finished and refuses check-ins after that", () => {
    const last = applyCheckin(record({ day: 20, roadmap: genai.id }), { ...who, roadmap: genai, today: "2026-10-11" });
    expect(last).toMatchObject({ ok: true, finished: true, record: { day: 21 } });
    const after = applyCheckin(record({ day: 21, roadmap: genai.id }), { ...who, roadmap: genai, today: "2026-10-12" });
    expect(after).toMatchObject({ ok: false, reason: "already-finished" });
  });
});

describe("streak ranking", () => {
  it("keeps a streak alive through today and yesterday only", () => {
    expect(currentStreak(record({ lastDate: "2026-10-11" }), "2026-10-11")).toBe(3);
    expect(currentStreak(record({ lastDate: "2026-10-10" }), "2026-10-11")).toBe(3);
    expect(currentStreak(record({ lastDate: "2026-10-09" }), "2026-10-11")).toBe(0);
  });

  it("orders by live streak, then by progress", () => {
    const ranked = rankStreaks(
      [
        record({ name: "Stale", streak: 50, lastDate: "2026-10-01", day: 60 }),
        record({ name: "Bob", streak: 2, lastDate: "2026-10-11", day: 9 }),
        record({ name: "Cy", streak: 5, lastDate: "2026-10-10", day: 5 }),
        record({ name: "Dee", streak: 2, lastDate: "2026-10-11", day: 40 }),
      ],
      "2026-10-11"
    );
    expect(ranked.map((r) => [r.name, r.live])).toEqual([["Cy", 5], ["Dee", 2], ["Bob", 2], ["Stale", 0]]);
  });
});

describe("check-in messages", () => {
  it("quotes the note line by line and mentions the learner", () => {
    const post = checkinPost({ userId: "u1", roadmap: ai, record: record({ day: 4, streak: 4 }), note: "Built a tokenizer\n# not a heading", finished: false });
    expect(post.content).toBe("**Day 4 of 100** · 4 days streak · <@u1>\n> Built a tokenizer\n> # not a heading");
  });

  it("uses the singular for a one day streak and leaves out an empty note", () => {
    const post = checkinPost({ userId: "u1", roadmap: ai, record: record({ day: 1, streak: 1 }), note: "   ", finished: false });
    expect(post.content).toBe("**Day 1 of 100** · 1 day streak · <@u1>");
  });

  it("lists streaks per roadmap, and says so when there are none", () => {
    const cfg = getConfig(makeEnv());
    const ranked = rankStreaks([record({ name: "Ada", day: 12, streak: 5, lastDate: "2026-10-11" }), record({ name: "Old *Tim*", day: 100, streak: 9, lastDate: "2026-09-01" })], "2026-10-11");
    const msg = streaksMessage(cfg, ranked);
    expect(msg.embeds).toHaveLength(1);
    expect(msg.embeds?.[0]?.title).toBe("100 Days of AI Engineer");
    expect(msg.embeds?.[0]?.description).toBe("1. **Ada** · 5 days streak · day 12 of 100\n2. **Old \\*Tim\\*** · streak ended · finished");
    expect(streaksMessage(cfg, []).content).toContain("Nobody has checked in yet");
  });
});

describe("/checkin", () => {
  let env = makeEnv();
  let cfg = getConfig(env);
  const user = { id: "u1", name: "Ada" };
  const checkin = (options: { name: string; value: string | number }[], when: string) =>
    runCommand({ name: "checkin", options }, user, env, cfg, new Date(when));

  beforeEach(() => {
    env = makeEnv();
    cfg = getConfig(env);
  });

  it("opens a tagged log thread on the first check-in, posts the day there, and never pings", async () => {
    const fetched = mockFetch();
    const reply = await checkin([{ name: "roadmap", value: ai.id }, { name: "note", value: "Set up the repo" }], "2026-10-11T08:00:00Z");

    const [thread, post] = fetched.discord();
    expect(thread).toMatchObject({ method: "POST", url: "https://discord.com/api/v10/channels/forum-ai/threads" });
    expect(thread?.body).toMatchObject({ name: "Ada · 100 Days of AI Engineer", applied_tags: ["tag-ai"] });
    expect(thread?.body.message.allowed_mentions).toEqual({ parse: [] });
    expect(post).toMatchObject({ method: "POST", url: "https://discord.com/api/v10/channels/msg-1/messages" });
    expect(post?.body.content).toBe("**Day 1 of 100** · 1 day streak · <@u1>\n> Set up the repo");
    expect(post?.body.allowed_mentions).toEqual({ parse: [] });
    expect(reply.content).toContain("Checked in: day 1 of 100");
    expect(reply.content).toContain("<#msg-1>");
  });

  it("reuses the thread the next day and grows the streak", async () => {
    const fetched = mockFetch();
    await checkin([{ name: "roadmap", value: ai.id }], "2026-10-11T08:00:00Z");
    fetched.clear();
    const reply = await checkin([{ name: "roadmap", value: ai.id }], "2026-10-12T08:00:00Z");

    expect(fetched.discord()).toHaveLength(1);
    expect(fetched.discord()[0]?.url).toBe("https://discord.com/api/v10/channels/msg-1/messages");
    expect(fetched.discord()[0]?.body.content).toBe("**Day 2 of 100** · 2 days streak · <@u1>");
    expect(reply.content).toContain("Streak: 2 days. That's your best streak so far.");
  });

  it("refuses a second check-in on the same local day and posts nothing", async () => {
    const fetched = mockFetch();
    // 08:00 UTC and 18:00 UTC are the same day in IST.
    await checkin([{ name: "roadmap", value: ai.id }], "2026-10-11T08:00:00Z");
    fetched.clear();
    const reply = await checkin([{ name: "roadmap", value: ai.id }], "2026-10-11T18:00:00Z");
    expect(reply.content).toContain("You already checked in today (day 1)");
    expect(fetched.discord()).toHaveLength(0);
  });

  it("allows only one of two concurrent check-ins for the same day to post", async () => {
    const fetched = mockFetch();
    const options = [{ name: "roadmap", value: ai.id }];
    const [first, second] = await Promise.all([
      checkin(options, "2026-10-11T08:00:00Z"),
      checkin(options, "2026-10-11T08:00:00Z"),
    ]);

    expect([first.content, second.content].filter((content) => (content ?? "").includes("Checked in:")).length).toBe(1);
    expect([first.content, second.content].filter((content) => (content ?? "").includes("already checked in today")).length).toBe(1);
    expect(fetched.discord()).toHaveLength(2); // one thread and one check-in post
    const saved = await env.STATE.get<CheckinRecord>(`checkin:${ai.id}:u1`, "json");
    expect(saved).toMatchObject({ day: 1, checkins: 1, lastDate: "2026-10-11", threadId: "msg-1" });
  });

  it("rolls back the claimed check-in when Discord rejects the post", async () => {
    const options = { userId: user.id, name: user.name, roadmapId: ai.id, now: new Date("2026-10-11T08:00:00Z") };
    mockFetch(undefined, (call) => call.url.endsWith("/channels/forum-ai/threads")
      ? new Response("{}", { status: 500 })
      : undefined);

    await expect(recordCheckin(env, cfg, options)).rejects.toThrow("Discord 500");
    expect(await env.STATE.get(`checkin:${ai.id}:u1`)).toBeNull();
  });

  it("opens a new thread when the old one was deleted", async () => {
    const first = mockFetch();
    await checkin([{ name: "roadmap", value: ai.id }], "2026-10-11T08:00:00Z");
    expect(first.discord()).toHaveLength(2);

    // The first post to the old thread fails with 404, as it does for a deleted thread.
    let failed = false;
    const second = mockFetch(undefined, (call) => {
      if (!failed && call.url.endsWith("/channels/msg-1/messages")) {
        failed = true;
        return new Response("{}", { status: 404 });
      }
      return undefined;
    });
    const reply = await checkin([{ name: "roadmap", value: ai.id }], "2026-10-12T08:00:00Z");
    const paths = second.discord().map((c) => c.url.replace("https://discord.com/api/v10", ""));
    expect(paths).toEqual(["/channels/msg-1/messages", "/channels/forum-ai/threads", "/channels/msg-1/messages"]);
    expect(second.discord()[2]?.body.content).toContain("**Day 2 of 100**");
    expect(reply.content).toContain("Checked in: day 2 of 100");
  });

  it("reopens an archived thread and retries once", async () => {
    mockFetch();
    await checkin([{ name: "roadmap", value: ai.id }], "2026-10-11T08:00:00Z");

    let failed = false;
    const second = mockFetch(undefined, (call) => {
      if (!failed && call.method === "POST" && call.url.endsWith("/channels/msg-1/messages")) {
        failed = true;
        return new Response("{}", { status: 400 });
      }
      return undefined;
    });
    const reply = await checkin([{ name: "roadmap", value: ai.id }], "2026-10-20T08:00:00Z");
    const calls = second.discord().map((c) => `${c.method} ${c.url.replace("https://discord.com/api/v10", "")}`);
    expect(calls).toEqual(["POST /channels/msg-1/messages", "PATCH /channels/msg-1", "POST /channels/msg-1/messages"]);
    expect(second.discord()[1]?.body).toEqual({ archived: false });
    // Nine days later the streak starts over, but the day number carries on.
    expect(reply.content).toContain("Checked in: day 2 of 100");
    expect(reply.content).toContain("Streak: 1 day.");
  });

  it("keeps separate progress per roadmap and per person", async () => {
    mockFetch();
    await checkin([{ name: "roadmap", value: ai.id }], "2026-10-11T08:00:00Z");
    const other = await checkin([{ name: "roadmap", value: genai.id }, { name: "day", value: 5 }], "2026-10-11T08:05:00Z");
    expect(other.content).toContain("Checked in: day 5 of 21 on **Gen AI Engineer in 3 Weeks**");
    const bob = await runCommand({ name: "checkin", options: [{ name: "roadmap", value: ai.id }] }, { id: "u2", name: "Bob" }, env, cfg, new Date("2026-10-11T09:00:00Z"));
    expect(bob.content).toContain("Checked in: day 1 of 100");
  });

  it("explains bad input instead of failing", async () => {
    mockFetch();
    expect((await checkin([{ name: "roadmap", value: "nope" }], "2026-10-11T08:00:00Z")).content).toContain("I don't know that roadmap");
    expect((await checkin([{ name: "roadmap", value: genai.id }, { name: "day", value: 40 }], "2026-10-11T08:00:00Z")).content).toContain("has days 1 to 21");
    const dm = await runCommand({ name: "checkin", options: [{ name: "roadmap", value: ai.id }] }, null, env, cfg);
    expect(dm.content).toContain("inside the server");
  });

  it("shows up in /streaks", async () => {
    mockFetch();
    await checkin([{ name: "roadmap", value: ai.id }], "2026-10-11T08:00:00Z");
    const board = await runCommand({ name: "streaks" }, user, env, cfg, new Date("2026-10-11T09:00:00Z"));
    expect(board.embeds?.[0]?.description).toBe("1. **Ada** · 1 day streak · day 1 of 100");
  });
});

describe("/streaks roadmap option", () => {
  let env = makeEnv();
  let cfg = getConfig(env);
  const user = { id: "u1", name: "Ada" };
  const streaks = (options: { name: string; value: string | number }[], when: string) =>
    runCommand({ name: "streaks", options }, user, env, cfg, new Date(when));

  beforeEach(() => {
    env = makeEnv();
    cfg = getConfig(env);
  });

  it("shows only the chosen roadmap when the option is given", async () => {
    await runCommand({ name: "checkin", options: [{ name: "roadmap", value: ai.id }] }, user, env, cfg, new Date("2026-10-11T08:00:00Z"));
    await runCommand({ name: "checkin", options: [{ name: "roadmap", value: genai.id }] }, user, env, cfg, new Date("2026-10-11T08:05:00Z"));
    mockFetch();
    const reply = await streaks([{ name: "roadmap", value: ai.id }], "2026-10-11T09:00:00Z");

    expect(reply.embeds).toHaveLength(1);
    expect(reply.embeds?.[0]?.title).toBe(ai.name);
  });

  it("is unchanged without the option", async () => {
    await runCommand({ name: "checkin", options: [{ name: "roadmap", value: ai.id }] }, user, env, cfg, new Date("2026-10-11T08:00:00Z"));
    await runCommand({ name: "checkin", options: [{ name: "roadmap", value: genai.id }] }, user, env, cfg, new Date("2026-10-11T08:05:00Z"));
    mockFetch();
    const reply = await streaks([], "2026-10-11T09:00:00Z");

    expect(reply.embeds).toHaveLength(2);
  });

  it("names the roadmap when the chosen one has no check-ins", async () => {
    await runCommand({ name: "checkin", options: [{ name: "roadmap", value: ai.id }] }, user, env, cfg, new Date("2026-10-11T08:00:00Z"));
    mockFetch();
    const reply = await streaks([{ name: "roadmap", value: genai.id }], "2026-10-11T09:00:00Z");

    expect(reply.embeds).toBeUndefined();
    expect(reply.content).toContain(`Nobody has checked in on **${genai.name}** yet`);
  });

  it("answers an unknown roadmap the same way /checkin does", async () => {
    mockFetch();
    const unknown = await streaks([{ name: "roadmap", value: "not-a-roadmap" }], "2026-10-11T09:00:00Z");
    const unknownCheckin = await runCommand(
      { name: "checkin", options: [{ name: "roadmap", value: "not-a-roadmap" }] },
      user,
      env,
      cfg,
      new Date("2026-10-11T09:00:00Z"),
    );

    expect(unknown.content).toBe(unknownCheckin.content);
  });
});

describe("weekly streak board", () => {
  const run = (env: ReturnType<typeof makeEnv>, when: string) =>
    worker.scheduled({ cron: DAILY_CRON, scheduledTime: Date.parse(when), noRetry() {} } as ScheduledController, env);

  it("is posted on Mondays when someone checked in during the past week", async () => {
    const env = makeEnv();
    mockFetch();
    await runCommand({ name: "checkin", options: [{ name: "roadmap", value: ai.id }] }, { id: "u1", name: "Ada" }, env, getConfig(env), new Date("2026-11-20T08:00:00Z"));
    const fetched = mockFetch();
    // Outside the Hacktoberfest window: only the streak board is posted.
    await run(env, "2026-11-23T04:30:00Z");
    expect(fetched.discord()).toHaveLength(1);
    expect(fetched.discord()[0]?.url).toBe("https://discord.com/api/v10/channels/chan-leaderboard/messages");
    expect(fetched.discord()[0]?.body.embeds[0].title).toBe("100 Days of AI Engineer");

    // The cron runs every day, but the board is a weekly post.
    fetched.clear();
    await run(env, "2026-11-24T04:30:00Z");
    expect(fetched.discord()).toHaveLength(0);
  });

  it("is still posted when the program leaderboard can't be fetched", async () => {
    const env = makeEnv();
    mockFetch();
    await runCommand({ name: "checkin", options: [{ name: "roadmap", value: ai.id }] }, { id: "u1", name: "Ada" }, env, getConfig(env), new Date("2026-10-09T08:00:00Z"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetched = mockFetch(() => {
      throw new Error("GitHub is down");
    });
    // A Monday during Hacktoberfest: the leaderboard fails, the streak board doesn't need GitHub.
    await run(env, "2026-10-12T04:30:00Z");
    expect(fetched.discord().map((c) => c.body.embeds[0].title)).toEqual(["100 Days of AI Engineer"]);
    expect(error).toHaveBeenCalledWith("daily post failed", "leaderboard 2026-10", expect.any(Error));
    error.mockRestore();
  });

  it("stays quiet when nobody checked in recently", async () => {
    const env = makeEnv();
    mockFetch();
    await runCommand({ name: "checkin", options: [{ name: "roadmap", value: ai.id }] }, { id: "u1", name: "Ada" }, env, getConfig(env), new Date("2026-11-01T08:00:00Z"));
    const fetched = mockFetch();
    await run(env, "2026-11-23T04:30:00Z");
    expect(fetched.discord()).toHaveLength(0);
  });
});
