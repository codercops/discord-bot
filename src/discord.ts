import { version } from "../package.json";
import type { Env } from "./config";

const API = "https://discord.com/api/v10";

export interface Embed {
  title?: string;
  url?: string;
  description?: string;
  color?: number;
  footer?: { text: string };
  timestamp?: string;
}

export interface Button {
  type: 2;
  /** 1 = a button that sends us an interaction (needs custom_id), 5 = a plain link (needs url). */
  style: 1 | 5;
  label: string;
  custom_id?: string;
  url?: string;
}

export interface ActionRow {
  type: 1;
  components: Button[];
}

export interface MessagePayload {
  content?: string;
  embeds?: Embed[];
  components?: ActionRow[];
  /** 64 = ephemeral (only the person who ran the command sees it). */
  flags?: number;
  allowed_mentions?: { parse: string[] };
}

// The bot doesn't ping people. GitHub logins are plain text, and Discord mentions
// show the member's name without notifying them. The one exception is the
// welcome post, which notifies the member it's for (see `ping` in sendMessage).
const NO_MENTIONS = { parse: [] as string[] };

export class DiscordError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

const MAX_RETRY_SECONDS = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getRetryAfter(res: Response): Promise<number | undefined> {
  const header = res.headers.get("retry-after");
  if (header !== null && header.trim() !== "") {
    const val = Number(header);
    if (Number.isFinite(val)) return val;
  }
  try {
    const data = (await res.clone().json()) as { retry_after?: unknown };
    if (typeof data?.retry_after === "number" && Number.isFinite(data.retry_after)) {
      return data.retry_after;
    }
    if (typeof data?.retry_after === "string" && data.retry_after.trim() !== "") {
      const val = Number(data.retry_after);
      if (Number.isFinite(val)) return val;
    }
  } catch {
    // not JSON
  }
  return undefined;
}

export async function botRequest<T>(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
  /** Shown in the server's audit log next to the change. */
  reason?: string
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
    "Content-Type": "application/json",
    "User-Agent": `DiscordBot (https://github.com/codercops/discord-bot, ${version})`,
  };
  if (reason) headers["X-Audit-Log-Reason"] = encodeURIComponent(reason);

  const execute = () =>
    fetch(`${API}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  let res = await execute();
  if (res.status === 429) {
    const wait = await getRetryAfter(res);
    if (wait !== undefined && wait >= 0 && wait <= MAX_RETRY_SECONDS) {
      await sleep(wait * 1000);
      res = await execute();
    }
  }

  if (!res.ok) {
    throw new DiscordError(res.status, `Discord ${res.status} for ${method} ${path}`);
  }
  // Role changes answer 204 with no body.
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** Posts a message and returns its id. `ping` lists the user ids the message may notify. */
export async function sendMessage(
  env: Env,
  channelId: string,
  payload: MessagePayload,
  opts: { ping?: string[] } = {}
): Promise<string> {
  const message = await botRequest<{ id: string }>(env, "POST", `/channels/${channelId}/messages`, {
    ...payload,
    allowed_mentions: opts.ping?.length ? { parse: [], users: opts.ping } : NO_MENTIONS,
  });
  return message.id;
}

export async function editMessage(
  env: Env,
  channelId: string,
  messageId: string,
  payload: MessagePayload
): Promise<void> {
  await botRequest(env, "PATCH", `/channels/${channelId}/messages/${messageId}`, {
    ...payload,
    allowed_mentions: NO_MENTIONS,
  });
}

/** Starts a post (thread) in a forum channel and returns the thread id. */
export async function createForumPost(
  env: Env,
  forumId: string,
  post: { name: string; appliedTags: string[]; message: MessagePayload }
): Promise<string> {
  const thread = await botRequest<{ id: string }>(env, "POST", `/channels/${forumId}/threads`, {
    name: post.name,
    applied_tags: post.appliedTags,
    message: { ...post.message, allowed_mentions: NO_MENTIONS },
  });
  return thread.id;
}

/** Unarchives a thread so it can take messages again. */
export async function reopenThread(env: Env, threadId: string): Promise<void> {
  await botRequest(env, "PATCH", `/channels/${threadId}`, { archived: false });
}

/** Fills in a deferred interaction response. Uses the interaction token, not the bot token. */
export async function editInteractionReply(env: Env, interactionToken: string, payload: MessagePayload): Promise<void> {
  const res = await fetch(`${API}/webhooks/${env.DISCORD_APPLICATION_ID}/${interactionToken}/messages/@original`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, allowed_mentions: NO_MENTIONS }),
  });
  if (!res.ok) throw new Error(`Discord ${res.status} editing interaction reply`);
}

// ---- members and roles ----

export interface GuildMember {
  user?: { id: string; username: string; global_name?: string | null; bot?: boolean };
  nick?: string | null;
  roles: string[];
  joined_at: string;
  /** True until the member has accepted the server's rules screening, when the server uses it. */
  pending?: boolean;
}

/** Every member of the server. Discord answers 403 unless the app has the Server Members intent. */
export async function listGuildMembers(env: Env, guildId: string): Promise<GuildMember[]> {
  const members: GuildMember[] = [];
  let after = "0";
  // 1000 per page. Ten pages is far more than we need and keeps the loop finite.
  for (let page = 0; page < 10; page++) {
    const batch = await botRequest<GuildMember[]>(env, "GET", `/guilds/${guildId}/members?limit=1000&after=${after}`);
    members.push(...batch);
    const last = batch[batch.length - 1]?.user?.id;
    if (batch.length < 1000 || !last) break;
    after = last;
  }
  return members;
}

/** One member, or null when that person isn't in the server. */
export async function getGuildMember(env: Env, guildId: string, userId: string): Promise<GuildMember | null> {
  try {
    return await botRequest<GuildMember>(env, "GET", `/guilds/${guildId}/members/${userId}`);
  } catch (err) {
    if (err instanceof DiscordError && err.status === 404) return null;
    throw err;
  }
}

export async function addMemberRole(env: Env, guildId: string, userId: string, roleId: string, reason: string): Promise<void> {
  await botRequest(env, "PUT", `/guilds/${guildId}/members/${userId}/roles/${roleId}`, undefined, reason);
}

export async function removeMemberRole(env: Env, guildId: string, userId: string, roleId: string, reason: string): Promise<void> {
  await botRequest(env, "DELETE", `/guilds/${guildId}/members/${userId}/roles/${roleId}`, undefined, reason);
}

export interface ChannelMessage {
  id: string;
  author: { id: string };
  mentions?: { id: string }[];
}

/** The newest messages of a channel, newest first. */
export async function listChannelMessages(env: Env, channelId: string, limit = 100): Promise<ChannelMessage[]> {
  return botRequest<ChannelMessage[]>(env, "GET", `/channels/${channelId}/messages?limit=${limit}`);
}
