// Welcomes new members. Discord only announces joins over the gateway, and this
// bot has no gateway connection, so a cron looks at the member list every
// minute and greets whoever is new.
import type { Config, Env } from "./config";
import { DiscordError, listChannelMessages, listGuildMembers, sendMessage, type GuildMember } from "./discord";
import { welcomeMessage } from "./messages";
import { linkingEnabled } from "./oauth";

// Only people who joined this recently are candidates. That keeps the usual
// run to one API call and no storage reads, and it means switching the feature
// on never greets people who have been around for months.
const WINDOW_MS = 2 * 60 * 60 * 1000;
/** A channel takes about five messages per five seconds; the rest wait for the next run. */
const MAX_PER_RUN = 5;
const REMEMBER_SECONDS = 30 * 24 * 60 * 60;

const welcomedKey = (userId: string) => `welcomed:${userId}`;

/** Greets members who joined in the last two hours and haven't been greeted. Returns how many posts went out. */
export async function welcomeNewMembers(env: Env, cfg: Config, now: Date): Promise<number> {
  if (!cfg.guildId || !cfg.welcomeChannel) return 0;

  let members: GuildMember[];
  try {
    members = await listGuildMembers(env, cfg.guildId);
  } catch (err) {
    // The Server Members intent is off. Nothing to do until someone turns it on.
    if (err instanceof DiscordError && err.status === 403) return 0;
    throw err;
  }

  const since = now.getTime() - WINDOW_MS;
  const fresh = members
    .filter((m) => m.user && !m.user.bot && !m.pending && Date.parse(m.joined_at) >= since)
    .sort((a, b) => a.joined_at.localeCompare(b.joined_at));
  if (fresh.length === 0) return 0;

  const unseen: string[] = [];
  for (const member of fresh) {
    const id = member.user!.id;
    if (!(await env.STATE.get(welcomedKey(id)))) unseen.push(id);
  }
  if (unseen.length === 0) return 0;

  // KV can take a minute to show its own writes everywhere, and this runs every
  // minute. The channel itself is the reliable record of who already got a
  // welcome, so check it before posting.
  const recent = await listChannelMessages(env, cfg.welcomeChannel);
  const greeted = new Set(
    recent.filter((m) => m.author.id === env.DISCORD_APPLICATION_ID).flatMap((m) => (m.mentions ?? []).map((u) => u.id))
  );

  let sent = 0;
  for (const id of unseen) {
    if (greeted.has(id)) {
      await env.STATE.put(welcomedKey(id), now.toISOString(), { expirationTtl: REMEMBER_SECONDS });
      continue;
    }
    if (sent >= MAX_PER_RUN) break;
    await sendMessage(env, cfg.welcomeChannel, welcomeMessage(id, cfg, { linking: linkingEnabled(env), issuesUrl: env.ISSUES_URL }), {
      ping: [id],
    });
    await env.STATE.put(welcomedKey(id), now.toISOString(), { expirationTtl: REMEMBER_SECONDS });
    sent++;
  }
  return sent;
}
