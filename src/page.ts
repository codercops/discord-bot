// The public leaderboard page of a program. Pure functions that build HTML and
// JSON from the same ranking the Discord posts use.
import type { Program } from "./config";
import type { Leaderboard, LeaderboardRow } from "./leaderboard";
import { BOARD_ROWS } from "./card";
import { programStatus, type ProgramStatus } from "./programs";

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

const day = (d: Date, year = false) =>
  d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: year ? "numeric" : undefined, timeZone: "UTC" });

/** "Oct 1 to Oct 31, 2026 (UTC)". The first date gets its year only when it differs. */
export function dateRange(start: Date, end: Date): string {
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
  return `${day(start, !sameYear)} to ${day(end, true)} (UTC)`;
}

/** The line under the heading that says whether the program is still on. */
export function statusLine(program: Program, now: Date): { text: string; status: ProgramStatus } {
  const status = programStatus(program, now);
  if (status === "upcoming") return { text: `Starts ${day(program.start, true)}`, status };
  if (status === "ended") return { text: "Ended. These are the final results.", status };
  const days = Math.ceil((program.end.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
  return { text: `Running now. ${days} ${days === 1 ? "day" : "days"} left.`, status };
}

export type Chip = { text: string; kind: "top" | "qualifies" | "progress" };

/** What a row's chip says: where the person stands for the reward. Nothing once it's over and they didn't qualify. */
export function standing(row: LeaderboardRow, program: Program, status: ProgramStatus = "running"): Chip | null {
  const { minPrs, topN } = program;
  const ended = status === "ended";
  if (row.winner) return { text: ended ? "Winner" : `In the top ${topN}`, kind: "top" };
  if (row.qualifies) return { text: ended ? "Qualified" : "Qualifies", kind: "qualifies" };
  if (ended) return null;
  return { text: `${minPrs - row.count} more to qualify`, kind: "progress" };
}

export function leaderboardJson(board: Leaderboard, program: Program, now: Date) {
  const { id, title, label, repos, start, end, minPrs, topN, reward, note } = program;
  return {
    id,
    title: `${title} leaderboard`,
    status: programStatus(program, now),
    generatedAt: board.generatedAt,
    rules: { repos, label, start: start.toISOString(), end: end.toISOString(), minPrs, topN, reward, note },
    rows: board.rows.map((row, i) => ({
      rank: i + 1,
      login: row.login,
      mergedPrs: row.count,
      qualifies: row.qualifies,
      inTop: row.winner,
      prs: row.prs.map(({ repo, number, title, url, mergedAt }) => ({ repo, number, title, url, mergedAt })),
    })),
  };
}

export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <circle cx="16" cy="3" r="2" fill="#00e5c7" stroke="#0a0b0f" stroke-width="1.2"/>
  <line x1="16" y1="5" x2="16" y2="8" stroke="#0a0b0f" stroke-width="1.2"/>
  <rect x="1.5" y="14" width="3.5" height="7" rx="1.75" fill="#00e5c7" stroke="#0a0b0f" stroke-width="1.2"/>
  <rect x="27" y="14" width="3.5" height="7" rx="1.75" fill="#00e5c7" stroke="#0a0b0f" stroke-width="1.2"/>
  <rect x="5" y="8" width="22" height="20" rx="8" fill="#ffffff" stroke="#0a0b0f" stroke-width="1.5"/>
  <rect x="8" y="12.5" width="16" height="8" rx="4" fill="#0a0b0f"/>
  <ellipse cx="12.5" cy="16.5" rx="1.6" ry="2" fill="#00e5c7"/>
  <ellipse cx="19.5" cy="16.5" rx="1.6" ry="2" fill="#00e5c7"/>
  <path d="M12.5 23.5 Q16 26 19.5 23.5" fill="none" stroke="#0a0b0f" stroke-width="1.4" stroke-linecap="round"/>
</svg>
`;

const STYLE = `
:root{--bg:#0a0b0f;--raise:#12141a;--line:#1e222b;--fg:#e6e9ef;--muted:#8a93a8;--cyan:#00e5c7;--violet:#9e7bff;--gold:#d4a72c}
@media (prefers-color-scheme:light){:root{--bg:#f7f8fa;--raise:#fff;--line:#e3e6ec;--fg:#14161c;--muted:#5d6678;--cyan:#008c78;--violet:#6b46e5;--gold:#946c00}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:48px 16px 64px}
a{color:var(--cyan);text-decoration:none}a:hover{text-decoration:underline}
.eyebrow{font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.22em;text-transform:uppercase;color:var(--cyan);margin:0 0 14px}
h1{font:700 clamp(28px,6vw,40px)/1.15 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0 0 12px}
.lede{color:var(--muted);margin:0 0 32px}
.board{list-style:none;margin:0 0 32px;padding:0;border:1px solid var(--line);border-radius:12px;background:var(--raise);overflow:hidden}
.board>li{border-top:1px solid var(--line)}
.board>li:first-child{border-top:0}
.board summary{display:flex;align-items:center;gap:12px;padding:12px 16px;cursor:pointer;list-style:none}
.board summary::-webkit-details-marker{display:none}
.board summary::before{content:"";width:7px;height:7px;flex:none;border-right:2px solid var(--muted);border-bottom:2px solid var(--muted);transform:rotate(-45deg);transition:transform .15s}
.board details[open]>summary::before{transform:rotate(45deg)}
.board summary:hover{background:var(--bg)}
.prs{list-style:none;margin:0;padding:4px 16px 14px 56px;display:grid;gap:8px}
.prs li{font-size:14px;line-height:1.4}
.prs a{color:var(--fg)}
.prs .repo{font:600 12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);margin-right:8px}
.rank{width:28px;font:600 14px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}
.board img{width:36px;height:36px;border-radius:50%;background:var(--line)}
.who{flex:1;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.who a{color:var(--fg)}
.count{font:600 14px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap}
.chip{font-size:12px;padding:3px 9px;border-radius:999px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
.chip.top{color:var(--gold);border-color:var(--gold)}
.chip.qualifies{color:var(--cyan);border-color:var(--cyan)}
.empty{padding:28px 16px;color:var(--muted);text-align:center}
.rules{border:1px solid var(--line);border-radius:12px;padding:20px;background:var(--raise);margin:0 0 24px}
.rules h2{font:600 13px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);margin:0 0 12px}
.rules p{margin:0 0 10px}.rules p:last-child{margin:0}
.cta{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 36px}
.cta a{padding:10px 16px;border-radius:8px;border:1px solid var(--line);background:var(--raise);color:var(--fg);font-weight:600}
.cta a.primary{background:var(--cyan);border-color:var(--cyan);color:#06120f}
.status{display:inline-block;font:600 13px/1 ui-monospace,SFMono-Regular,Menlo,monospace;padding:7px 11px;border-radius:999px;border:1px solid var(--line);color:var(--muted);margin:0 0 28px}
.status.running{color:var(--cyan);border-color:var(--cyan)}
.status.ended{color:var(--gold);border-color:var(--gold)}
.unlinked{margin:0 0 24px;color:var(--muted);font-size:14px;line-height:1.5}
.lede{margin-bottom:14px}
.others{margin:0 0 36px}
.others h2{font:600 13px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}
.others ul{margin:0;padding-left:18px}
.cardlink{font-size:12px;padding:3px 9px;border-radius:999px;border:1px solid var(--line);color:var(--fg);white-space:nowrap}
.cardlink:hover{border-color:var(--cyan);color:var(--cyan);text-decoration:none}
main.wide{max-width:920px}
.crumb{font-size:14px;margin:0 0 22px}
.sharecard{display:block;margin:0 0 20px;border-radius:18px;overflow:hidden;border:1px solid var(--line);box-shadow:0 24px 70px rgba(0,0,0,.35);background:#0a0b0f}
.sharecard img{display:block;width:100%;height:auto}
.copy{display:block;margin:0 0 32px;color:var(--muted);font-size:13px}
.copy input{display:block;width:100%;margin-top:6px;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:var(--raise);color:var(--fg);font:14px ui-monospace,SFMono-Regular,Menlo,monospace}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:0 0 24px}
.tile{border:1px solid var(--line);border-radius:12px;background:var(--raise);padding:16px}
.tile b{display:block;font:700 28px/1.1 ui-monospace,SFMono-Regular,Menlo,monospace;margin-bottom:6px}
.tile span{color:var(--muted);font-size:13px}
.tile.accent b{color:var(--cyan)}
.tile.text b{font-size:19px;line-height:1.45}
h2.small{font:600 13px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);margin:0 0 12px}
@media (max-width:520px){.tiles{grid-template-columns:1fr}.cta a{flex:1 1 100%;text-align:center}}
footer{color:var(--muted);font-size:13px}
@media (max-width:520px){.board summary{gap:8px}.rank{width:auto}.board img{width:28px;height:28px}.chip,.count-label{display:none}}
`;

export interface PageLinks {
  /** Where to find an issue to work on. */
  issues: string;
  discord: string;
  /** The page's own permanent URL, for share previews. */
  self: string;
  /** The board's share image, as an absolute URL. It carries a version so previews refresh when the top five change. */
  image: string;
  /** The other programs, each with the path of its page. */
  others: { title: string; path: string }[];
}

const joinNames = (names: string[]) => names.join(", ").replace(/, ([^,]*)$/, " and $1");

export function leaderboardPage(
  board: Leaderboard,
  program: Program,
  links: PageLinks,
  now: Date,
  /** `linking`: members can link their GitHub account with /link, which is how we find a winner on Discord. */
  opts: { linking?: boolean; members?: Map<string, string> } = {}
): string {
  const { title, label, start, end, minPrs, topN, reward, note } = program;
  const heading = `${title} leaderboard`;
  const repos = program.repos.join(", ").replace(/, ([^,]*)$/, " and $1");
  const when = dateRange(start, end);
  const state = statusLine(program, now);
  const description = `Merged pull requests in ${repos}, ${when}. The top ${topN} with at least ${minPrs} get ${reward}.`;
  const top = board.rows
    .slice(0, BOARD_ROWS)
    .map((row, i) => `${i + 1}. ${row.login}, ${row.count} merged ${row.count === 1 ? "PR" : "PRs"}`)
    .join("; ");
  const imageAlt = board.rows.length
    ? `Share image: ${heading}. ${top}.`
    : `Share image: ${heading}. No merged pull requests counted yet.`;

  let unlinkedNotice = "";
  if (opts.linking && opts.members) {
    const candidates = state.status === "ended"
      ? board.rows.filter((r) => r.winner)
      : board.rows.filter((r) => r.qualifies);
    const unlinked = candidates.filter((r) => !opts.members?.has(r.login.toLowerCase()));
    if (unlinked.length > 0) {
      const names = joinNames(
        unlinked.map((r) => `<a href="https://github.com/${encodeURIComponent(r.login)}">${escapeHtml(r.login)}</a>`)
      );
      if (state.status === "ended") {
        const verb = unlinked.length === 1 ? "won but hasn't" : "won but haven't";
        unlinkedNotice = `<p class="unlinked">${names} ${verb} linked their GitHub yet. <a href="${escapeHtml(links.discord)}">Join the Discord</a> and run <code>/link</code> there, so we can reach you.</p>`;
      } else {
        const qualifyVerb = unlinked.length === 1 ? "qualifies but hasn't" : "qualify but haven't";
        unlinkedNotice = `<p class="unlinked">${names} ${qualifyVerb} linked their GitHub yet. <a href="${escapeHtml(links.discord)}">Join the Discord</a> and run <code>/link</code> there, so we can reach you if you win.</p>`;
      }
    }
  }

  const rows = board.rows
    .map((row, i) => {
      const login = escapeHtml(row.login);
      const chip = standing(row, program, state.status);
      const chipHtml = chip ? `<span class="chip ${chip.kind}">${escapeHtml(chip.text)}</span>` : "";
      const card = `<a class="cardlink" href="/leaderboard/${escapeHtml(program.id)}/u/${encodeURIComponent(row.login)}" title="${login}'s share card" aria-label="${login}'s share card">Card</a>`;
      const prList = row.prs
        .map(
          (pr) =>
            `<li><a href="${escapeHtml(pr.url)}"><span class="repo">${escapeHtml(pr.repo)}#${pr.number}</span>${escapeHtml(pr.title)}</a></li>`
        )
        .join("\n");
      return `<li><details><summary><span class="rank">${i + 1}</span><img src="https://github.com/${encodeURIComponent(row.login)}.png?size=72" alt="" width="36" height="36" loading="lazy"><span class="who"><a href="https://github.com/${encodeURIComponent(row.login)}">${login}</a></span><span class="count">${row.count}<span class="count-label"> merged ${row.count === 1 ? "PR" : "PRs"}</span></span>${chipHtml}${card}</summary>\n<ul class="prs">\n${prList}\n</ul></details></li>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(heading)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${escapeHtml(heading)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:image" content="${escapeHtml(links.image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${escapeHtml(imageAlt)}">
<meta property="og:url" content="${escapeHtml(links.self)}">
<link rel="canonical" href="${escapeHtml(links.self)}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${escapeHtml(links.image)}">
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="eyebrow">CODERCOPS open source program</p>
<h1>${escapeHtml(heading)}</h1>
<p class="lede">Merged pull requests in ${escapeHtml(repos)}, ${when}.</p>
<p class="status ${state.status}">${escapeHtml(state.text)}</p>
${unlinkedNotice}
${board.rows.length ? `<ol class="board">\n${rows}\n</ol>` : `<div class="board"><p class="empty">${state.status === "ended" ? "No merged pull requests were counted." : "No merged pull requests counted yet. Pick an issue and be the first."}</p></div>`}
<section class="rules">
<h2>How it works</h2>
<p>A pull request counts when it's merged into one of the repos above during the window and carries the <code>${escapeHtml(label)}</code> label. Only PRs for issues that were assigned to you count.</p>
<p>The top ${topN} contributors with at least ${minPrs} merged PRs get ${escapeHtml(reward)}. Ties go to whoever got there first.</p>
${note ? `<p>${escapeHtml(note)}</p>` : ""}
${opts.linking ? `<p>We contact the winners by Discord DM. <a href="${escapeHtml(links.discord)}">Join the server</a> and run <code>/link</code> there, so we know which Discord account is yours.</p>` : ""}
</section>
<div class="cta">
<a class="primary" href="${escapeHtml(links.issues)}">Find an issue</a>
<a href="${escapeHtml(links.discord)}">Join the Discord</a>
<a href="https://www.codercops.com">Hire developers or get hired</a>
</div>
${links.others.length ? `<section class="others">\n<h2>Other programs</h2>\n<ul>\n${links.others.map((o) => `<li><a href="${escapeHtml(o.path)}">${escapeHtml(o.title)}</a></li>`).join("\n")}\n</ul>\n</section>` : ""}
<footer>Updated <time datetime="${escapeHtml(board.generatedAt)}">${escapeHtml(board.generatedAt.slice(0, 16).replace("T", " "))} UTC</time>. Refreshes every few minutes. <a href="/leaderboard/${escapeHtml(program.id)}.json">JSON</a></footer>
</main>
</body>
</html>`;
}

/** A small page with a heading and a few paragraphs, for the result of /link. Everything is escaped. */
export function noticePage(
  title: string,
  lines: string[],
  ok: boolean,
  label = ok ? "Done" : "Not linked",
  links: { label: string; href: string }[] = []
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="eyebrow">CODERCOPS community</p>
<h1>${escapeHtml(title)}</h1>
<section class="rules">
${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("\n")}
</section>
${links.length ? `<div class="cta">\n${links.map((link) => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`).join("\n")}\n</div>\n` : ""}<p class="status ${ok ? "running" : ""}">${escapeHtml(label)}</p>
</main>
</body>
</html>`;
}

const ordinal = (n: number): string => {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
};

export interface ContributorLinks {
  /** This page's own permanent URL. */
  self: string;
  /** The card image, as an absolute URL for share previews. It carries a version so previews refresh when the numbers change. */
  image: string;
  /** The program's leaderboard page. */
  board: string;
  /** The person's counted pull requests on GitHub. */
  prs: string;
  issues: string;
  discord: string;
}

/** One contributor's page in a program: their share card, ways to share it, and where they stand. */
export function contributorPage(
  input: { program: Program; row: LeaderboardRow; rank: number; of: number; generatedAt: string },
  links: ContributorLinks,
  now: Date
): string {
  const { program, row, rank, of, generatedAt } = input;
  const state = statusLine(program, now);
  const chip = standing(row, program, state.status);
  const login = escapeHtml(row.login);
  const prs = `${row.count} merged pull ${row.count === 1 ? "request" : "requests"}`;
  const heading = `${row.login} in ${program.title}`;
  const description = `${prs} in ${program.title}. ${ordinal(rank)} of ${of} on the leaderboard.`;
  const shareText = `${prs} in ${program.title}.`;
  const linkedin = `https://www.linkedin.com/sharing/share-offsite/?${new URLSearchParams({ url: links.self })}`;
  const x = `https://twitter.com/intent/tweet?${new URLSearchParams({ text: shareText, url: links.self })}`;
  const alt = `Share card: ${row.login}, ${prs} in ${program.title}, ${ordinal(rank)} of ${of}.`;
  const file = `codercops-${program.id}-${row.login}.png`;
  const updated = generatedAt;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(heading)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta property="og:type" content="profile">
<meta property="og:title" content="${escapeHtml(heading)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:image" content="${escapeHtml(links.image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${escapeHtml(alt)}">
<meta property="og:url" content="${escapeHtml(links.self)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${escapeHtml(links.image)}">
<link rel="canonical" href="${escapeHtml(links.self)}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>${STYLE}</style>
</head>
<body>
<main class="wide">
<p class="crumb"><a href="${escapeHtml(links.board)}">${escapeHtml(program.title)} leaderboard</a></p>
<p class="eyebrow">CODERCOPS open source program</p>
<h1>${login}</h1>
<p class="lede">${escapeHtml(description)}</p>
<p class="status ${state.status}">${escapeHtml(state.text)}</p>
<a class="sharecard" href="${escapeHtml(links.image)}"><img src="${escapeHtml(links.image)}" width="1200" height="630" alt="${escapeHtml(alt)}"></a>
<div class="cta">
<a class="primary" href="${escapeHtml(linkedin)}" target="_blank" rel="noopener">Share on LinkedIn</a>
<a href="${escapeHtml(x)}" target="_blank" rel="noopener">Share on X</a>
<a href="${escapeHtml(links.image)}" download="${escapeHtml(file)}">Download the card</a>
</div>
<label class="copy">Link to this page<input readonly value="${escapeHtml(links.self)}" aria-label="Link to this page"></label>
<div class="tiles">
<div class="tile accent"><b>${row.count}</b><span>merged pull ${row.count === 1 ? "request" : "requests"}</span></div>
<div class="tile"><b>${ordinal(rank)}</b><span>of ${of} ${of === 1 ? "contributor" : "contributors"}</span></div>
<div class="tile text"><b>${escapeHtml(chip ? chip.text : "Took part")}</b><span>${escapeHtml(state.status === "ended" ? "final result" : `needs ${program.minPrs} to qualify, top ${program.topN} win`)}</span></div>
</div>
<section class="rules">
<h2>About this card</h2>
<p>It counts pull requests merged into ${escapeHtml(program.repos.join(", ").replace(/, ([^,]*)$/, " and $1"))} during ${escapeHtml(dateRange(program.start, program.end))}. The numbers come straight from GitHub and update on their own.</p>
<p><a href="${escapeHtml(links.prs)}">See ${login}'s merged pull requests on GitHub</a> · <a href="https://github.com/${encodeURIComponent(row.login)}">GitHub profile</a> · <a href="${escapeHtml(links.board)}">Full leaderboard and rules</a></p>
</section>
<h2 class="small">Want a card of your own?</h2>
<div class="cta">
<a class="primary" href="${escapeHtml(links.issues)}">Find an issue</a>
<a href="${escapeHtml(links.discord)}">Join the Discord</a>
<a href="https://www.codercops.com">Hire developers or get hired</a>
</div>
<footer>Updated <time datetime="${escapeHtml(updated)}">${escapeHtml(updated.slice(0, 16).replace("T", " "))} UTC</time>. Refreshes every few minutes.</footer>
</main>
</body>
</html>`;
}
