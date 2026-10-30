// Daily check-ins for the learning roadmaps. The rules live in pure functions
// at the top; the KV and Discord calls are at the bottom.
import type { Config, Env, Roadmap } from "./config";
import { createForumPost, DiscordError, reopenThread, sendMessage, type MessagePayload } from "./discord";
import { checkinPost, checkinThreadIntro } from "./messages";

export interface CheckinRecord {
  userId: string;
  /** Display name at the time of the last check-in. */
  name: string;
  roadmap: string;
  /** The learner's log thread in the roadmap's forum. */
  threadId: string | null;
  /** The last day number they logged. */
  day: number;
  /** How many days they have logged in total. */
  checkins: number;
  /** Community-local date (YYYY-MM-DD) of the last check-in. */
  lastDate: string;
  streak: number;
  bestStreak: number;
}

/** The calendar date in the community's time zone, as YYYY-MM-DD. */
export function localDate(now: Date, utcOffsetMinutes: number): string {
  return new Date(now.getTime() + utcOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export type CheckinResult =
  | { ok: true; record: CheckinRecord; finished: boolean }
  | { ok: false; reason: "already-today" | "already-finished" | "day-out-of-range" | "day-not-ahead"; record: CheckinRecord | null };

/**
 * Applies one check-in.
 *
 * - One check-in per day and roadmap counts, so nobody can log a week in a minute.
 * - The day number defaults to the previous one plus one. A learner can pass a
 *   higher number (they started before the bot existed, or skipped ahead) but
 *   can never go backwards.
 * - A streak continues only if the last check-in was yesterday.
 */
export function applyCheckin(
  prev: CheckinRecord | null,
  input: { userId: string; name: string; roadmap: Roadmap; today: string; day?: number }
): CheckinResult {
  const { roadmap, today } = input;
  if (prev && prev.day >= roadmap.days) return { ok: false, reason: "already-finished", record: prev };
  if (prev && prev.lastDate === today) return { ok: false, reason: "already-today", record: prev };

  const day = input.day ?? (prev ? prev.day + 1 : 1);
  if (!Number.isInteger(day) || day < 1 || day > roadmap.days) return { ok: false, reason: "day-out-of-range", record: prev };
  if (prev && day <= prev.day) return { ok: false, reason: "day-not-ahead", record: prev };

  const streak = prev && daysBetween(prev.lastDate, today) === 1 ? prev.streak + 1 : 1;
  const record: CheckinRecord = {
    userId: input.userId,
    name: input.name,
    roadmap: roadmap.id,
    threadId: prev?.threadId ?? null,
    day,
    checkins: (prev?.checkins ?? 0) + 1,
    lastDate: today,
    streak,
    bestStreak: Math.max(prev?.bestStreak ?? 0, streak),
  };
  return { ok: true, record, finished: day >= roadmap.days };
}

/** A streak is alive if the last check-in was today or yesterday; otherwise it's back to zero. */
export function currentStreak(record: CheckinRecord, today: string): number {
  return daysBetween(record.lastDate, today) <= 1 ? record.streak : 0;
}

/** Longest live streak first, then whoever is furthest along. */
export function rankStreaks(records: CheckinRecord[], today: string): (CheckinRecord & { live: number })[] {
  return records
    .map((r) => ({ ...r, live: currentStreak(r, today) }))
    .sort((a, b) => b.live - a.live || b.day - a.day || a.name.localeCompare(b.name));
}

// ---- storage and Discord ----

const key = (roadmapId: string, userId: string) => `checkin:${roadmapId}:${userId}`;

// KV has no compare-and-swap. Serialize the read/validate/write claim within
// this Worker isolate so concurrent requests can't both claim the same day.
const checkinLocks = new Map<string, Promise<void>>();

async function withCheckinLock<T>(recordKey: string, fn: () => Promise<T>): Promise<T> {
  const previous = checkinLocks.get(recordKey);
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  checkinLocks.set(recordKey, current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (checkinLocks.get(recordKey) === current) checkinLocks.delete(recordKey);
  }
}

export async function listCheckins(env: Env): Promise<CheckinRecord[]> {
  const records: CheckinRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.STATE.list({ prefix: "checkin:", cursor });
    const values = await Promise.all(page.keys.map((k) => env.STATE.get<CheckinRecord>(k.name, "json")));
    for (const v of values) if (v) records.push(v);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return records;
}

export interface CheckinOutcome {
  result: CheckinResult;
  roadmap: Roadmap;
  threadId?: string;
}

export async function recordCheckin(
  env: Env,
  cfg: Config,
  input: { userId: string; name: string; roadmapId: string; day?: number; note?: string; now: Date }
): Promise<CheckinOutcome | null> {
  const roadmap = cfg.roadmaps.find((r) => r.id === input.roadmapId);
  if (!roadmap) return null;

  const today = localDate(input.now, cfg.checkinUtcOffsetMinutes);
  const recordKey = key(roadmap.id, input.userId);
  const claim = await withCheckinLock(recordKey, async () => {
    const prev = await env.STATE.get<CheckinRecord>(recordKey, "json");
    const result = applyCheckin(prev, { userId: input.userId, name: input.name, roadmap, today, day: input.day });
    if (!result.ok) return { prev, result };

    // Persist the day's claim before the Discord round trip. A concurrent
    // request then sees the claim and cannot create a duplicate post/thread.
    await env.STATE.put(recordKey, JSON.stringify(result.record));
    return { prev, result };
  });
  if (!claim.result.ok) {
    return { result: claim.result, roadmap, threadId: claim.prev?.threadId ?? undefined };
  }

  const { result, prev } = claim;
  const { record } = result;
  const post = checkinPost({ userId: record.userId, roadmap, record, note: input.note, finished: result.finished });
  try {
    record.threadId = await postToLog(env, roadmap, record, post);
  } catch (err) {
    // Release the claim if Discord rejected the post so the learner can retry.
    try {
      if (prev) await env.STATE.put(recordKey, JSON.stringify(prev));
      else await env.STATE.delete(recordKey);
    } catch {
      // Keep the original Discord error; a surviving claim is safer than a duplicate.
    }
    throw err;
  }
  await env.STATE.put(recordKey, JSON.stringify(record));
  return { result, roadmap, threadId: record.threadId };
}

/** Posts into the learner's log thread, opening it first if they don't have one (or it was deleted). */
async function postToLog(env: Env, roadmap: Roadmap, record: CheckinRecord, post: MessagePayload): Promise<string> {
  if (record.threadId) {
    try {
      await sendMessage(env, record.threadId, post);
      return record.threadId;
    } catch (err) {
      if (!(err instanceof DiscordError)) throw err;
      if (err.status !== 404) {
        // Most likely the thread was archived after a quiet spell. Reopen it
        // and try once more; a second failure is a real one.
        await reopenThread(env, record.threadId);
        await sendMessage(env, record.threadId, post);
        return record.threadId;
      }
      // 404: the thread was deleted, so start a new one below.
    }
  }
  const threadId = await createForumPost(env, roadmap.forum, {
    name: `${record.name} · ${roadmap.name}`.slice(0, 100),
    appliedTags: roadmap.tag ? [roadmap.tag] : [],
    message: checkinThreadIntro(record.userId, roadmap),
  });
  await sendMessage(env, threadId, post);
  return threadId;
}
