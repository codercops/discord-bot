import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { version } from "../package.json";
import { botRequest, DiscordError, sendMessage } from "../src/discord";
import { makeEnv, mockFetch } from "./helpers";

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

describe("Discord requests", () => {
  const env = makeEnv();

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sends the version from package.json in the User-Agent", async () => {
    const fetched = mockFetch();
    await botRequest(env, "POST", "/channels/123/messages", { content: "hello" });
    expect(fetched.discord()[0]?.userAgent).toBe(`DiscordBot (https://github.com/codercops/discord-bot, ${version})`);
  });

  it("retries once when Discord answers 429 with a short Retry-After header and succeeds", async () => {
    let attempts = 0;
    const fetched = mockFetch(undefined, () => {
      attempts++;
      if (attempts === 1) {
        return jsonResponse({ message: "You are being rate limited." }, 429, { "Retry-After": "2" });
      }
      return jsonResponse({ id: "msg-retry" }, 200);
    });

    const promise = botRequest<{ id: string }>(env, "POST", "/channels/123/messages", { content: "hello" });
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(result).toEqual({ id: "msg-retry" });
    expect(fetched.discord()).toHaveLength(2);
    expect(fetched.discord()[0]?.body).toEqual({ content: "hello" });
    expect(fetched.discord()[1]?.body).toEqual({ content: "hello" });
  });

  it("waits the full retry delay before sending the second request", async () => {
    let attempts = 0;
    const fetched = mockFetch(undefined, () => {
      attempts++;
      if (attempts === 1) {
        return jsonResponse({ message: "You are being rate limited." }, 429, { "Retry-After": "2" });
      }
      return jsonResponse({ id: "msg-retry" }, 200);
    });

    const promise = botRequest<{ id: string }>(env, "POST", "/channels/123/messages", { content: "hello" });

    await vi.advanceTimersByTimeAsync(1999);
    expect(fetched.discord()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;

    expect(result).toEqual({ id: "msg-retry" });
    expect(fetched.discord()).toHaveLength(2);
  });

  it("retries once when Discord answers 429 with a short JSON retry_after and succeeds", async () => {
    let attempts = 0;
    const fetched = mockFetch(undefined, () => {
      attempts++;
      if (attempts === 1) {
        return jsonResponse({ message: "Rate limited", retry_after: 1.5 }, 429);
      }
      return jsonResponse({ id: "msg-json-retry" }, 200);
    });

    const promise = botRequest<{ id: string }>(env, "POST", "/channels/123/messages", { content: "test" });
    await vi.advanceTimersByTimeAsync(1500);
    const result = await promise;

    expect(result).toEqual({ id: "msg-json-retry" });
    expect(fetched.discord()).toHaveLength(2);
  });

  it("fails immediately with DiscordError 429 when Retry-After specifies a long wait", async () => {
    const fetched = mockFetch(undefined, () =>
      jsonResponse({ message: "Rate limited", retry_after: 60 }, 429, { "Retry-After": "60" })
    );

    const err = await botRequest(env, "POST", "/channels/123/messages", {}).catch((e) => e);
    expect(err).toBeInstanceOf(DiscordError);
    expect((err as DiscordError).status).toBe(429);
    expect((err as DiscordError).message).toBe("Discord 429 for POST /channels/123/messages");
    expect(fetched.discord()).toHaveLength(1);
  });

  it("fails immediately with DiscordError 429 when JSON retry_after specifies a long wait", async () => {
    const fetched = mockFetch(undefined, () =>
      jsonResponse({ message: "Rate limited", retry_after: 10 }, 429)
    );

    const err = await botRequest(env, "POST", "/channels/123/messages", {}).catch((e) => e);
    expect(err).toBeInstanceOf(DiscordError);
    expect((err as DiscordError).status).toBe(429);
    expect((err as DiscordError).message).toBe("Discord 429 for POST /channels/123/messages");
    expect(fetched.discord()).toHaveLength(1);
  });

  it("fails immediately with DiscordError 429 when no retry-after information is provided", async () => {
    const fetched = mockFetch(undefined, () => new Response("Too Many Requests", { status: 429 }));

    const err = await botRequest(env, "POST", "/channels/123/messages", {}).catch((e) => e);
    expect(err).toBeInstanceOf(DiscordError);
    expect((err as DiscordError).status).toBe(429);
    expect(fetched.discord()).toHaveLength(1);
  });

  it("retries only once and throws DiscordError 429 if the retry also answers 429", async () => {
    const fetched = mockFetch(undefined, () =>
      jsonResponse({ message: "Rate limited", retry_after: 1 }, 429, { "Retry-After": "1" })
    );

    const promise = botRequest(env, "POST", "/channels/123/messages", {}).catch((e) => e);
    await vi.advanceTimersByTimeAsync(1000);
    const err = await promise;

    expect(err).toBeInstanceOf(DiscordError);
    expect((err as DiscordError).status).toBe(429);
    expect(fetched.discord()).toHaveLength(2);
  });

  it("throws DiscordError with the second error if the retry fails with another status", async () => {
    let attempts = 0;
    const fetched = mockFetch(undefined, () => {
      attempts++;
      if (attempts === 1) {
        return jsonResponse({ message: "Rate limited", retry_after: 1 }, 429, { "Retry-After": "1" });
      }
      return jsonResponse({ message: "Internal server error" }, 500);
    });

    const promise = botRequest(env, "POST", "/channels/123/messages", {}).catch((e) => e);
    await vi.advanceTimersByTimeAsync(1000);
    const err = await promise;

    expect(err).toBeInstanceOf(DiscordError);
    expect((err as DiscordError).status).toBe(500);
    expect((err as DiscordError).message).toBe("Discord 500 for POST /channels/123/messages");
    expect(fetched.discord()).toHaveLength(2);
  });

  it("does not retry other HTTP errors", async () => {
    const fetched = mockFetch(undefined, () => jsonResponse({ message: "Not Found" }, 404));

    const err = await botRequest(env, "GET", "/channels/123/messages").catch((e) => e);
    expect(err).toBeInstanceOf(DiscordError);
    expect((err as DiscordError).status).toBe(404);
    expect((err as DiscordError).message).toBe("Discord 404 for GET /channels/123/messages");
    expect(fetched.discord()).toHaveLength(1);
  });

  it("returns undefined on 204 No Content response after retry", async () => {
    let attempts = 0;
    const fetched = mockFetch(undefined, () => {
      attempts++;
      if (attempts === 1) {
        return jsonResponse({ retry_after: 1 }, 429, { "Retry-After": "1" });
      }
      return new Response(null, { status: 204 });
    });

    const promise = botRequest<void>(env, "PUT", "/guilds/g1/members/u1/roles/r1", undefined, "audit reason");
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result).toBeUndefined();
    expect(fetched.discord()).toHaveLength(2);
  });

  it("retries in high-level helper functions like sendMessage", async () => {
    let attempts = 0;
    const fetched = mockFetch(undefined, () => {
      attempts++;
      if (attempts === 1) {
        return jsonResponse({ retry_after: 2 }, 429, { "Retry-After": "2" });
      }
      return jsonResponse({ id: "msg-999" }, 200);
    });

    const promise = sendMessage(env, "chan-1", { content: "welcome!" });
    await vi.advanceTimersByTimeAsync(2000);
    const messageId = await promise;

    expect(messageId).toBe("msg-999");
    expect(fetched.discord()).toHaveLength(2);
  });
});
