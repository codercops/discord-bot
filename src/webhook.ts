// Handles GitHub webhook events: releases, starter issues and merged PRs.
import type { Config, Env } from "./config";
import { editMessage, sendMessage } from "./discord";
import { countMergedPrs, searchMergedPrs, type StarterIssue } from "./github";
import { invalidateLeaderboard } from "./leaderboard";
import { getLinkByGithub } from "./links";
import { grantEarnedRoles } from "./roles";
import { mergedPrMessage, releaseMessage, starterIssueMessage, type StarterState } from "./messages";

interface Repository {
  name: string;
  owner: { login: string };
}

interface ReleaseEvent {
  action: string;
  repository: Repository;
  release: { name: string | null; tag_name: string; body: string | null; html_url: string; draft: boolean; prerelease: boolean };
}

interface IssuesEvent {
  action: string;
  repository: Repository;
  /** The label that was added or removed, on labeled/unlabeled events. */
  label?: { name: string };
  issue: {
    number: number;
    title: string;
    html_url: string;
    state: "open" | "closed";
    state_reason?: string | null;
    labels: { name: string }[];
    assignees: { login: string }[];
    pull_request?: unknown;
  };
}

interface PullRequestEvent {
  action: string;
  repository: Repository;
  pull_request: {
    number: number;
    title: string;
    html_url: string;
    merged: boolean;
    merged_at: string | null;
    user: { login: string; type: string };
    labels: { name: string }[];
  };
}

const ours = (cfg: Config, repo: Repository) =>
  repo.owner.login.toLowerCase() === cfg.org.toLowerCase() && cfg.repos.includes(repo.name);

export async function handleGithubEvent(event: string, payload: unknown, env: Env, cfg: Config): Promise<string> {
  switch (event) {
    case "ping":
      return "pong";
    case "release":
      return onRelease(payload as ReleaseEvent, env, cfg);
    case "issues":
      return onIssue(payload as IssuesEvent, env, cfg);
    case "pull_request":
      return onPullRequest(payload as PullRequestEvent, env, cfg);
    default:
      return `ignored event ${event}`;
  }
}

async function onRelease(e: ReleaseEvent, env: Env, cfg: Config): Promise<string> {
  if (e.action !== "published" || e.release.draft || e.release.prerelease || !ours(cfg, e.repository)) {
    return "ignored release";
  }
  await sendMessage(env, env.CHANNEL_RELEASES, releaseMessage(e.repository.name, e.release));
  return "posted release";
}

/** An issue belongs in the feed when it has a starter label and isn't blocked. */
export function isStarterIssue(labels: string[], cfg: Config): boolean {
  const names = labels.map((l) => l.toLowerCase());
  return names.some((n) => cfg.starterLabels.includes(n)) && !names.includes("blocked");
}

export function starterState(issue: IssuesEvent["issue"], cfg?: Config, action?: string): StarterState {
  if (action === "deleted" || action === "transferred") return { kind: "unavailable" };
  if (issue.state === "closed") {
    return issue.state_reason && issue.state_reason !== "completed" ? { kind: "unavailable" } : { kind: "done" };
  }
  const labels = (issue.labels ?? []).map((l) => l.name);
  if (cfg && !isStarterIssue(labels, cfg)) return { kind: "unavailable" };
  const assignee = issue.assignees?.[0];
  return assignee ? { kind: "claimed", by: assignee.login } : { kind: "open" };
}

interface FeedRecord {
  messageId: string;
  state: StarterState["kind"];
  message?: string;
}

function starterIssueSnapshot(message: ReturnType<typeof starterIssueMessage>): string {
  const embed = message.embeds?.[0];
  return JSON.stringify({
    title: embed?.title,
    url: embed?.url,
    description: embed?.description,
    color: embed?.color,
  });
}

// Keeps one message per issue in #starter-issues and edits it as the issue is
// claimed, released or closed, so the feed always shows what's really free.
async function onIssue(e: IssuesEvent, env: Env, cfg: Config): Promise<string> {
  if (!ours(cfg, e.repository) || e.issue.pull_request) return "ignored issue";
  const labels = (e.issue.labels ?? []).map((l) => l.name);
  const issue: StarterIssue = {
    repo: e.repository.name,
    number: e.issue.number,
    title: e.issue.title,
    url: e.issue.html_url,
    labels,
  };
  const key = `issue:${issue.repo}#${issue.number}`;
  const record = await env.STATE.get<FeedRecord>(key, "json");
  const state = starterState(e.issue, cfg, e.action);

  if (!record) {
    // A new post needs a reason: a starter label was just added, or the issue
    // became free again (unassigned, reopened or unblocked). "opened" is
    // skipped on purpose, because GitHub also
    // sends "labeled" for every label an issue is created with.
    const starterLabelAdded =
      e.action === "labeled" && cfg.starterLabels.includes((e.label?.name ?? "").toLowerCase());
    const freedUp =
      e.action === "unassigned" ||
      e.action === "reopened" ||
      (e.action === "unlabeled" && (e.label?.name ?? "").toLowerCase() === "blocked");
    if (!starterLabelAdded && !freedUp) return "ignored issue";
    // Only announce issues that are free to take right now.
    if (state.kind !== "open" || !isStarterIssue(labels, cfg)) return "ignored issue";
    const message = starterIssueMessage(issue, state);
    const snapshot = starterIssueSnapshot(message);
    const messageId = await sendMessage(env, env.CHANNEL_STARTER_ISSUES, message);
    await env.STATE.put(key, JSON.stringify({ messageId, state: state.kind, message: snapshot } satisfies FeedRecord));
    return "posted starter issue";
  }

  const message = starterIssueMessage(issue, state);
  const snapshot = starterIssueSnapshot(message);
  if (record.message === snapshot) return "unchanged starter issue";

  await editMessage(env, env.CHANNEL_STARTER_ISSUES, record.messageId, message);
  await env.STATE.put(key, JSON.stringify({ messageId: record.messageId, state: state.kind, message: snapshot } satisfies FeedRecord));
  return `updated starter issue (${state.kind})`;
}

async function onPullRequest(e: PullRequestEvent, env: Env, cfg: Config): Promise<string> {
  const pr = e.pull_request;
  if (e.action !== "closed" || !pr.merged || !ours(cfg, e.repository)) return "ignored pull request";
  if (pr.user.type === "Bot" || cfg.excludedUsers.has(pr.user.login.toLowerCase())) return "ignored pull request author";

  let countInWindow: Parameters<typeof mergedPrMessage>[1];
  const mergedAt = pr.merged_at ? new Date(pr.merged_at) : new Date();
  // The program this PR counts for, if any.
  const program = cfg.programs.find(
    (p) =>
      p.repos.includes(e.repository.name) &&
      pr.labels.some((l) => l.name === p.label) &&
      mergedAt >= p.start &&
      mergedAt <= p.end
  );
  if (program) {
    await invalidateLeaderboard(env, program);
    try {
      // GitHub's search index can lag a few seconds behind the merge, so count
      // the author's other PRs and add this one.
      const login = pr.user.login.toLowerCase();
      const others = (await searchMergedPrs(env, cfg, program)).filter(
        (p) => p.login.toLowerCase() === login && p.url !== pr.html_url
      );
      const count = others.length + 1;
      countInWindow = {
        count,
        label: program.title,
        // Said once, on the merge that takes them to the minimum.
        qualified: count === program.minPrs ? { topN: program.topN, reward: program.reward, note: program.note } : undefined,
      };
    } catch {
      // The shoutout matters more than the count; post it without one.
    }
  }

  // If the author linked their GitHub account, show who they are here and
  // hand out any role this merge earned. The shoutout goes out either way.
  const link = await getLinkByGithub(env, pr.user.login);
  let newRoles: string[] = [];
  if (link) {
    try {
      const earlier = await countMergedPrs(env, cfg, pr.user.login, pr.html_url);
      newRoles = await grantEarnedRoles(env, cfg, link, earlier + 1);
    } catch (err) {
      console.error("granting roles failed", err);
    }
  }

  await sendMessage(
    env,
    env.CHANNEL_MERGED_PRS,
    mergedPrMessage(
      {
        repo: e.repository.name,
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        login: pr.user.login,
        discordId: link?.discordId,
        newRoles,
      },
      countInWindow
    )
  );
  return "posted merged pull request";
}
