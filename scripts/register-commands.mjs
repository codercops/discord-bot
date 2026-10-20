// Registers the slash commands with Discord. Run after changing
// src/commands.ts: `npm run register`.
//
// Needs DISCORD_BOT_TOKEN in the environment and the guild (server) id as
// DISCORD_GUILD_ID. Guild commands show up immediately; global ones can take
// an hour, so this registers per guild.
import { readFileSync } from 'node:fs';
import { parseJsonc } from './jsonc.ts';

const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;
if (!token || !guildId) {
  console.error('Set DISCORD_BOT_TOKEN and DISCORD_GUILD_ID first.');
  process.exit(1);
}

const config = parseJsonc(readFileSync('wrangler.jsonc', 'utf8'));
const { DISCORD_APPLICATION_ID: appId, REPOS, STARTER_LABELS, ROADMAPS, PROGRAMS, LINKING } = config.vars;
const repos = REPOS.split(',').map((r) => r.trim());
const starterLabels = STARTER_LABELS.split(',').map((l) => l.trim()).filter(Boolean);
const longestRoadmap = Math.max(...ROADMAPS.map((r) => r.days));

const commands = [
  { name: 'help', description: 'Show the commands and what they do' },
  {
    name: 'issues',
    description: 'List open starter issues nobody has claimed yet',
    options: [
      {
        type: 3,
        name: 'repo',
        description: 'Only show one repo',
        required: false,
        choices: repos.map((r) => ({ name: r, value: r })),
      },
      {
        type: 3,
        name: 'label',
        description: 'Only show one label',
        required: false,
        choices: starterLabels.map((l) => ({ name: l, value: l })),
      },
    ],
  },
  {
    name: 'leaderboard',
    description: 'Show who has the most merged PRs in a contributor program',
    options: [
      {
        type: 3,
        name: 'program',
        description: 'Which program (default: the current one)',
        required: false,
        choices: PROGRAMS.map((p) => ({ name: p.title, value: p.id })),
      },
    ],
  },
  {
    name: 'checkin',
    description: 'Log today on a learning roadmap and keep your streak alive',
    // 0 = guild only: a check-in posts into a forum in the server.
    contexts: [0],
    options: [
      {
        type: 3,
        name: 'roadmap',
        description: 'Which roadmap you are following',
        required: true,
        choices: ROADMAPS.map((r) => ({ name: r.name, value: r.id })),
      },
      { type: 3, name: 'note', description: 'What you did today', required: false, max_length: 500 },
      {
        type: 4, // INTEGER
        name: 'day',
        description: 'Only if you are not continuing from your last day number',
        required: false,
        min_value: 1,
        max_value: longestRoadmap,
      },
    ],
  },
  {
    name: 'streaks',
    description: 'Show the learning streaks for every roadmap',
    options: [
      {
        name: 'roadmap',
        description: 'Only show this roadmap',
        type: 3,
        required: false,
        choices: ROADMAPS.map((r) => ({ name: r.name, value: r.id })),
      },
    ],
  },
];

// These only make sense once linking is switched on in wrangler.jsonc.
// LINK_PREVIEW=1 registers them for server admins only, to try the flow out
// before everyone sees the commands. Run again without it to open them up.
if (LINKING === 'on') {
  const preview = process.env.LINK_PREVIEW === '1' ? { default_member_permissions: '0' } : {};
  commands.push(
    { name: 'link', description: 'Link your GitHub account to your Discord account', contexts: [0], ...preview },
    { name: 'unlink', description: 'Remove the link between your GitHub and Discord accounts', contexts: [0], ...preview },
    { name: 'me', description: 'Show your merged PRs and where you stand', contexts: [0], ...preview }
  );
}

const res = await fetch(`https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`, {
  method: 'PUT',
  headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(commands),
});
if (!res.ok) {
  console.error(`Discord ${res.status}: ${await res.text()}`);
  process.exit(1);
}
console.log(`Registered ${(await res.json()).length} commands in guild ${guildId}.`);
