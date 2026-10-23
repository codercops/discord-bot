// Slash command handlers. The command names and options are registered with
// Discord by scripts/register-commands.mjs; keep the two in sync.
import { listCheckins, localDate, rankStreaks, recordCheckin } from "./checkin";
import type { Config, Env } from "./config";
import type { MessagePayload } from "./discord";
import { countMergedPrs, GithubError, listStarterIssues } from "./github";
import { getLeaderboard } from "./leaderboard";
import { getLink, linkedMembers, removeLink } from "./links";
import { checkinReply, helpReply, leaderboardMessage, linkPrompt, meReply, starterIssuesReply, streaksMessage } from "./messages";
import { authorizeUrl, linkingEnabled, signState } from "./oauth";
import { grantEarnedRoles, isMaintainer, removeTierRoles } from "./roles";
import { currentProgram, findProgram, leaderboardUrl, programStatus } from "./programs";

export interface CommandData {
  name: string;
  options?: { name: string; value?: string | number | boolean }[];
}

/** Who ran the command. */
export interface CommandUser {
  id: string;
  name: string;
}

const IN_SERVER_ONLY: MessagePayload = { content: "Run this inside the server, not in a DM." };

export async function runCommand(
  data: CommandData,
  user: CommandUser | null,
  env: Env,
  cfg: Config,
  now: Date = new Date()
): Promise<MessagePayload> {
  const option = (name: string) => data.options?.find((o) => o.name === name)?.value;
  try {
    switch (data.name) {
      case "help": {
        return helpReply(linkingEnabled(env));
      }
      case "checkin": {
        if (!user) return { content: "Run this inside the server, not in a DM." };
        const day = option("day");
        const note = option("note");
        const outcome = await recordCheckin(env, cfg, {
          userId: user.id,
          name: user.name,
          roadmapId: String(option("roadmap") ?? ""),
          day: typeof day === "number" ? day : undefined,
          note: typeof note === "string" ? note : undefined,
          now,
        });
        if (!outcome) return { content: "I don't know that roadmap. Pick one from the list." };
        return checkinReply(outcome.result, outcome.roadmap, outcome.threadId);
      }
      case "streaks": {
        const today = localDate(now, cfg.checkinUtcOffsetMinutes);
        const pickedRoadmap = option("roadmap");
        if (pickedRoadmap !== undefined) {
          const roadmap = cfg.roadmaps.find((r) => r.id === String(pickedRoadmap));
          if (!roadmap) return { content: "I don't know that roadmap. Pick one from the list." };
          return streaksMessage(cfg, rankStreaks(await listCheckins(env), today), {
            roadmap: roadmap.name,
          });
        }
        return streaksMessage(cfg, rankStreaks(await listCheckins(env), today));
      }
      case "issues": {
        const picked = data.options?.find((o) => o.name === "repo")?.value;
        const repos = typeof picked === "string" && cfg.repos.includes(picked) ? [picked] : cfg.repos;
        // Anything that isn't a starter label is ignored, so everything is listed.
        const pickedLabel = data.options?.find((o) => o.name === "label")?.value;
        const label = typeof pickedLabel === "string" ? pickedLabel.toLowerCase() : "";
        const labels = cfg.starterLabels.includes(label) ? [label] : cfg.starterLabels;
        const issuesByRepo = await Promise.all(
          repos.map(async (repo) => ({ repo, issues: await listStarterIssues(env, cfg, repo, labels) }))
        );
        return starterIssuesReply(cfg, issuesByRepo, labels);
      }
      case "leaderboard": {
        const program = findProgram(cfg, option("program")) ?? currentProgram(cfg, now);
        if (!program) return { content: "There's no contributor program right now." };
        const board = await getLeaderboard(env, cfg, program);
        return leaderboardMessage(board, program, {
          final: programStatus(program, now) === "ended",
          url: leaderboardUrl(cfg, program),
          finalNote: cfg.finalResultsNote,
          members: await linkedMembers(env, board.rows.slice(0, 10).map((r) => r.login)),
          linking: linkingEnabled(env),
        });
      }
      case "link": {
        if (!user) return IN_SERVER_ONLY;
        if (!linkingEnabled(env)) return { content: "Linking isn't switched on yet. Check back soon." };
        const existing = await getLink(env, user.id);
        const state = await signState(env.DISCORD_CLIENT_SECRET ?? "", user.id, now);
        return linkPrompt(authorizeUrl(env, cfg, state), existing?.githubLogin);
      }
      case "unlink": {
        if (!user) return IN_SERVER_ONLY;
        const removed = await removeLink(env, user.id);
        if (!removed) return { content: "You have no linked GitHub account, so there's nothing to remove." };
        // The link is gone either way; a role that couldn't be removed isn't worth an error.
        await removeTierRoles(env, cfg, user.id).catch((err) => console.error("removing roles failed", err));
        return {
          content: `Unlinked from **${removed.githubLogin}**. I deleted what I had stored and took back the contributor roles. Run \`/link\` if you change your mind.`,
        };
      }
      case "me": {
        if (!user) return IN_SERVER_ONLY;
        const link = await getLink(env, user.id);
        if (!link) return { content: "You haven't linked a GitHub account yet. Run `/link` first." };
        const merged = await countMergedPrs(env, cfg, link.githubLogin);
        // Catches up on a role if a merge was missed.
        const newRoles = await grantEarnedRoles(env, cfg, link, merged).catch((err) => {
          console.error("granting roles failed", err);
          return [] as string[];
        });
        const program = currentProgram(cfg, now);
        // Maintainers aren't ranked, so there's no standing to show them.
        if (!program || isMaintainer(cfg, link.githubLogin)) {
          return meReply({ login: link.githubLogin, merged, newRoles, maintainer: isMaintainer(cfg, link.githubLogin) });
        }
        const board = await getLeaderboard(env, cfg, program);
        const index = board.rows.findIndex((r) => r.login.toLowerCase() === link.githubLogin.toLowerCase());
        return meReply({
          login: link.githubLogin,
          merged,
          newRoles,
          standing: {
            program,
            status: programStatus(program, now),
            url: leaderboardUrl(cfg, program),
            rank: index >= 0 ? index + 1 : undefined,
            row: board.rows[index],
            of: board.rows.length,
          },
        });
      }
      default:
        return { content: "I don't know that command." };
    }
  } catch (err) {
    if (err instanceof GithubError && (err.status === 403 || err.status === 429)) {
      return { content: "GitHub is rate limiting me right now. Try again in a minute." };
    }
    console.error("command failed", data.name, err);
    return { content: "Something went wrong on my side. Try again in a bit." };
  }
}
