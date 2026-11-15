import { describe, expect, it } from "vitest";
import raw from "../wrangler.jsonc?raw";
import { slashCommands, type SlashCommandVars } from "../scripts/commands";
import { parseJsonc } from "../scripts/jsonc";
import { runCommand } from "../src/commands";
import { getConfig } from "../src/config";
import { helpReply } from "../src/messages";
import { makeEnv, mockFetch } from "./helpers";

// Parsed the same way as scripts/register-commands.mjs.
const config = parseJsonc(raw);
const vars = config.vars as unknown as SlashCommandVars;
const now = new Date("2026-10-12T10:00:00Z");

/** The "`/command`: description" lines of a help reply. */
function commandsIn(content: string | undefined): { name: string; description: string }[] {
  return (content ?? "")
    .split("\n")
    .flatMap((line) => {
      const match = line.match(/^`\/(\S+)`: (.+)$/);
      return match ? [{ name: match[1]!, description: match[2]! }] : [];
    });
}

describe("slash command registry", () => {
  it("lists the same commands, in the same order, as /help while linking is on", () => {
    const registered = slashCommands(vars);
    const listed = commandsIn(helpReply(true).content);

    expect(listed.map((c) => c.name)).toEqual(registered.map((c) => c.name));
    for (const command of registered) {
      const help = listed.find((c) => c.name === command.name);
      expect(help, command.name).toBeDefined();
      expect(help!.description, command.name).toBe(`${command.description}.`);
    }
  });

  it("leaves the link commands out while linking is off", () => {
    const registered = slashCommands({ ...vars, LINKING: "off" });
    const listed = commandsIn(helpReply(false).content);

    expect(listed.map((c) => c.name)).toEqual(registered.map((c) => c.name));
    expect(registered.map((c) => c.name)).not.toContain("link");
    expect(registered.map((c) => c.name)).not.toContain("me");
  });

  it("hides the link commands from everyone but admins in preview mode", () => {
    const preview = slashCommands(vars, { preview: true });
    const publicCommands = slashCommands(vars);

    for (const command of preview.filter((c) => ["link", "unlink", "me"].includes(c.name))) {
      expect(command.default_member_permissions).toBe("0");
    }
    for (const command of publicCommands) {
      expect(command.default_member_permissions).toBeUndefined();
    }
  });

  it("answers every registered command instead of falling through", async () => {
    // REST issue listings get an array, search gets a result envelope.
    mockFetch((url) => (url.pathname.startsWith("/search/") ? { total_count: 0, items: [] } : []));
    const env = makeEnv();
    const cfg = getConfig(env);

    for (const command of slashCommands(vars)) {
      const reply = await runCommand({ name: command.name }, { id: "42", name: "Ada" }, env, cfg, now);
      expect(reply.content, command.name).not.toBe("I don't know that command.");
    }
  });

  it("stays within Discord's limits and puts required options first", () => {
    for (const command of slashCommands(vars)) {
      expect(command.name, command.name).toMatch(/^[-_a-z0-9]{1,32}$/);
      expect(command.description.length, command.name).toBeGreaterThan(0);
      expect(command.description.length, command.name).toBeLessThanOrEqual(100);

      let sawOptional = false;
      for (const option of command.options ?? []) {
        expect(option.name, `${command.name} ${option.name}`).toMatch(/^[-_a-z0-9]{1,32}$/);
        expect(option.description.length, `${command.name} ${option.name}`).toBeGreaterThan(0);
        expect(option.description.length, `${command.name} ${option.name}`).toBeLessThanOrEqual(100);
        if (option.required) {
          expect(sawOptional, `${command.name} ${option.name}`).toBe(false);
        } else {
          sawOptional = true;
        }
      }
    }
  });
});
