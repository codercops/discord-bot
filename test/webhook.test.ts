import { beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig } from "../src/config";
import { handleGithubEvent, isStarterIssue, starterState } from "../src/webhook";
import { makeEnv, mockFetch } from "./helpers";

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
    expect(await handleGithubEvent("issues", issueEvent("labeled", { labels: [{ name: "bug" }, { name: "good first issue" }, { name: "help wanted" }] }, "help wanted")).toBe("updated starter issue (open)");
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
        { html_url: "https://github.com/codercops/toolbelt/pull/1", user: { login: "ada" }, pull_request: { merged_at: "2026-10-02T00:00:00Z" } },
        { html_url: "https://github.com/codercops/chatcops/pull/2", user: { login: "Ada" }, pull_request: { merged_at: "2026-10-03T00:00:00Z" } },
        { html_url: "https://github.com/codercops/ogcops/pull/3", user: { login: "bob" }, pull_request: { merged_at: "2026-10-04T00:00:00Z" } },
      ],
    }));
    expect(await handleGithubEvent("pull_request", prEvent(), env, cfg)).toBe("posted merged pull request");
    const post = fetched.discord()[0];
    expect(post?.url).toBe("https://discord.com/api/v10/channels/chan-merged/messages");
    expect(post?.body.embeds[0].description).toContain("That's their 3rd merged PR on the Hacktoberfest 2026 leaderboard.");
  });

  it("doesn't double count when search already includes this PR", async () => {
    const fetched = mockFetch(() => ({
      total_count: 1,
      items: [{ html_url: "https://github.com/codercops/toolbelt/pull/139", user: { login: "ada" }, pull_request: { merged_at: "2026-10-11T16:20:00Z" } }],
    }));
    await handleGithubEvent("pull_request", prEvent(), env, cfg);
    expect(fetched.discord()[0]?.body.embeds[0].description).toContain("That's their 1st merged PR");
  });

  it("says they qualify on the merge that reaches the minimum, and only on that one", async () => {
    const earlier = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        html_url: `https://github.com/codercops/toolbelt/pull/${i + 1}`,
        user: { login: "ada" },
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

  it("skips bots, maintainers, unmerged PRs and other actions", async () => {
    const fetched = mockFetch();
    await handleGithubEvent("pull_request", prEvent({}, { login: "dependabot[bot]", type: "Bot" }), env, cfg);
    await handleGithubEvent("pull_request", prEvent({}, { login: "Anurag629", type: "User" }), env, cfg);
    await handleGithubEvent("pull_request", prEvent({ merged: false }), env, cfg);
    await handleGithubEvent("pull_request", { ...prEvent(), action: "opened" }, env, cfg);
    expect(fetched.discord()).toHaveLength(0);
  });
});

describe("other events", () => {
  it("answers ping and ignores events it doesn't handle", async () => {
    mockFetch();
    expect(await handleGithubEvent("ping", { zen: "hi" }, env, cfg)).toBe("pong");
    expect(await handleGithubEvent("star", {}, env, cfg)).toBe("ignored event star");
  });
});
