// The slash command definitions sent to Discord. Kept in a module so the
// register script and the tests read the same list: a command or description
// can only be written here, not in two places.

export interface SlashCommandChoice {
  name: string;
  value: string;
}

export interface SlashCommandOption {
  type: number;
  name: string;
  description: string;
  required?: boolean;
  choices?: SlashCommandChoice[];
  max_length?: number;
  min_value?: number;
  max_value?: number;
}

export interface SlashCommand {
  name: string;
  description: string;
  contexts?: number[];
  default_member_permissions?: string;
  options?: SlashCommandOption[];
}

/** The wrangler.jsonc vars the command list is built from. */
export interface SlashCommandVars {
  REPOS: string;
  STARTER_LABELS: string;
  ROADMAPS: { id: string; name: string; days: number }[];
  PROGRAMS: { id: string; title: string }[];
  LINKING: string;
}

export interface SlashCommandOptions {
  /** Register the link commands for server admins only, to try them out first. */
  preview?: boolean;
}

/**
 * Builds the commands registered with Discord.
 *
 * `LINK_PREVIEW=1` on the register script sets `preview`, which hides the link
 * commands from everyone but server admins until they are switched on for
 * everybody.
 */
export function slashCommands(vars: SlashCommandVars, options: SlashCommandOptions = {}): SlashCommand[] {
  const repos = vars.REPOS.split(",").map((r) => r.trim());
  const starterLabels = vars.STARTER_LABELS.split(",").map((l) => l.trim()).filter(Boolean);
  const longestRoadmap = Math.max(...vars.ROADMAPS.map((r) => r.days));

  const commands: SlashCommand[] = [
    { name: "help", description: "Show the commands and what they do" },
    {
      name: "issues",
      description: "List open starter issues nobody has claimed yet",
      options: [
        {
          type: 3,
          name: "repo",
          description: "Only show one repo",
          required: false,
          choices: repos.map((r) => ({ name: r, value: r })),
        },
        {
          type: 3,
          name: "label",
          description: "Only show one label",
          required: false,
          choices: starterLabels.map((l) => ({ name: l, value: l })),
        },
      ],
    },
    {
      name: "leaderboard",
      description: "Show who has the most merged PRs in a contributor program",
      options: [
        {
          type: 3,
          name: "program",
          description: "Which program (default: the current one)",
          required: false,
          choices: vars.PROGRAMS.map((p) => ({ name: p.title, value: p.id })),
        },
      ],
    },
    {
      name: "checkin",
      description: "Log today on a learning roadmap and keep your streak alive",
      // 0 = guild only: a check-in posts into a forum in the server.
      contexts: [0],
      options: [
        {
          type: 3,
          name: "roadmap",
          description: "Which roadmap you are following",
          required: true,
          choices: vars.ROADMAPS.map((r) => ({ name: r.name, value: r.id })),
        },
        { type: 3, name: "note", description: "What you did today", required: false, max_length: 500 },
        {
          type: 4, // INTEGER
          name: "day",
          description: "Only if you are not continuing from your last day number",
          required: false,
          min_value: 1,
          max_value: longestRoadmap,
        },
      ],
    },
    {
      name: "streaks",
      description: "Show the learning streaks for every roadmap",
      options: [
        {
          name: "roadmap",
          description: "Only show this roadmap",
          type: 3,
          required: false,
          choices: vars.ROADMAPS.map((r) => ({ name: r.name, value: r.id })),
        },
      ],
    },
  ];

  // These only make sense once linking is switched on in wrangler.jsonc.
  if (vars.LINKING === "on") {
    const permissions = options.preview ? { default_member_permissions: "0" } : {};
    commands.push(
      { name: "link", description: "Link your GitHub account to your Discord account", contexts: [0], ...permissions },
      { name: "unlink", description: "Remove the link between your GitHub and Discord accounts", contexts: [0], ...permissions },
      { name: "me", description: "Show your merged PRs and where you stand", contexts: [0], ...permissions }
    );
  }

  return commands;
}
