import { beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig } from "../src/config";
import { handleGithubEvent, isStarterIssue, resyncStarterIssues, starterState } from "../src/webhook";
import { makeEnv, mockFetch, type RecordedCall } from "./helpers";

const repository = { name: "toolbelt", owner: { login: "codercops" } };
let env = makeEnv();
let cfg = getConfig(env);

beforeEach(() => {
  env = makeEnv();
  cfg = getConfig(env);
});

const issueEvent = (action: string, over: Record<string, unknown> = {}, label?: string) => ({
  action,
  repository,
  ...(label ? { label: { name: label } } : {}),
  issue: {
    number: 124,
    title: "Quote YAML strings",
    html_url: "https://github.com/codercops/toolbelt/issues/124",
    state: "open",
    labels: [{ name: "bug" }, { name: "good first issue" }],
    assignees: [],
    ...over,
  },
});

describe("isStarterIssue / starterState", () => {
  it("needs a starter label and no blocked label", () => {
    expect(isStarterIssue(["bug", "Good First Issue"], cfg)).toBe(true);
    expect(isStarterIssue(["help wanted"], cfg)).toBe(true);
    expect(isStarterIssue(["bug"], cfg)).toBe(false);
    expect(isStarterIssue(["good first issue", "blocked"], cfg)).toBe(false);
  });

  it("maps issue state to open, claimed or done", () => {
    const base = issueEvent("labeled").issue;
    expect(starterState(base as never)).toEqual({ kind: "open" });
    expect(starterState({ ...base, assignees: [{ login: "ada" }] } as never)).toEqual({ kind: "claimed", by: "ada" });
    expect(starterState({ ...base, state: "closed" } as never)).toEqual({ kind: "done" });
    expect(starterState({ ...base, state: "closed", state_reason: null } as never)).toEqual({ kind: "done" });
    expect(starterState({ ...base, state: "closed", state_reason: "completed" } as never)).toEqual({ kind: "done" });
  });

  it("maps an issue closed for any other reason to unavailable", () => {
    const base = issueEvent("labeled").issue;
    expect(starterState({ ...base, state: "closed", state_reason: "not_planned" } as never)).toEqual({ kind: "unavailable" });
    expect(starterState({ ...base, state: "closed", state_reason: "duplicate" } as never)).toEqual({ kind: "unavailable" });
  });

  it("maps issue state to unavailable when not a starter issue or on deleted/transferred", () => {
    const base = issueEvent("labeled").issue;
    expect(starterState({ ...base, labels: [{ name: "bug" }] } as never, cfg)).toEqual({ kind: "unavailable" });
    expect(starterState({ ...base, labels: [{ name: "good first issue" }, { name: "blocked" }] } as never, cfg)).toEqual({ kind: "unavailable" });
    expect(starterState(base as never, cfg, "deleted")).toEqual({ kind: "unavailable" });
    expect(starterState(base as never, cfg, "transferred")).toEqual({ kind: "unavailable" });
  });
});

describe("starter issue feed", () => {
  it("posts once when a starter label is added, then edits that message as the issue changes", async () => {
    const fetched = mockFetch();

    expect(await handleGithubEvent("issues", issueEvent("labeled", {}, "good first issue"), env, cfg)).toBe("posted starter issue");
    expect(fetched.discord()).toHaveLength(1);
    expect(fetched.discord()[0]).toMatchObject({ method: "POST", url: "https://discord.com/api/v10/channels/chan-issues/messages" });
    expect(fetched.discord()[0]?.body.allowed_mentions).toEqual({ parse: [] });

    const claimed = issueEvent("assigned", { assignees: [{ login: "ada" }] });
    expect(await handleGithubEvent("issues", claimed, env, cfg)).toBe("updated starter issue (claimed)");
    const edit = fetched.discord()[1];
    expect(edit).toMatchObject({ method: "PATCH", url: "https://discord.com/api/v10/channels/chan-issues/messages/msg-1" });
    expect(edit?.body.embeds[0].description).toContain("Claimed by ada.");

    expect(await handleGithubEvent("issues", issueEvent("unassigned"), env, cfg)).toBe("updated starter issue (open)");
    expect(await handleGithubEvent("issues", issueEvent("closed", { state: "closed" }), env, cfg)).toBe("updated starter issue (done)");
    expect(fetched.discord().filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("skips Discord edits and KV writes when only the issue body changes", async () => {
    const fetched = mockFetch();
    expect(await handleGithubEvent("issues", issueEvent("labeled", {}, "good first issue"), env, cfg)).toBe("posted starter issue");
    const put = vi.spyOn(env.STATE, "put");
    const bodyEdited = issueEvent("edited", { body: "A changed body that isn't shown in the feed." });

    expect(await handleGithubEvent("issues", bodyEdited, env, cfg)).toBe("unchanged starter issue");
    expect(fetched.discord()).toHaveLength(1);
    expect(put).not.toHaveBeenCalled();
  });

  it("edits the feed when the title, labels, or assignee changes", async () => {
    const fetched = mockFetch();
    expect(await handleGithubEvent("issues", issueEvent("labeled", {}, "good first issue"), env, cfg)).toBe("posted starter issue");

    expect(await handleGithubEvent("issues", issueEvent("edited", { title: "Updated title" }), env, cfg)).toBe("updated starter issue (open)");
    expect(await handleGithubEvent("issues", issueEvent("labeled", { labels: [{ name: "bug" }, { name: "good first issue" }, { name: "help wanted" }] }, "help wanted"), env, cfg)).toBe("updated starter issue (open)");
    expect(await handleGithubEvent("issues", issueEvent("assigned", { assignees: [{ login: "ada" }] }), env, cfg)).toBe("updated starter issue (claimed)");

    expect(fetched.discord()).toHaveLength(4);
    expect(fetched.discord()[1]?.body.embeds[0].title).toContain("Updated title");
    expect(fetched.discord()[2]?.body.embeds[0].description).toContain("help wanted");
    expect(fetched.discord()[3]?.body.embeds[0].description).toContain("Claimed by ada.");
  });

  it("updates legacy records without a snapshot once, then skips unchanged events", async () => {
    const fetched = mockFetch();
    const key = "issue:toolbelt#124";
    await env.STATE.put(key, JSON.stringify({ messageId: "legacy-message", state: "open" }));
    const put = vi.spyOn(env.STATE, "put");
    const edited = issueEvent("edited", { body: "Only the body changed." });

    expect(await handleGithubEvent("issues", edited, env, cfg)).toBe("updated starter issue (open)");
    expect(fetched.discord()).toHaveLength(1);
    expect(fetched.discord()[0]?.url).toContain("/messages/legacy-message");
    expect(put).toHaveBeenCalledTimes(1);

    expect(await handleGithubEvent("issues", edited, env, cfg)).toBe("unchanged starter issue");
    expect(fetched.discord()).toHaveLength(1);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("says no longer available for an issue closed as not planned, and brings it back on reopen", async () => {
    const fetched = mockFetch();
    expect(await handleGithubEvent("issues", issueEvent("labeled", {}, "good first issue"), env, cfg)).toBe("posted starter issue");

    const notPlanned = issueEvent("closed", { state: "closed", state_reason: "not_planned" });
    expect(await handleGithubEvent("issues", notPlanned, env, cfg)).toBe("updated starter issue (unavailable)");
    expect(fetched.discord()[1]?.body.embeds[0].description).toContain("No longer available.");

    const reopened = issueEvent("reopened", { state_reason: "reopened" });
    expect(await handleGithubEvent("issues", reopened, env, cfg)).toBe("updated starter issue (open)");

    const claimed = issueEvent("assigned", { assignees: [{ login: "ada" }], state_reason: "reopened" });
    expect(await handleGithubEvent("issues", claimed, env, cfg)).toBe("updated starter issue (claimed)");

    const completed = issueEvent("closed", { state: "closed", state_reason: "completed", assignees: [{ login: "ada" }] });
    expect(await handleGithubEvent("issues", completed, env, cfg)).toBe("updated starter issue (done)");
    expect(fetched.discord()[4]?.body.embeds[0].description).toContain("Done.");
  });

  it("does not post on opened (labeled follows), for other labels, or for issues that aren't free", async () => {
    const fetched = mockFetch();
    expect(await handleGithubEvent("issues", issueEvent("opened"), env, cfg)).toBe("ignored issue");
    expect(await handleGithubEvent("issues", issueEvent("labeled", {}, "bug"), env, cfg)).toBe("ignored issue");
    expect(await handleGithubEvent("issues", issueEvent("labeled", { assignees: [{ login: "ada" }] }, "good first issue"), env, cfg)).toBe("ignored issue");
    expect(await handleGithubEvent("issues", issueEvent("labeled", { labels: [{ name: "good first issue" }, { name: "blocked" }] }, "good first issue"), env, cfg)).toBe("ignored issue");
    expect(await handleGithubEvent("issues", issueEvent("labeled", { pull_request: {} }, "good first issue"), env, cfg)).toBe("ignored issue");
    expect(fetched.discord()).toHaveLength(0);
  });

  it("announces an older starter issue when it becomes free again", async () => {
    const fetched = mockFetch();
    expect(await handleGithubEvent("issues", issueEvent("unassigned"), env, cfg)).toBe("posted starter issue");
    expect(fetched.discord()).toHaveLength(1);
  });

  it("posts an issue once when blocked is removed and it has no message yet", async () => {
    const fetched = mockFetch();
    const unblocked = issueEvent("unlabeled", {}, "Blocked");
    expect(await handleGithubEvent("issues", unblocked, env, cfg)).toBe("posted starter issue");
    expect(fetched.discord()).toHaveLength(1);
    expect(fetched.discord()[0]?.body.embeds[0].description).toContain("Comment on the issue to claim it");
    expect(await handleGithubEvent("issues", unblocked, env, cfg)).toBe("unchanged starter issue");
    expect(fetched.discord().filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("does not post when blocked is removed from an issue that isn't free", async () => {
    const fetched = mockFetch();
    const assigned = issueEvent("unlabeled", { assignees: [{ login: "ada" }] }, "blocked");
    expect(await handleGithubEvent("issues", assigned, env, cfg)).toBe("ignored issue");
    const closed = issueEvent("unlabeled", { state: "closed" }, "blocked");
    expect(await handleGithubEvent("issues", closed, env, cfg)).toBe("ignored issue");
    const notStarter = issueEvent("unlabeled", { labels: [{ name: "bug" }] }, "blocked");
    expect(await handleGithubEvent("issues", notStarter, env, cfg)).toBe("ignored issue");
    expect(fetched.discord()).toHaveLength(0);
  });

  it("ignores repos outside the configured list", async () => {
    const fetched = mockFetch();
    const other = { ...issueEvent("labeled", {}, "good first issue"), repository: { name: "secret-repo", owner: { login: "codercops" } } };
    expect(await handleGithubEvent("issues", other, env, cfg)).toBe("ignored issue");
    const fork = { ...issueEvent("labeled", {}, "good first issue"), repository: { name: "toolbelt", owner: { login: "someone" } } };
    expect(await handleGithubEvent("issues", fork, env, cfg)).toBe("ignored issue");
    expect(fetched.discord()).toHaveLength(0);
  });

  it("marks message unavailable when the last starter label is removed, and restores to open when restored", async () => {
    const fetched = mockFetch();
    expect(await handleGithubEvent("issues", issueEvent("labeled", {}, "good first issue"), env, cfg)).toBe("posted starter issue");

    // Remove good first issue label
    const unlabeled = issueEvent("unlabeled", { labels: [{ name: "bug" }] }, "good first issue");
    expect(await handleGithubEvent("issues", unlabeled, env, cfg)).toBe("updated starter issue (unavailable)");
    const unavailableEdit = fetched.discord()[1];
    expect(unavailableEdit).toMatchObject({ method: "PATCH", url: "https://discord.com/api/v10/channels/chan-issues/messages/msg-1" });
    expect(unavailableEdit?.body.embeds[0].description).toContain("No longer available.");
    expect(unavailableEdit?.body.embeds[0].description).not.toContain("Comment on the issue to claim it");
    expect(unavailableEdit?.body.embeds[0].color).toBe(0xf85149);

    // Restore starter label
    const relabeled = issueEvent("labeled", { labels: [{ name: "bug" }, { name: "good first issue" }] }, "good first issue");
    expect(await handleGithubEvent("issues", relabeled, env, cfg)).toBe("updated starter issue (open)");
    const openEdit = fetched.discord()[2];
    expect(openEdit?.body.embeds[0].description).toContain("Comment on the issue to claim it");
    expect(openEdit?.body.embeds[0].color).toBe(0x2ea043);
  });

  it("marks message unavailable when blocked is added, and restores to open when blocked is removed", async () => {
    const fetched = mockFetch();
    expect(await handleGithubEvent("issues", issueEvent("labeled", {}, "good first issue"), env, cfg)).toBe("posted starter issue");

    // Add blocked label
    const blocked = issueEvent("labeled", { labels: [{ name: "bug" }, { name: "good first issue" }, { name: "blocked" }] }, "blocked");
    expect(await handleGithubEvent("issues", blocked, env, cfg)).toBe("updated starter issue (unavailable)");
    const blockedEdit = fetched.discord()[1];
    expect(blockedEdit?.body.embeds[0].description).toContain("No longer available.");
    expect(blockedEdit?.body.embeds[0].color).toBe(0xf85149);

    // Remove blocked label
    const unblocked = issueEvent("unlabeled", { labels: [{ name: "bug" }, { name: "good first issue" }] }, "blocked");
    expect(await handleGithubEvent("issues", unblocked, env, cfg)).toBe("updated starter issue (open)");
    const unblockedEdit = fetched.discord()[2];
    expect(unblockedEdit?.body.embeds[0].description).toContain("Comment on the issue to claim it");
    expect(unblockedEdit?.body.embeds[0].color).toBe(0x2ea043);
  });

  it("restores to claimed state when recovering from unavailable if the issue is assigned", async () => {
    const fetched = mockFetch();
    expect(await handleGithubEvent("issues", issueEvent("labeled", {}, "good first issue"), env, cfg)).toBe("posted starter issue");

    // Assign to ada
    const claimed = issueEvent("assigned", { assignees: [{ login: "ada" }] });
    expect(await handleGithubEvent("issues", claimed, env, cfg)).toBe("updated starter issue (claimed)");

    // Add blocked label while assigned
    const blocked = issueEvent(
      "labeled",
      { assignees: [{ login: "ada" }], labels: [{ name: "bug" }, { name: "good first issue" }, { name: "blocked" }] },
      "blocked"
    );
    expect(await handleGithubEvent("issues", blocked, env, cfg)).toBe("updated starter issue (unavailable)");
    expect(fetched.discord()[2]?.body.embeds[0].description).toContain("No longer available.");

    // Remove blocked label -> recovers to claimed
    const unblocked = issueEvent(
      "unlabeled",
      { assignees: [{ login: "ada" }], labels: [{ name: "bug" }, { name: "good first issue" }] },
      "blocked"
    );
    expect(await handleGithubEvent("issues", unblocked, env, cfg)).toBe("updated starter issue (claimed)");
    expect(fetched.discord()[3]?.body.embeds[0].description).toContain("Claimed by ada.");
    expect(fetched.discord()[3]?.body.embeds[0].color).toBe(0x8b949e);

    // Remove last starter label while assigned
    const unlabeled = issueEvent("unlabeled", { assignees: [{ login: "ada" }], labels: [{ name: "bug" }] }, "good first issue");
    expect(await handleGithubEvent("issues", unlabeled, env, cfg)).toBe("updated starter issue (unavailable)");

    // Restore starter label -> recovers to claimed
    const relabeled = issueEvent(
      "labeled",
      { assignees: [{ login: "ada" }], labels: [{ name: "bug" }, { name: "good first issue" }] },
      "good first issue"
    );
    expect(await handleGithubEvent("issues", relabeled, env, cfg)).toBe("updated starter issue (claimed)");
    expect(fetched.discord()[5]?.body.embeds[0].description).toContain("Claimed by ada.");
  });

  it("marks message unavailable on deleted and transferred actions", async () => {
    const fetched = mockFetch();
    expect(await handleGithubEvent("issues", issueEvent("labeled", {}, "good first issue"), env, cfg)).toBe("posted starter issue");

    // Deleted
    expect(await handleGithubEvent("issues", issueEvent("deleted"), env, cfg)).toBe("updated starter issue (unavailable)");
    expect(fetched.discord()[1]?.body.embeds[0].description).toContain("No longer available.");
    expect(fetched.discord()[1]?.body.embeds[0].color).toBe(0xf85149);

    // Second issue for transferred
    const issue2 = issueEvent("labeled", { number: 125, title: "Second issue" }, "good first issue");
    expect(await handleGithubEvent("issues", issue2, env, cfg)).toBe("posted starter issue");
    expect(await handleGithubEvent("issues", issueEvent("transferred", { number: 125, title: "Second issue" }), env, cfg)).toBe(
      "updated starter issue (unavailable)"
    );
    expect(fetched.discord()[3]?.body.embeds[0].description).toContain("No longer available.");
    expect(fetched.discord()[3]?.body.embeds[0].color).toBe(0xf85149);
  });

  it("ignores deleted, transferred, and label changes for issues that never had a starter message", async () => {
    const fetched = mockFetch();
    expect(await handleGithubEvent("issues", issueEvent("unlabeled", { labels: [{ name: "bug" }] }, "good first issue"), env, cfg)).toBe("ignored issue");
    expect(await handleGithubEvent("issues", issueEvent("labeled", { labels: [{ name: "bug" }, { name: "blocked" }] }, "blocked"), env, cfg)).toBe("ignored issue");
    expect(await handleGithubEvent("issues", issueEvent("deleted", { labels: [{ name: "bug" }] }), env, cfg)).toBe("ignored issue");
    expect(await handleGithubEvent("issues", issueEvent("transferred", { labels: [{ name: "bug" }] }), env, cfg)).toBe("ignored issue");
    expect(await handleGithubEvent("issues", issueEvent("deleted"), env, cfg)).toBe("ignored issue");
    expect(await handleGithubEvent("issues", issueEvent("transferred"), env, cfg)).toBe("ignored issue");
    expect(fetched.discord()).toHaveLength(0);
  });
});

describe("releases", () => {
  const release = { name: "v0.6.2", tag_name: "v0.6.2", body: "Fixes", html_url: "https://github.com/codercops/toolbelt/releases/tag/v0.6.2", draft: false, prerelease: false };

  it("posts published releases to the releases channel", async () => {
    const fetched = mockFetch();
    expect(await handleGithubEvent("release", { action: "published", repository, release }, env, cfg)).toBe("posted release");
    expect(fetched.discord()[0]?.url).toBe("https://discord.com/api/v10/channels/chan-releases/messages");
    expect(fetched.discord()[0]?.body.embeds[0].title).toBe("toolbelt v0.6.2");
  });

  it("ignores drafts, prereleases and other actions", async () => {
    const fetched = mockFetch();
    await handleGithubEvent("release", { action: "created", repository, release }, env, cfg);
    await handleGithubEvent("release", { action: "published", repository, release: { ...release, draft: true } }, env, cfg);
    await handleGithubEvent("release", { action: "published", repository, release: { ...release, prerelease: true } }, env, cfg);
    expect(fetched.discord()).toHaveLength(0);
  });
});

describe("merged pull requests", () => {
  const prEvent = (over: Record<string, unknown> = {}, user = { login: "ada", type: "User" }) => ({
    action: "closed",
    repository,
    pull_request: {
      number: 139,
      title: "fix(url-encoder): show an error",
      html_url: "https://github.com/codercops/toolbelt/pull/139",
      repository_url: "https://api.github.com/repos/codercops/toolbelt",
      merged: true,
      merged_at: "2026-10-11T16:20:00Z",
      user,
      labels: [{ name: "hacktoberfest-accepted" }],
      ...over,
    },
  });

  it("posts a shoutout with the author's running count, counting this PR even if search lags", async () => {
    // Search already knows two earlier PRs by ada and one by bob, but not #139 yet.
    const fetched = mockFetch(() => ({
      total_count: 3,
      items: [
        { html_url: "https://github.com/codercops/toolbelt/pull/1", number: 1, title: "Fix a thing", repository_url: "https://api.github.com/repos/codercops/toolbelt", user: { login: "ada" }, pull_request: { merged_at: "2026-10-02T00:00:00Z" } },
        { html_url: "https://github.com/codercops/chatcops/pull/2", number: 1, title: "Fix a thing", repository_url: "https://api.github.com/repos/codercops/toolbelt", user: { login: "Ada" }, pull_request: { merged_at: "2026-10-03T00:00:00Z" } },
        { html_url: "https://github.com/codercops/ogcops/pull/3", number: 1, title: "Fix a thing", repository_url: "https://api.github.com/repos/codercops/toolbelt", user: { login: "bob" }, pull_request: { merged_at: "2026-10-04T00:00:00Z" } },
      ],
    }));
    expect(await handleGithubEvent("pull_request", prEvent(), env, cfg)).toBe("posted merged pull request");
    const post = fetched.discord()[0];
    expect(post?.url).toBe("https://discord.com/api/v10/channels/chan-merged/messages");
    expect(post?.body.embeds[0].description).toContain("That's their 3rd merged PR on the Hacktoberfest 2026 leaderboard.");
    expect(fetched.calls.filter((c) => c.url.startsWith("https://api.github.com/"))).toHaveLength(1);
    const cached = JSON.parse(env.STATE.store.get("leaderboard:v3:2026-10") ?? "{}");
    expect(cached.rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ login: "ada", count: 3 }), expect.objectContaining({ login: "bob", count: 1 })])
    );
  });

  it("doesn't double count when search already includes this PR", async () => {
    const fetched = mockFetch(() => ({
      total_count: 1,
      items: [{ html_url: "https://github.com/codercops/toolbelt/pull/139", number: 1, title: "Fix a thing", repository_url: "https://api.github.com/repos/codercops/toolbelt", user: { login: "ada" }, pull_request: { merged_at: "2026-10-11T16:20:00Z" } }],
    }));
    await handleGithubEvent("pull_request", prEvent(), env, cfg);
    expect(fetched.discord()[0]?.body.embeds[0].description).toContain("That's their 1st merged PR");
    const cached = JSON.parse(env.STATE.store.get("leaderboard:v3:2026-10") ?? "{}");
    expect(cached.rows).toEqual([expect.objectContaining({ login: "ada", count: 1 })]);
  });

  it("clears the cached leaderboard and still posts a shoutout when search fails", async () => {
    await env.STATE.put("leaderboard:v3:2026-10", JSON.stringify({ rows: [], generatedAt: "earlier" }));
    const fetched = mockFetch(() => new Response("unavailable", { status: 503 }));
    await handleGithubEvent("pull_request", prEvent(), env, cfg);
    expect(env.STATE.store.has("leaderboard:v3:2026-10")).toBe(false);
    expect(fetched.discord()).toHaveLength(1);
    expect(fetched.discord()[0]?.body.embeds[0].description).not.toContain("That's their");
  });

  it("counts a PR merged seconds earlier that search hasn't indexed yet", async () => {
    // Search knows three earlier PRs by ada, and neither #139 nor #140 when they are merged five seconds apart.
    const earlier = Array.from({ length: 3 }, (_, i) => ({
      html_url: `https://github.com/codercops/toolbelt/pull/${i + 1}`,
      number: i + 1,
      title: "Fix a thing",
      repository_url: "https://api.github.com/repos/codercops/toolbelt",
      user: { login: "ada" },
      pull_request: { merged_at: `2026-10-0${i + 1}T00:00:00Z` },
    }));
    const fetched = mockFetch(() => ({ total_count: 3, items: earlier }));
    await handleGithubEvent("pull_request", prEvent(), env, cfg);
    await handleGithubEvent(
      "pull_request",
      prEvent({ number: 140, html_url: "https://github.com/codercops/toolbelt/pull/140", merged_at: "2026-10-11T16:20:05Z" }),
      env,
      cfg
    );
    const [first, second] = fetched.discord().map((d) => d.body.embeds[0].description as string);
    expect(first).toContain("That's their 4th merged PR");
    expect(second).toContain("That's their 5th merged PR");
    expect(second).toContain("With 5 they now qualify");
    const cached = JSON.parse(env.STATE.store.get("leaderboard:v3:2026-10") ?? "{}");
    expect(cached.rows).toEqual([expect.objectContaining({ login: "ada", count: 5 })]);
  });

  it.each([
    { earlierCount: 3, laterCount: 5, lateCount: 4, qualifyingPr: "140" },
    { earlierCount: 4, laterCount: 6, lateCount: 5, qualifyingPr: "139" },
  ])(
    "uses merge time for late events with $earlierCount earlier PRs and qualifies only on #$qualifyingPr",
    async ({ earlierCount, laterCount, lateCount, qualifyingPr }) => {
      const earlier = Array.from({ length: earlierCount }, (_, i) => ({
        html_url: `https://github.com/codercops/toolbelt/pull/${i + 1}`,
        number: i + 1,
        title: "Fix an earlier thing",
        repository_url: "https://api.github.com/repos/codercops/toolbelt",
        user: { login: "ada" },
        pull_request: { merged_at: `2026-10-0${i + 1}T00:00:00Z` },
      }));
      const pr139 = {
        html_url: "https://github.com/codercops/toolbelt/pull/139",
        number: 139,
        title: "Fix the earlier merge",
        repository_url: "https://api.github.com/repos/codercops/toolbelt",
        user: { login: "ada" },
        pull_request: { merged_at: "2026-10-11T16:20:00Z" },
      };
      const pr140 = {
        html_url: "https://github.com/codercops/toolbelt/pull/140",
        number: 140,
        title: "Fix the later merge",
        repository_url: "https://api.github.com/repos/codercops/toolbelt",
        user: { login: "ada" },
        pull_request: { merged_at: "2026-10-11T16:20:14Z" },
      };
      const fetched = mockFetch(() => ({ total_count: earlier.length + 2, items: [...earlier, pr139, pr140] }));

      // #140 is handled on time, before #139's delayed webhook arrives.
      await handleGithubEvent(
        "pull_request",
        prEvent({ number: 140, html_url: pr140.html_url, merged_at: pr140.pull_request.merged_at }),
        env,
        cfg
      );
      // #139 merged first, but its event arrives after #140 has already merged.
      await handleGithubEvent("pull_request", prEvent(), env, cfg);

      const descriptions = fetched.discord().map((d) => d.body.embeds[0].description as string);
      expect(descriptions[0]).toContain(`That's their ${laterCount}th merged PR`);
      expect(descriptions[1]).toContain(`That's their ${lateCount}th merged PR`);
      expect(descriptions.filter((description) => description.includes("they now qualify"))).toHaveLength(1);
      const qualifyingIndex = qualifyingPr === "139" ? 1 : 0;
      expect(descriptions[qualifyingIndex]).toContain("they now qualify");
      expect(descriptions[1 - qualifyingIndex]).not.toContain("they now qualify");
      expect(descriptions[qualifyingIndex]).toContain(`That's their ${qualifyingPr === "139" ? lateCount : laterCount}th merged PR`);

      // The board still caches all merges, including #140 when #139's late event is handled.
      const cached = JSON.parse(env.STATE.store.get("leaderboard:v3:2026-10") ?? "{}");
      expect(cached.rows).toEqual([expect.objectContaining({ login: "ada", count: earlierCount + 2 })]);
    }
  );

  it("leaves the count out and keeps the board when search comes back empty after the board had rows", async () => {
    mockFetch(() => ({
      total_count: 1,
      items: [{ html_url: "https://github.com/codercops/toolbelt/pull/1", number: 1, title: "Fix a thing", repository_url: "https://api.github.com/repos/codercops/toolbelt", user: { login: "ada" }, pull_request: { merged_at: "2026-10-02T00:00:00Z" } }],
    }));
    await handleGithubEvent("pull_request", prEvent(), env, cfg);
    const lastGood = env.STATE.store.get("leaderboard:last:2026-10");
    expect(lastGood).toBeDefined();

    // During an outage GitHub's search answered 0 without flagging the results as incomplete.
    const fetched = mockFetch(() => ({ total_count: 0, items: [] }));
    await handleGithubEvent(
      "pull_request",
      prEvent({ number: 140, html_url: "https://github.com/codercops/toolbelt/pull/140", merged_at: "2026-10-11T17:00:00Z" }),
      env,
      cfg
    );
    const description = fetched.discord()[0]?.body.embeds[0].description as string;
    expect(description).toContain("got a PR merged");
    expect(description).not.toContain("That's their");
    expect(env.STATE.store.get("leaderboard:last:2026-10")).toBe(lastGood);
    expect(env.STATE.store.has("leaderboard:v3:2026-10")).toBe(false);
  });

  it("drops a remembered merge once search has indexed it", async () => {
    const pr139 = {
      html_url: "https://github.com/codercops/toolbelt/pull/139",
      number: 139,
      title: "Fix a thing",
      repository_url: "https://api.github.com/repos/codercops/toolbelt",
      user: { login: "ada" },
      pull_request: { merged_at: "2026-10-11T16:20:00Z" },
    };
    let indexed: (typeof pr139)[] = [];
    const fetched = mockFetch(() => ({ total_count: indexed.length, items: indexed }));
    await handleGithubEvent("pull_request", prEvent(), env, cfg);
    expect(JSON.parse(env.STATE.store.get("recent-merges:2026-10") ?? "[]")).toHaveLength(1);
    indexed = [pr139];
    await handleGithubEvent(
      "pull_request",
      prEvent({ number: 140, html_url: "https://github.com/codercops/toolbelt/pull/140", merged_at: "2026-10-11T16:30:00Z" }),
      env,
      cfg
    );
    expect(JSON.parse(env.STATE.store.get("recent-merges:2026-10") ?? "[]")).toEqual([
      expect.objectContaining({ url: "https://github.com/codercops/toolbelt/pull/140" }),
    ]);
    // #139 was in search and in KV at once, and still counts once.
    expect(fetched.discord()[1]?.body.embeds[0].description).toContain("That's their 2nd merged PR");
  });

  it("says they qualify on the merge that reaches the minimum, and only on that one", async () => {
    const earlier = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        html_url: `https://github.com/codercops/toolbelt/pull/${i + 1}`,
        user: { login: "ada" },
        number: 1, 
        title: "Fix a thing", 
        repository_url: "https://api.github.com/repos/codercops/toolbelt",
        pull_request: { merged_at: `2026-10-0${i + 1}T00:00:00Z` },
      }));
    const description = async (others: number) => {
      const fetched = mockFetch(() => ({ total_count: others, items: earlier(others) }));
      await handleGithubEvent("pull_request", prEvent(), env, cfg);
      return fetched.discord()[0]?.body.embeds[0].description as string;
    };
    expect(await description(3)).not.toContain("qualify");
    const fifth = await description(4);
    expect(fifth).toContain("That's their 5th merged PR");
    expect(fifth).toContain(
      "With 5 they now qualify for a CODERCOPS T-shirt and stickers, which goes to the top 5 when the program ends. This swag comes from CODERCOPS, separate from Hacktoberfest."
    );
    expect(await description(5)).not.toContain("qualify");
  });

  it("searches only our repos, the event label and the event window", async () => {
    const fetched = mockFetch();
    await handleGithubEvent("pull_request", prEvent(), env, cfg);
    const search = fetched.calls.find((c) => c.url.includes("/search/issues"));
    const q = new URL(search!.url).searchParams.get("q");
    expect(q).toBe(
      'is:pr is:merged label:"hacktoberfest-accepted" merged:2026-10-01T00:00:00Z..2026-10-31T23:59:59Z repo:codercops/chatcops repo:codercops/ogcops repo:codercops/toolbelt'
    );
  });

  it("still posts, without a count, for PRs that don't count toward the leaderboard", async () => {
    const fetched = mockFetch();
    await handleGithubEvent("pull_request", prEvent({ labels: [] }), env, cfg);
    await handleGithubEvent("pull_request", prEvent({ merged_at: "2026-11-02T00:00:00Z" }), env, cfg);
    expect(fetched.calls.some((c) => c.url.includes("api.github.com"))).toBe(false);
    expect(fetched.discord()).toHaveLength(2);
    expect(fetched.discord()[0]?.body.embeds[0].description).not.toContain("That's their");
  });

  describe("when linking is on", () => {
    const newHere = "New here? Run `/link` in this server to connect your GitHub account and get the Contributor role.";
    const winnersDm = "Winners are contacted by Discord DM, so run `/link` in this server to tell us which Discord account is yours.";
    const earlier = (n: number) => () => ({
      total_count: n,
      items: Array.from({ length: n }, (_, i) => ({
        html_url: `https://github.com/codercops/toolbelt/pull/${i + 1}`,
        user: { login: "ada" },
        number: i + 1,
        title: "Fix a thing",
        repository_url: "https://api.github.com/repos/codercops/toolbelt",
        pull_request: { merged_at: `2026-10-0${i + 1}T00:00:00Z` },
      })),
    });
    const shoutout = async (others: number, event = prEvent()) => {
      env = makeEnv({ LINKING: "on", DISCORD_CLIENT_SECRET: "client-secret" });
      cfg = getConfig(env);
      const fetched = mockFetch(earlier(others));
      await handleGithubEvent("pull_request", event, env, cfg);
      return (fetched.discord()[0]?.body.embeds[0].description as string).split("\n");
    };

    it("asks an unlinked author to run /link on their first counted PR", async () => {
      expect((await shoutout(0)).at(-1)).toBe(newHere);
    });

    it("asks again, after the qualify line, on the merge that reaches the minimum", async () => {
      const lines = await shoutout(4);
      expect(lines.at(-2)).toContain("With 5 they now qualify");
      expect(lines.at(-1)).toBe(winnersDm);
    });

    it("says nothing about /link for other counts or PRs that don't count", async () => {
      for (const lines of [await shoutout(1), await shoutout(5), await shoutout(0, prEvent({ labels: [] }))]) {
        expect(lines.some((l) => l.includes("/link"))).toBe(false);
      }
    });
  });

  it("says nothing about /link when linking is off", async () => {
    const fetched = mockFetch();
    await handleGithubEvent("pull_request", prEvent(), env, cfg);
    const description = fetched.discord()[0]?.body.embeds[0].description as string;
    expect(description).toContain("That's their 1st merged PR");
    expect(description).not.toContain("/link");
  });

  it("skips bots, maintainers, unmerged PRs and other actions", async () => {
    const fetched = mockFetch();
    await handleGithubEvent("pull_request", prEvent({}, { login: "dependabot[bot]", type: "Bot" }), env, cfg);
    await handleGithubEvent("pull_request", prEvent({}, { login: "Anurag629", type: "User" }), env, cfg);
    await handleGithubEvent("pull_request", prEvent({ merged: false }), env, cfg);
    await handleGithubEvent("pull_request", { ...prEvent(), action: "opened" }, env, cfg);
    expect(fetched.discord()).toHaveLength(0);
  });
});

const rateLimit = () => new Response(JSON.stringify({ retry_after: 30 }), { status: 429 });
const onGithub = (over: Record<string, unknown> = {}) => () => ({ ...issueEvent("edited").issue, ...over });

describe("rate limited starter issue feed", () => {
  it("marks the issue instead of failing when Discord answers 429, and the cron posts it", async () => {
    mockFetch(undefined, rateLimit);
    expect(await handleGithubEvent("issues", issueEvent("labeled", {}, "good first issue"), env, cfg)).toBe(
      "starter issue rate limited, resync queued"
    );
    expect(await env.STATE.get("resync:toolbelt#124")).toBe("1");
    expect(await env.STATE.get("issue:toolbelt#124")).toBeNull();

    const fetched = mockFetch(onGithub());
    await resyncStarterIssues(env, cfg);
    expect(fetched.calls[0]?.url).toBe("https://api.github.com/repos/codercops/toolbelt/issues/124");
    expect(fetched.discord()).toHaveLength(1);
    expect(fetched.discord()[0]?.method).toBe("POST");
    expect(await env.STATE.get("resync:toolbelt#124")).toBeNull();
    expect(await env.STATE.get("issue:toolbelt#124", "json")).toMatchObject({ messageId: "msg-1", state: "open" });
  });

  it("edits the message to the issue's state on GitHub, not the state of the lost event", async () => {
    mockFetch();
    await handleGithubEvent("issues", issueEvent("labeled", {}, "good first issue"), env, cfg);
    mockFetch(undefined, rateLimit);
    expect(await handleGithubEvent("issues", issueEvent("assigned", { assignees: [{ login: "ada" }] }), env, cfg)).toBe(
      "starter issue rate limited, resync queued"
    );

    // By the next run the issue was closed on GitHub.
    const fetched = mockFetch(onGithub({ state: "closed", state_reason: "completed", assignees: [{ login: "ada" }] }));
    await resyncStarterIssues(env, cfg);
    expect(fetched.discord()).toHaveLength(1);
    expect(fetched.discord()[0]?.method).toBe("PATCH");
    expect(fetched.discord()[0]?.url).toContain("/messages/msg-1");
    expect(await env.STATE.get("issue:toolbelt#124", "json")).toMatchObject({ messageId: "msg-1", state: "done" });
    expect(await env.STATE.get("resync:toolbelt#124")).toBeNull();
  });

  it("doesn't undo a newer update that already went through", async () => {
    mockFetch();
    await handleGithubEvent("issues", issueEvent("labeled", {}, "good first issue"), env, cfg);
    mockFetch(undefined, rateLimit);
    await handleGithubEvent("issues", issueEvent("assigned", { assignees: [{ login: "ada" }] }), env, cfg);
    mockFetch();
    expect(await handleGithubEvent("issues", issueEvent("unassigned"), env, cfg)).toBe("unchanged starter issue");
    const claimed = mockFetch();
    await handleGithubEvent("issues", issueEvent("assigned", { assignees: [{ login: "bob" }] }), env, cfg);
    expect(claimed.discord()).toHaveLength(1);

    const fetched = mockFetch(onGithub({ assignees: [{ login: "bob" }] }));
    await resyncStarterIssues(env, cfg);
    expect(fetched.discord()).toHaveLength(0);
    expect(await env.STATE.get("issue:toolbelt#124", "json")).toMatchObject({ state: "claimed" });
    expect(await env.STATE.get("resync:toolbelt#124")).toBeNull();
  });

  it("keeps the mark when the resync is rate limited too", async () => {
    await env.STATE.put("resync:toolbelt#124", "1");
    await env.STATE.put("resync:toolbelt#125", "1");
    const fetched = mockFetch(onGithub(), rateLimit);
    await resyncStarterIssues(env, cfg);
    // The channel is still limited, so the second issue isn't tried this run.
    expect(fetched.discord()).toHaveLength(1);
    expect(await env.STATE.get("resync:toolbelt#124")).toBe("1");
    expect(await env.STATE.get("resync:toolbelt#125")).toBe("1");
  });

  it("does a few per run, and costs one list when nothing is marked", async () => {
    for (let n = 1; n <= 7; n++) await env.STATE.put(`resync:toolbelt#${n}`, "1");
    const fetched = mockFetch((url) => ({ ...issueEvent("edited").issue, number: Number(url.pathname.split("/").pop()) }));
    await resyncStarterIssues(env, cfg);
    expect(fetched.discord()).toHaveLength(5);
    expect((await env.STATE.list({ prefix: "resync:" })).keys).toHaveLength(2);

    await resyncStarterIssues(env, cfg);
    fetched.clear();
    const get = vi.spyOn(env.STATE, "get");
    const list = vi.spyOn(env.STATE, "list");
    await resyncStarterIssues(env, cfg);
    expect(list).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
    expect(fetched.calls).toHaveLength(0);
  });

  it("lets other Discord errors fail the webhook as before", async () => {
    mockFetch(undefined, () => new Response("{}", { status: 500 }));
    await expect(handleGithubEvent("issues", issueEvent("labeled", {}, "good first issue"), env, cfg)).rejects.toThrow("Discord 500");
    expect(await env.STATE.get("resync:toolbelt#124")).toBeNull();
  });
});

describe("deleted starter issue message", () => {
  const unknownMessage = (call: RecordedCall) => (call.method === "PATCH" ? new Response(JSON.stringify({ message: "Unknown Message", code: 10008 }), { status: 404 }) : undefined);
  const storeRecord = (state: string) => env.STATE.put("issue:toolbelt#124", JSON.stringify({ messageId: "deleted-msg", state, message: "old" }));
  const record = () => env.STATE.get("issue:toolbelt#124", "json");

  it("posts a new message when the issue is free, and edits that one next time", async () => {
    await storeRecord("claimed");
    const fetched = mockFetch(undefined, unknownMessage);
    expect(await handleGithubEvent("issues", issueEvent("unassigned"), env, cfg)).toBe("posted starter issue");
    expect(fetched.discord().map((c) => `${c.method} ${c.url}`)).toEqual(["PATCH https://discord.com/api/v10/channels/chan-issues/messages/deleted-msg", "POST https://discord.com/api/v10/channels/chan-issues/messages"]);
    expect(await record()).toMatchObject({ messageId: "msg-1", state: "open" });

    const next = mockFetch();
    expect(await handleGithubEvent("issues", issueEvent("assigned", { assignees: [{ login: "ada" }] }), env, cfg)).toBe("updated starter issue (claimed)");
    expect(next.discord()).toHaveLength(1);
    expect(next.discord()[0]).toMatchObject({ method: "PATCH", url: "https://discord.com/api/v10/channels/chan-issues/messages/msg-1" });
  });

  it("removes the record when the issue isn't free, and posts again once it is", async () => {
    await storeRecord("open");
    const fetched = mockFetch(undefined, unknownMessage);
    expect(await handleGithubEvent("issues", issueEvent("assigned", { assignees: [{ login: "ada" }] }), env, cfg)).toBe("starter issue message gone, record removed");
    expect(fetched.discord()).toHaveLength(1);
    expect(await record()).toBeNull();

    expect(await handleGithubEvent("issues", issueEvent("edited", { title: "New title", assignees: [{ login: "ada" }] }), env, cfg)).toBe("ignored issue");
    expect(await handleGithubEvent("issues", issueEvent("unassigned"), env, cfg)).toBe("posted starter issue");
    expect(fetched.discord().filter((c) => c.method === "POST")).toHaveLength(1);
    expect(await record()).toMatchObject({ messageId: "msg-1", state: "open" });
  });

  it("removes the record when the issue is done or no longer available", async () => {
    for (const closed of [issueEvent("closed", { state: "closed" }), issueEvent("closed", { state: "closed", state_reason: "not_planned" }), issueEvent("deleted")]) {
      await storeRecord("open");
      const fetched = mockFetch(undefined, unknownMessage);
      expect(await handleGithubEvent("issues", closed, env, cfg)).toBe("starter issue message gone, record removed");
      expect(fetched.discord()).toHaveLength(1);
      expect(await record()).toBeNull();
    }
  });

  it("posts a new message from the resync when the issue is free", async () => {
    await storeRecord("claimed");
    await env.STATE.put("resync:toolbelt#124", "1");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetched = mockFetch(onGithub(), unknownMessage);
    await resyncStarterIssues(env, cfg);
    expect(fetched.discord().map((c) => c.method)).toEqual(["PATCH", "POST"]);
    expect(await record()).toMatchObject({ messageId: "msg-1", state: "open" });
    expect(await env.STATE.get("resync:toolbelt#124")).toBeNull();
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("removes the record from the resync when the issue isn't free", async () => {
    await storeRecord("open");
    await env.STATE.put("resync:toolbelt#124", "1");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetched = mockFetch(onGithub({ assignees: [{ login: "ada" }] }), unknownMessage);
    await resyncStarterIssues(env, cfg);
    expect(fetched.discord().map((c) => c.method)).toEqual(["PATCH"]);
    expect(await record()).toBeNull();
    expect(await env.STATE.get("resync:toolbelt#124")).toBeNull();
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("queues a resync when the new post is rate limited, and the cron posts it", async () => {
    await storeRecord("claimed");
    mockFetch(undefined, (call) => unknownMessage(call) ?? rateLimit());
    expect(await handleGithubEvent("issues", issueEvent("unassigned"), env, cfg)).toBe("starter issue rate limited, resync queued");
    expect(await env.STATE.get("resync:toolbelt#124")).toBe("1");
    expect(await record()).toMatchObject({ messageId: "deleted-msg" });

    mockFetch(onGithub(), unknownMessage);
    await resyncStarterIssues(env, cfg);
    expect(await record()).toMatchObject({ messageId: "msg-1", state: "open" });
    expect(await env.STATE.get("resync:toolbelt#124")).toBeNull();
  });

  it("posts the issue as it is now and skips the next unchanged event", async () => {
    await env.STATE.put("issue:toolbelt#124", JSON.stringify({ messageId: "deleted-msg", state: "open" }));
    const fetched = mockFetch(undefined, unknownMessage);
    const edited = issueEvent("edited", { title: "Updated title" });
    expect(await handleGithubEvent("issues", edited, env, cfg)).toBe("posted starter issue");
    const post = fetched.discord()[1];
    expect(post?.method).toBe("POST");
    expect(post?.body.embeds[0].title).toContain("Updated title");
    expect(post?.body.embeds[0].description).toContain("Comment on the issue to claim it");
    expect(post?.body.allowed_mentions).toEqual({ parse: [] });

    expect(await handleGithubEvent("issues", edited, env, cfg)).toBe("unchanged starter issue");
    expect(fetched.discord()).toHaveLength(2);
  });

  it("keeps going with the other marked issues in the resync", async () => {
    await storeRecord("open");
    await env.STATE.put("issue:toolbelt#125", JSON.stringify({ messageId: "live-msg", state: "open", message: "old" }));
    await env.STATE.put("resync:toolbelt#124", "1");
    await env.STATE.put("resync:toolbelt#125", "1");
    const fetched = mockFetch((url) => ({ ...issueEvent("edited").issue, number: Number(url.pathname.split("/").pop()), assignees: [{ login: "ada" }] }), (call) => (call.url.endsWith("/deleted-msg") ? unknownMessage(call) : undefined));
    await resyncStarterIssues(env, cfg);
    expect(fetched.discord().map((c) => c.url.split("/").pop())).toEqual(["deleted-msg", "live-msg"]);
    expect(await record()).toBeNull();
    expect(await env.STATE.get("issue:toolbelt#125", "json")).toMatchObject({ messageId: "live-msg", state: "claimed" });
    expect((await env.STATE.list({ prefix: "resync:" })).keys).toHaveLength(0);
  });

  it("fails as before when the new post fails too", async () => {
    await storeRecord("claimed");
    const fetched = mockFetch(undefined, () => new Response(JSON.stringify({ message: "Unknown Channel", code: 10003 }), { status: 404 }));
    await expect(handleGithubEvent("issues", issueEvent("unassigned"), env, cfg)).rejects.toThrow("Discord 404");
    expect(fetched.discord().map((c) => c.method)).toEqual(["PATCH", "POST"]);
    expect(await record()).toMatchObject({ messageId: "deleted-msg", state: "claimed" });
  });

  it("lets other Discord errors on the edit fail as before", async () => {
    for (const status of [500, 403, 401]) {
      await storeRecord("claimed");
      const fetched = mockFetch(undefined, (call) => (call.method === "PATCH" ? new Response("{}", { status }) : undefined));
      await expect(handleGithubEvent("issues", issueEvent("unassigned"), env, cfg)).rejects.toThrow(`Discord ${status}`);
      expect(fetched.discord().map((c) => c.method)).toEqual(["PATCH"]);
      expect(await record()).toMatchObject({ messageId: "deleted-msg", state: "claimed" });
      expect(await env.STATE.get("resync:toolbelt#124")).toBeNull();
    }
  });

  it("lets a network error on the edit fail as before", async () => {
    await storeRecord("claimed");
    const fetched = mockFetch(undefined, () => {
      throw new TypeError("fetch failed");
    });
    await expect(handleGithubEvent("issues", issueEvent("unassigned"), env, cfg)).rejects.toThrow("fetch failed");
    expect(fetched.discord()).toHaveLength(1);
    expect(await record()).toMatchObject({ messageId: "deleted-msg", state: "claimed" });
  });
});

describe("other events", () => {
  it("answers ping and ignores events it doesn't handle", async () => {
    mockFetch();
    expect(await handleGithubEvent("ping", { zen: "hi" }, env, cfg)).toBe("pong");
    expect(await handleGithubEvent("star", {}, env, cfg)).toBe("ignored event star");
  });
});
