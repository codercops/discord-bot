// The share card of one contributor in one program: a 1200x630 SVG that
// src/card-image.ts turns into a PNG. Pure: no I/O, so the layout is easy to
// test. Two fonts are used and both ship in assets/fonts.
import type { Program } from "./config";
import type { LeaderboardRow } from "./leaderboard";
import type { Chip } from "./page";
import { programStatus } from "./programs";

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

const C = { bg: "#0a0b0f", raise: "#12141a", line: "#232833", fg: "#e6e9ef", muted: "#8a93a8", cyan: "#00e5c7", violet: "#9e7bff", gold: "#e3b341" };
const MONO = `font-family="JetBrains Mono" font-weight="700"`;
const SANS = `font-family="IBM Plex Sans" font-weight="500"`;
// JetBrains Mono is monospaced: every glyph is 0.6 em wide. That lets us size
// and place mono text without measuring it.
const MONO_ADVANCE = 0.6;

export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/** The largest size (up to `max`) at which `text` in the mono font fits into `width`. */
export function fitMono(text: string, width: number, max: number): number {
  return Math.min(max, Math.floor(width / (MONO_ADVANCE * Math.max(1, text.length))));
}

/**
 * Progress toward the number of merged PRs it takes to qualify: one segment
 * per PR, filled for the ones already merged. With a high bar to clear it
 * becomes one continuous track, because tiny segments stop being readable.
 */
export function progressBar(count: number, needed: number, x: number, y: number, color: string): string {
  const width = 250;
  const height = 10;
  const done = Math.min(count, needed);
  if (needed < 1) return "";
  if (needed > 12) {
    const filled = Math.round((width * done) / needed);
    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="5" fill="${C.line}"/>
<rect x="${x}" y="${y}" width="${filled}" height="${height}" rx="5" fill="${color}"/>`;
  }
  const gap = 8;
  const segment = (width - gap * (needed - 1)) / needed;
  return Array.from({ length: needed }, (_, i) => {
    const sx = Math.round((x + i * (segment + gap)) * 10) / 10;
    return `<rect x="${sx}" y="${y}" width="${Math.round(segment * 10) / 10}" height="${height}" rx="5" fill="${i < done ? color : C.line}"/>`;
  }).join("\n");
}

export interface CardInput {
  program: Program;
  row: LeaderboardRow;
  /** 1-based. */
  rank: number;
  /** How many people are on the board. */
  of: number;
  chip: Chip | null;
  /** The avatar as a data: URI. Without one the card shows the first letter of the login. */
  avatar?: string;
  /** The host printed in the corner, e.g. "oss.codercops.com". */
  site: string;
}

export function cardSvg(input: CardInput): string {
  const { program, row, rank, of, chip, avatar, site } = input;
  const login = row.login;
  const count = String(row.count);

  const nameSize = fitMono(login, 800, 68);
  const countSize = 160;
  const countWidth = Math.round(MONO_ADVANCE * countSize * count.length);
  const labelX = 80 + countWidth + 30;
  const barColor = chip?.kind === "top" ? C.gold : C.cyan;

  const chipColor = chip?.kind === "top" ? C.gold : chip?.kind === "qualifies" ? C.cyan : C.muted;
  const chipText = chip ? chip.text.toUpperCase() : "";
  const chipSize = 20;
  const chipWidth = Math.round(MONO_ADVANCE * chipSize * chipText.length) + 44;
  const chipSvg = chip
    ? `<rect x="${1120 - chipWidth}" y="62" width="${chipWidth}" height="46" rx="23" fill="${C.raise}" stroke="${chipColor}" stroke-width="2"/>
<text x="${1120 - chipWidth / 2}" y="92" text-anchor="middle" ${MONO} font-size="${chipSize}" fill="${chipColor}">${escapeXml(chipText)}</text>`
    : "";

  const avatarSvg = avatar
    ? `<image href="${escapeXml(avatar)}" x="84" y="142" width="172" height="172" clip-path="url(#avatar)" preserveAspectRatio="xMidYMid slice"/>`
    : `<circle cx="170" cy="228" r="86" fill="${C.raise}"/>
<text x="170" y="257" text-anchor="middle" ${MONO} font-size="84" fill="${C.cyan}">${escapeXml(login.slice(0, 1).toUpperCase())}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">
<defs>
<radialGradient id="glow-a" cx="0.1" cy="0" r="0.85"><stop offset="0" stop-color="${C.cyan}" stop-opacity="0.26"/><stop offset="1" stop-color="${C.cyan}" stop-opacity="0"/></radialGradient>
<radialGradient id="glow-b" cx="1" cy="1" r="0.8"><stop offset="0" stop-color="${C.violet}" stop-opacity="0.28"/><stop offset="1" stop-color="${C.violet}" stop-opacity="0"/></radialGradient>
<linearGradient id="ring" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.cyan}"/><stop offset="1" stop-color="${C.violet}"/></linearGradient>
<clipPath id="avatar"><circle cx="170" cy="228" r="86"/></clipPath>
</defs>
<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${C.bg}"/>
<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="url(#glow-a)"/>
<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="url(#glow-b)"/>
<rect x="28" y="28" width="1144" height="574" rx="28" fill="none" stroke="${C.line}" stroke-width="2"/>

<text x="80" y="94" ${MONO} font-size="28" fill="${C.cyan}">CODERCOPS</text>
<text x="${80 + Math.round(MONO_ADVANCE * 28 * 9) + 18}" y="93" ${SANS} font-size="22" letter-spacing="4" fill="${C.muted}">OPEN SOURCE PROGRAM</text>
${chipSvg}

${avatarSvg}
<circle cx="170" cy="228" r="92" fill="none" stroke="url(#ring)" stroke-width="4"/>
<text x="304" y="${220 + Math.round(nameSize * 0.12)}" ${MONO} font-size="${nameSize}" fill="${C.fg}">${escapeXml(login)}</text>
<text x="306" y="276" ${SANS} font-size="32" fill="${C.muted}">${escapeXml(program.title)}</text>

<line x1="80" y1="346" x2="1120" y2="346" stroke="${C.line}" stroke-width="2"/>

<text x="80" y="496" ${MONO} font-size="${countSize}" fill="${C.cyan}">${count}</text>
<text x="${labelX}" y="436" ${SANS} font-size="40" fill="${C.fg}">merged</text>
<text x="${labelX}" y="484" ${SANS} font-size="40" fill="${C.fg}">${row.count === 1 ? "pull request" : "pull requests"}</text>
${progressBar(row.count, program.minPrs, labelX, 506, barColor)}

<text x="1120" y="478" text-anchor="end" ${MONO} font-size="104" fill="${C.violet}">#${rank}</text>
<text x="1120" y="520" text-anchor="end" ${SANS} font-size="26" fill="${C.muted}">of ${of} ${of === 1 ? "contributor" : "contributors"}</text>

<text x="80" y="576" ${SANS} font-size="22" fill="${C.muted}">${escapeXml(program.repos.join("  ·  "))}</text>
<text x="1120" y="576" text-anchor="end" ${MONO} font-size="22" fill="${C.cyan}">${escapeXml(site)}</text>
</svg>`;
}

/** How many people the leaderboard's share image shows. */
export const BOARD_ROWS = 5;

/** What the leaderboard image says about where the program stands, in the color it says it in. */
function boardState(program: Program, now: Date): { text: string; color: string } {
  const status = programStatus(program, now);
  if (status === "ended") return { text: "FINAL RESULTS", color: C.gold };
  if (status === "upcoming") {
    const start = program.start.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    return { text: `STARTS ${start.toUpperCase()}`, color: C.muted };
  }
  const days = Math.ceil((program.end.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
  return { text: `${days} ${days === 1 ? "DAY" : "DAYS"} LEFT`, color: C.cyan };
}

const mergedPrs = (rows: LeaderboardRow[]) => rows.reduce((sum, r) => sum + r.count, 0);

/**
 * Changes whenever the leaderboard image would: who is in the top five, their
 * counts, the totals and where the program stands. Goes in the image's query,
 * so share previews fetch the new picture. FNV-1a: short and stable, not a
 * security hash.
 */
export function boardVersion(rows: LeaderboardRow[], program: Program, now: Date): string {
  const top = rows
    .slice(0, BOARD_ROWS)
    .map((r) => `${r.login}:${r.count}:${r.winner ? 1 : 0}`)
    .join(",");
  const key = `${top}|${rows.length}|${mergedPrs(rows)}|${boardState(program, now).text}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(36);
}

export interface BoardCardInput {
  program: Program;
  /** The whole board, ranked. The image draws the first five and counts everyone. */
  rows: LeaderboardRow[];
  /** The avatars of the first five as data: URIs, in the same order. A missing one shows the first letter of the login. */
  avatars: (string | undefined)[];
  now: Date;
  /** The host printed in the corner, e.g. "oss.codercops.com". */
  site: string;
}

/** The share image of a program's leaderboard: the same size, colors and fonts as the contributor card. */
export function boardSvg(input: BoardCardInput): string {
  const { program, rows, avatars, now, site } = input;
  const ended = programStatus(program, now) === "ended";
  const state = boardState(program, now);
  const prs = mergedPrs(rows);
  const title = `${program.title} leaderboard`;
  const titleSize = fitMono(title, 1040, 56);
  const totals = `${rows.length} ${rows.length === 1 ? "contributor" : "contributors"}  ·  ${prs} merged ${prs === 1 ? "PR" : "PRs"}`;

  const chipSize = 20;
  const chipWidth = Math.round(MONO_ADVANCE * chipSize * state.text.length) + 44;

  // The people in the top N carry a mark: "TOP 5" while it runs, "WINNER" once it's over.
  const mark = ended ? "WINNER" : `TOP ${program.topN}`;
  const markSize = 16;
  const markWidth = Math.round(MONO_ADVANCE * markSize * mark.length) + 28;
  const markRight = 960;

  const top = rows.slice(0, BOARD_ROWS);
  const rowY = (i: number) => 296 + i * 56;
  const clips = top.map((_, i) => `<clipPath id="avatar-${i}"><circle cx="172" cy="${rowY(i)}" r="20"/></clipPath>`).join("\n");
  const rowsSvg = top
    .map((row, i) => {
      const cy = rowY(i);
      const accent = row.winner ? C.gold : C.violet;
      const avatar = avatars[i];
      const picture = avatar
        ? `<image href="${escapeXml(avatar)}" x="152" y="${cy - 20}" width="40" height="40" clip-path="url(#avatar-${i})" preserveAspectRatio="xMidYMid slice"/>`
        : `<circle cx="172" cy="${cy}" r="20" fill="${C.bg}"/>
<text x="172" y="${cy + 7}" text-anchor="middle" ${MONO} font-size="20" fill="${C.cyan}">${escapeXml(row.login.slice(0, 1).toUpperCase())}</text>`;
      const nameSize = fitMono(row.login, 600, 30);
      const markSvg = row.winner
        ? `<rect x="${markRight - markWidth}" y="${cy - 15}" width="${markWidth}" height="30" rx="15" fill="none" stroke="${C.gold}" stroke-width="2"/>
<text x="${markRight - markWidth / 2}" y="${cy + 6}" text-anchor="middle" ${MONO} font-size="${markSize}" fill="${C.gold}">${escapeXml(mark)}</text>`
        : "";
      return `<rect x="64" y="${cy - 24}" width="1072" height="48" rx="14" fill="${C.raise}"${row.winner ? ` stroke="${C.gold}" stroke-width="2"` : ""}/>
<text x="108" y="${cy + 10}" text-anchor="middle" ${MONO} font-size="28" fill="${accent}">#${i + 1}</text>
${picture}
<circle cx="172" cy="${cy}" r="22" fill="none" stroke="${row.winner ? C.gold : "url(#ring)"}" stroke-width="2"/>
<text x="212" y="${cy + Math.round(nameSize * 0.35)}" ${MONO} font-size="${nameSize}" fill="${C.fg}">${escapeXml(row.login)}</text>
${markSvg}
<text x="1112" y="${cy + 10}" text-anchor="end" ${MONO} font-size="28" fill="${C.cyan}">${row.count} ${row.count === 1 ? "PR" : "PRs"}</text>`;
    })
    .join("\n");

  const empty = ended ? "No merged pull requests were counted" : "No merged pull requests yet";
  const emptySvg = `<text x="600" y="392" text-anchor="middle" ${MONO} font-size="${fitMono(empty, 1000, 44)}" fill="${C.fg}">${empty}</text>
${ended ? "" : `<text x="600" y="446" text-anchor="middle" ${SANS} font-size="28" fill="${C.muted}">Pick an issue and be the first.</text>`}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">
<defs>
<radialGradient id="glow-a" cx="0.1" cy="0" r="0.85"><stop offset="0" stop-color="${C.cyan}" stop-opacity="0.26"/><stop offset="1" stop-color="${C.cyan}" stop-opacity="0"/></radialGradient>
<radialGradient id="glow-b" cx="1" cy="1" r="0.8"><stop offset="0" stop-color="${C.violet}" stop-opacity="0.28"/><stop offset="1" stop-color="${C.violet}" stop-opacity="0"/></radialGradient>
<linearGradient id="ring" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.cyan}"/><stop offset="1" stop-color="${C.violet}"/></linearGradient>
${clips}
</defs>
<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${C.bg}"/>
<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="url(#glow-a)"/>
<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="url(#glow-b)"/>
<rect x="28" y="28" width="1144" height="574" rx="28" fill="none" stroke="${C.line}" stroke-width="2"/>

<text x="80" y="94" ${MONO} font-size="28" fill="${C.cyan}">CODERCOPS</text>
<text x="${80 + Math.round(MONO_ADVANCE * 28 * 9) + 18}" y="93" ${SANS} font-size="22" letter-spacing="4" fill="${C.muted}">OPEN SOURCE PROGRAM</text>
<rect x="${1120 - chipWidth}" y="62" width="${chipWidth}" height="46" rx="23" fill="${C.raise}" stroke="${state.color}" stroke-width="2"/>
<text x="${1120 - chipWidth / 2}" y="92" text-anchor="middle" ${MONO} font-size="${chipSize}" fill="${state.color}">${escapeXml(state.text)}</text>

<text x="80" y="${160 + Math.round(titleSize * 0.12)}" ${MONO} font-size="${titleSize}" fill="${C.fg}">${escapeXml(title)}</text>
<text x="82" y="214" ${SANS} font-size="26" fill="${C.muted}">${totals}</text>
<line x1="80" y1="244" x2="1120" y2="244" stroke="${C.line}" stroke-width="2"/>

${top.length ? rowsSvg : emptySvg}

<text x="80" y="576" ${SANS} font-size="22" fill="${C.muted}">${escapeXml(program.repos.join("  ·  "))}</text>
<text x="1120" y="576" text-anchor="end" ${MONO} font-size="22" fill="${C.cyan}">${escapeXml(site)}</text>
</svg>`;
}
