# Contributing

Thanks for wanting to help with the bot.

## Before you start

- Check the open issues. If you want to work on one, comment on it and wait until it's assigned to you. One issue at a time, please. After 3 merged PRs with us you can hold two.
- For something that isn't an issue yet, open one first so we can agree on it.

## Hacktoberfest and the October program

This repo takes part in Hacktoberfest. A PR counts once it's merged and labeled `hacktoberfest-accepted`.

Those PRs also count for [CODERCOPS October 2026](https://oss.codercops.com/leaderboard/2026-10), together with the ones in chatcops, ogcops and toolbelt. That program and its goodies are CODERCOPS's own and separate from Hacktoberfest. The page has the rules.

## Ground rules

### AI tools

You can use AI tools (Copilot, ChatGPT, Claude, Cursor and so on). Two conditions:

1. Say so in the PR. If a tool wrote or rewrote more than autocomplete-sized pieces, fill in the "AI assistance" line in the PR template: which tool, and what you used it for.
2. You own every line. Run it, test it, and be ready to explain it in review. If you can't explain a change, the PR gets closed.

PRs that are unreviewed AI output (code that doesn't run, invented APIs, a description that doesn't match the diff, unrelated rewrites) are treated as spam.

### Spam

These get closed and labeled `spam`:

- a PR for an issue that isn't assigned to you, or that isn't linked to an issue at all
- formatting, whitespace or typo-only changes nobody asked for
- one fix split into several PRs
- a copy of someone else's PR
- claiming a pile of issues at once, or bulk and automated submissions
- untested generated code

Two spam PRs and you won't be assigned more issues this month, and you're out of the CODERCOPS goodies.

### Reviews

Every PR needs a "How I tested this" line: what you ran to check it works.

For a bug fix, check that your new test fails without the fix: undo the change in the source, run the tests, then put it back. A test that passes either way doesn't catch anything.

I review most PRs within a few days. Please don't ping repeatedly or DM maintainers about a review. If three days pass with no reply, one follow-up comment on the PR is fine.

## Making a change

```bash
git checkout -b fix/my-change
npm install
npm run typecheck && npm test
```

- Keep logic out of the request handlers. Message text lives in `src/messages.ts` and has no I/O, which is why it's easy to test. New behavior needs a test in `test/`.
- The bot doesn't ping people and never posts anything that isn't public on GitHub already. The one exception is the welcome post, which notifies the new member it's for. Please keep it that way.
- Never commit tokens or secrets. Local secrets go in `.dev.vars`, which is gitignored.
- Use conventional commit titles (`feat:`, `fix:`, `docs:`, `chore:`), branch off `develop`, and open the pull request against `develop` here in codercops/discord-bot with `Closes #<issue number>`. A PR merged inside your own fork never reaches us, so it doesn't count.

CI runs the typecheck and the tests on every pull request. A second check ("Claim check") fails if the linked issue isn't assigned to you. A third ("Description check") fails while the "How I tested this" or "AI assistance" section of the PR description is missing or empty.

You can't run the bot against our Discord server, and you don't need to. The tests replace Discord, GitHub and KV with fakes. For the leaderboard page, `npm run dev` serves it at `http://localhost:8787/leaderboard` with no secrets.

## Branching and releases

The bot follows the same flow as toolbelt:

- `develop` is the default branch. Branch off it and open your PR against it. PRs are squash merged.
- `production` is what's running. Nothing is committed to it directly.
- A release is a PR from `develop` into `production`, merged as a merge commit so `production` keeps the history. It bumps the version in `package.json` and gets a `release:minor` or `release:major` label when it's more than a patch.
- When `production` changes, Cloudflare Workers Builds deploys the bot. The Release workflow then tags `vX.Y.Z` and publishes a GitHub release, which the bot posts in `#releases`. It waits until the live bot reports the new commit, checks that the Discord and GitHub endpoints still refuse unsigned requests, and syncs `develop` back up to `production`.

There's no develop deployment. A second copy of the bot would answer in the same Discord server and run the daily and welcome jobs twice. So a merge into `develop` changes nothing on Discord until the next release.
