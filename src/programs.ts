// Helpers for picking a contributor program and saying where it stands.
import type { Config, Program } from "./config";

export type ProgramStatus = "upcoming" | "running" | "ended";

export function programStatus(program: Program, now: Date): ProgramStatus {
  if (now < program.start) return "upcoming";
  return now > program.end ? "ended" : "running";
}

export function findProgram(cfg: Config, id: unknown): Program | undefined {
  return typeof id === "string" ? cfg.programs.find((p) => p.id === id) : undefined;
}

/**
 * The program to show when nobody names one: the one running now, otherwise
 * the one that ended last, otherwise the next one to start.
 */
export function currentProgram(cfg: Config, now: Date): Program | undefined {
  const running = cfg.programs.filter((p) => programStatus(p, now) === "running");
  if (running.length > 0) return running[running.length - 1];
  const ended = cfg.programs
    .filter((p) => programStatus(p, now) === "ended")
    .sort((a, b) => b.end.getTime() - a.end.getTime());
  return ended[0] ?? cfg.programs[0];
}

/** The program's permanent public page. */
export const leaderboardUrl = (cfg: Config, program: Program): string => `${cfg.publicUrl}/leaderboard/${program.id}`;

// /leaderboard, /leaderboard.json, /leaderboard/{id} and /leaderboard/{id}.json
export const LEADERBOARD_PATH = /^\/leaderboard(?:\/([a-z0-9][a-z0-9-]*))?(\.json)?$/;

// /leaderboard/{id}.png, the board's share image
export const LEADERBOARD_IMAGE_PATH = /^\/leaderboard\/([a-z0-9][a-z0-9-]*)\.png$/;
