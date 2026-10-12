import { describe, expect, it } from "vitest";
import { runCommand } from "../src/commands";
import { getConfig } from "../src/config";
import worker from "../src/index";
import { helpReply } from "../src/messages";
import { makeEnv, mockFetch } from "./helpers";

const now = new Date("2026-10-12T10:00:00Z");
const linkingEnv = () => makeEnv({ LINKING: "on", DISCORD_CLIENT_SECRET: "client-secret" });
const run = (env: ReturnType<typeof makeEnv>) => runCommand({ name: "help" }, { id: "42", name: "Ada" }, env, getConfig(env), now);

/** The "/command" — description lines of a help reply. */
function commandsIn(content: string | undefined): { name: string; description: string }[] {
  return (content ?? "")
    .split("\n")
    .flatMap((line) => {
      const match = line.match(/^`(\S+)` — (.+)$/);
      return match ? [{ name: match[1]!, description: match[2]! }] : [];
    });
}

describe("/help", () => {
  it("lists every command with a one line description and ends with the repo link", async () => {
    const reply = await run(linkingEnv());
    const listed = commandsIn(reply.content);
    expect(listed.map((c) => c.name)).toEqual(["/help", "/issues", "/leaderboard", "/checkin", "/streaks", "/link", "/unlink", "/me"]);
    for (const { name, description } of listed) {
      expect(description.length, name).toBeGreaterThan(10);
      expect(description.length, name).toBeLessThan(100);
    }
    expect(reply.content).toContain("bug");
    expect(reply.content?.endsWith("https://github.com/codercops/discord-bot")).toBe(true);
  });

  it("leaves the link commands out while linking is off", async () => {
    const listed = commandsIn((await run(makeEnv())).content);
    expect(listed.map((c) => c.name)).toEqual(["/help", "/issues", "/leaderboard", "/checkin", "/streaks"]);
    expect(helpReply(false).content).not.toContain("/link");
    expect(helpReply(false).content?.endsWith("https://github.com/codercops/discord-bot")).toBe(true);
  });

  it("answers only the person who ran it, like every other command", async () => {
    const fetched = mockFetch();
    const { request, publicKey } = await signedHelpInteraction();
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    const res = await worker.fetch(request, makeEnv({ DISCORD_PUBLIC_KEY: publicKey }), ctx);
    // Deferred as ephemeral, so only the runner ever sees the reply.
    expect(await res.json()).toEqual({ type: 5, data: { flags: 64 } });
    await Promise.all(pending);
    const reply = fetched.discord()[0];
    expect(reply?.url).toBe("https://discord.com/api/v10/webhooks/111/interaction-token/messages/@original");
    expect(reply?.body.content).toContain("`/issues`");
    expect(fetched.calls.some((c) => c.url.includes("/channels/"))).toBe(false);
  });
});

const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A signed POST /interactions for `/help`, the way Discord sends it. */
async function signedHelpInteraction() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = toHex((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const text = JSON.stringify({ type: 2, token: "interaction-token", data: { name: "help" } });
  const signature = toHex(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode("1700000000" + text)));
  const request = new Request("https://bot.example/interactions", {
    method: "POST",
    headers: { "X-Signature-Ed25519": signature, "X-Signature-Timestamp": "1700000000" },
    body: text,
  });
  return { request, publicKey };
}
