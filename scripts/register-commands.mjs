// Registers the slash commands with Discord. Run after changing
// src/commands.ts: `npm run register`.
//
// Needs DISCORD_BOT_TOKEN in the environment and the guild (server) id as
// DISCORD_GUILD_ID. Guild commands show up immediately; global ones can take
// an hour, so this registers per guild.
import { readFileSync } from 'node:fs';
import { slashCommands } from './commands.ts';
import { parseJsonc } from './jsonc.ts';

const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;
if (!token || !guildId) {
  console.error('Set DISCORD_BOT_TOKEN and DISCORD_GUILD_ID first.');
  process.exit(1);
}

const config = parseJsonc(readFileSync('wrangler.jsonc', 'utf8'));
const { DISCORD_APPLICATION_ID: appId } = config.vars;

// LINK_PREVIEW=1 registers the link commands for server admins only, to try
// the flow out before everyone sees the commands. Run again without it to
// open them up.
const commands = slashCommands(config.vars, { preview: process.env.LINK_PREVIEW === '1' });

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
