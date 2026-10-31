# CODERCOPS Discord bot

The bot behind the open source channels on the [CODERCOPS Discord server](https://discord.gg/mpGdJyjaRQ). It watches our public repos ([chatcops](https://github.com/codercops/chatcops), [ogcops](https://github.com/codercops/ogcops), [toolbelt](https://github.com/codercops/toolbelt) and this one) and keeps contributors in the loop:

- **Releases** go to `#releases` with their notes.
- **Starter issues** (`good first issue` and `help wanted`) go to `#starter-issues`. Each issue gets one message, and the bot edits it when the issue is claimed, freed up, closed, or stops being a starter issue (the label is removed, `blocked` is added, or it's deleted or transferred), so the channel always shows what's really available.
- **Merged PRs** get a shoutout in `#merged-prs`, with the author's count in the running program. The merge that takes someone to the program's minimum says they now qualify.
- **`/help`** lists every command with a line saying what it does, and points at this repo for bug reports and ideas.
- **`/issues`** lists the open starter issues nobody has claimed yet, for one repo or one label if you pick them. **`/leaderboard`** shows who has the most merged PRs in a contributor program.
- A **weekly leaderboard** is posted while a program is running, and the final results once it ends.
- Every program has a public page, for example [CODERCOPS October 2026](https://oss.codercops.com/leaderboard/2026-10), with a JSON version next to it.
- Every contributor on a leaderboard has a **share card**: a page with their count and rank, and the same thing as an image that shows up when the link is posted on LinkedIn, X or Discord.
- **New members get a welcome post** in `#introductions` that points them to the things they can do.
- **`/link`** connects a member's GitHub account to their Discord account. Linked members appear by name next to their merged PRs, get the Contributor role with their first merged PR, and can run **`/me`** to see where they stand.
- **`/checkin`** logs a day on one of our learning roadmaps. The bot opens a log thread for each learner, adds every day to it and keeps their streak. **`/streaks`** shows who's on a roll, and the weekly post includes the streak board.

It runs on Cloudflare Workers. There is no server to keep alive and no Discord gateway connection: Discord and GitHub both call the Worker over HTTPS.

## How it works

| Path | Called by | What happens |
| --- | --- | --- |
| `POST /interactions` | Discord, when someone runs a slash command | The Ed25519 signature is checked, the command is acknowledged right away, and the reply is filled in once GitHub has answered. |
| `POST /github` | GitHub webhooks (`release`, `issues`, `pull_request`) | The HMAC signature is checked, then the event becomes a new or edited Discord message. |
| `GET /leaderboard/{id}`, `GET /leaderboard/{id}.json` | Anyone | One program's ranking as a page or as JSON. `/leaderboard` shows the current program. No scripts, no cookies, cached for five minutes. |
| `GET /leaderboard/{id}/u/{login}`, and the same with `.png` | Anyone | One contributor's page in a program, and their share card as a 1200x630 image. |
| `GET /funding.json`, `GET /.well-known/funding-manifest-urls` | Anyone | Our [funding.json](https://fundingjson.org) manifest, which funders like FLOSS/fund read, and the file that proves we publish it. The manifest lives in `src/funding.ts`. |
| `GET /link/callback` | Discord, after a member approves `/link` | Reads the member's verified GitHub connection, stores the link and hands out any role they've earned. |
| cron | Cloudflare, every minute | Looks for members who just joined and welcomes them. |
| cron | Cloudflare, every day at 04:30 UTC | On Mondays, posts the leaderboard of each running program and the learning streaks. On any day, posts the final results of a program that has just ended. |

A small KV namespace remembers which Discord message belongs to which issue, caches the leaderboards for a few minutes, and stores each learner's check-in progress and each member's GitHub link.

The code is split so the logic is easy to test:

- `src/verify.ts` checks request signatures.
- `src/webhook.ts` decides what each GitHub event means.
- `src/messages.ts` builds every Discord message. It has no I/O.
- `src/leaderboard.ts` ranks contributors.
- `src/programs.ts` picks the program to show and says whether it's upcoming, running or over.
- `src/page.ts` builds the public pages and the JSON. It has no I/O either.
- `src/card.ts` lays out the share card as an SVG. `src/card-image.ts` turns it into a PNG with [resvg](https://github.com/yisibl/resvg-js) and the two fonts in `assets/fonts`; it's the only file that needs the Workers bundler, so the tests replace it.
- `src/checkin.ts` holds the check-in rules and the streak ranking.
- `src/welcome.ts` finds new members and greets them.
- `src/oauth.ts`, `src/linking.ts`, `src/links.ts` and `src/roles.ts` are the GitHub link: the Discord OAuth2 calls, the callback, the stored link, and the roles that come with it.
- `src/github.ts` and `src/discord.ts` are thin API clients.

## Contributor programs

A program is a stretch of time in which merged pull requests are counted and the top contributors get something for it. CODERCOPS October 2026 was the first one. From November 2026 there's one a month, counting PRs labeled `codercops-accepted`, which the `accepted-label` workflow in each repo adds at merge time. Each program is one entry in `PROGRAMS` in `wrangler.jsonc`:

```jsonc
{
  "id": "2026-10",                      // the page lives at /leaderboard/2026-10
  "title": "CODERCOPS October 2026",
  "kind": "merged-prs",
  "label": "hacktoberfest-accepted",    // a merged PR counts only with this label
  "start": "2026-10-01T00:00:00Z",
  "end": "2026-10-31T23:59:59Z",
  "minPrs": 5,
  "topN": 5,
  "reward": "a CODERCOPS T-shirt and stickers",
  "note": "This swag comes from CODERCOPS's own open source program. It is separate from Hacktoberfest and its rewards."
}
```

To run another one, add an entry with a new `id`. Nothing else changes: the old program keeps its page and its results, the new one gets its own page, its own weekly posts and its own final results. `repos` is optional and defaults to every repo in `REPOS`. Programs can overlap.

How a program is scored:

- A pull request counts when it was merged inside the window (UTC), in one of the program's repos, and carries the program's label. Maintainers listed in `EXCLUDED_USERS` don't appear.
- People are ranked by how many PRs they got merged. A tie goes to whoever reached that count first.
- Only contributors with at least `minPrs` merged PRs can be among the `topN` winners, so there can be fewer winners than that.
- `note` is shown under every leaderboard post and on the page. Ours says that the reward is CODERCOPS's own and separate from Hacktoberfest and whatever Hacktoberfest gives its participants.

`kind` is there because not every program will be about merged PRs. `merged-prs` is the only kind the bot can count today, and entries of any other kind are skipped.

## Check-in rules

The roadmaps are listed in `ROADMAPS` in `wrangler.jsonc`, each with its length, its forum channel and the forum tag for new log threads.

- One check-in per day and roadmap counts. The day ends at midnight in the community's time zone (`CHECKIN_UTC_OFFSET_MINUTES`, 330 for IST).
- The day number continues from the last one. A learner can pass a higher `day` if they started before joining or skipped ahead, but can't go backwards.
- A streak continues only if the last check-in was the day before. Miss a day and it starts again at 1; the day number and the best streak are kept.
- Each learner gets one thread per roadmap. If it was deleted, the next check-in opens a new one.

## Share cards

`/leaderboard/2026-10/u/<github login>` is that person's page in the program. The page shows the card, buttons to post it on LinkedIn and X, a download link, and where they stand. The card itself is `…/u/<login>.png`.

The image address on the page carries the current numbers (`?v=4-1-15-running`), so a share preview picks up a new image when someone's count or rank changes. Cards are cached for ten minutes. A person without a counted pull request has no card, and the page says so.

`npm run dev` renders real cards locally, which is the way to look at a design change: open `http://localhost:8787/leaderboard/2026-10/u/<login>.png`.

## Where it lives

`PUBLIC_URL` is the address of the public pages, ours being `https://oss.codercops.com` (a custom domain in `routes`). Discord and GitHub keep calling the Worker's workers.dev address, and page links on that address redirect to the public one. `OAUTH_REDIRECT_URL` keeps the `/link` callback on whichever address is registered in the Discord developer portal.

## Welcome posts

Discord announces joins only over the gateway, and this bot has no gateway connection. So a cron reads the member list every minute and greets anyone who joined in the last two hours and hasn't been greeted. Bots are skipped, and so are people who haven't accepted the rules screening yet.

The welcome is the one message where the bot notifies someone: the new member, once. Everything else it posts shows names without pinging.

It needs the Server Members intent (Developer Portal > Bot), `DISCORD_GUILD_ID` and `CHANNEL_WELCOME`. Leave `CHANNEL_WELCOME` empty to switch it off.

## Linking a GitHub account

`/link` answers privately with a button. It opens Discord's consent screen, which asks the member to share their username and their connected accounts (the `identify` and `connections` scopes). After they approve, the bot reads the GitHub account connected to their Discord profile. Discord has already verified that connection, so there is no separate GitHub login and nobody can claim an account that isn't theirs. Members without a GitHub connection are told to add one under User Settings > Connections.

What the bot keeps: the member's Discord id, their GitHub username and GitHub's numeric id for it, and the time of linking. The OAuth token is revoked as soon as those two reads are done. `/unlink` deletes the entry and takes back the roles below.

What linking does:

- Merged PR shoutouts and leaderboard posts show the Discord member next to the GitHub login. The public leaderboard page shows GitHub logins only.
- `ROLE_TIERS` in `wrangler.jsonc` lists roles by merged PR count in `REPOS` (at any time, not per program). Ours are Contributor at 1 and Top Contributor at 5. A role is given when the PR that earns it is merged, and at linking time for PRs that were merged before. Maintainers in `EXCLUDED_USERS` can link too, but don't get these roles.
- `/me` shows the member's merged PRs, their place in the current program and how many more they need to qualify.

To switch it on:

1. In the Developer Portal, under OAuth2, add `{PUBLIC_URL}/link/callback` to the redirects.
2. `npx wrangler secret put DISCORD_CLIENT_SECRET` with the client secret from the same page.
3. Set `LINKING` to `"on"` in `wrangler.jsonc`, deploy, and run `npm run register` so `/link`, `/unlink` and `/me` appear. With `LINK_PREVIEW=1` in front, only server admins see them, which is handy for a first try.
4. Give the bot Manage Roles and keep its own role above the tier roles.

## Development

You need Node 24 (see `.nvmrc`).

```bash
npm install
npm run typecheck
npm test
```

The tests don't need Discord, GitHub or Cloudflare. They replace `fetch` and KV with small fakes from `test/helpers.ts`.

`npm run dev` runs the Worker locally. The leaderboard pages work right away at `http://localhost:8787/leaderboard`. For the Discord and GitHub endpoints, put your own secrets in `.dev.vars` (it's gitignored):

```
DISCORD_BOT_TOKEN=...
GITHUB_WEBHOOK_SECRET=...
```

## Releases

Our copy runs from the `production` branch. Cloudflare Workers Builds deploys it whenever `production` changes, with `npm run deploy:production`, which hands the Worker the commit it built. The root of the workers.dev address shows that commit as `commit` (`"dev"` for any other deploy). Changes land on `develop` first and reach `production` in a release PR. [CONTRIBUTING.md](./CONTRIBUTING.md#branching-and-releases) has the details.

## Running your own copy

1. Create a Discord application with a bot user and add it to your server with the `bot` and `applications.commands` scopes. It needs View Channels, Send Messages, Embed Links and Read Message History in the channels it posts to. The welcome posts and the roles are optional and need more: see the two sections above.
2. Create a KV namespace with `npx wrangler kv namespace create STATE` and put its id in `wrangler.jsonc`.
3. Fill in the `vars` in `wrangler.jsonc`: your application id and public key, the channel ids, your org and repos.
4. Set the secrets:
   ```bash
   npx wrangler secret put DISCORD_BOT_TOKEN
   npx wrangler secret put GITHUB_WEBHOOK_SECRET
   npx wrangler secret put GITHUB_TOKEN   # optional, raises GitHub's rate limit
   ```
   `GITHUB_TOKEN` only reads public data, so a fine-grained token with "Public repositories" access and no permissions is enough. If your organization limits how long tokens may live, give it an expiry inside that limit. When GitHub refuses the token (expired, or blocked by the organization), the bot asks again without it.
5. `npm run deploy`, then set the Worker's `/interactions` URL as the Interactions Endpoint URL of your Discord application.
6. Register the slash commands: `DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... npm run register`.
7. Add a webhook to each repo that points at the Worker's `/github` URL, with content type `application/json`, your webhook secret, and the `Releases`, `Issues` and `Pull requests` events.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Maintainers and funding

The bot is maintained by CODERCOPS together with contributors who have Triage access. [GOVERNANCE.md](https://github.com/codercops/.github/blob/main/GOVERNANCE.md) lists who they are and how to become one. The project is free and MIT licensed, and CODERCOPS doesn't sell it or a hosted version of it. If it's useful to you, you can [sponsor the maintainers](https://github.com/sponsors/anurag629). The money pays for review time and hosting.

## License

MIT, see [LICENSE](./LICENSE).

Built by [CODERCOPS](https://www.codercops.com), the chat-first hiring platform for developers.
