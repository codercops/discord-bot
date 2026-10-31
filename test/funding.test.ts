import { describe, expect, it } from "vitest";
import { manifest, MANIFEST_URL, MANIFEST_URLS, MIRROR_URL } from "../src/funding";
import worker from "../src/index";
import { makeEnv } from "./helpers";

// The limits below come from the funding.json v1.1.0 schema (https://fundingjson.org).
const GUID = /^[a-z0-9-]{1,32}$/;
const TAG = /^[a-z0-9-]{1,32}$/;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

describe("funding manifest", () => {
  it("has the fields the schema requires", () => {
    const { entity } = manifest;
    expect(["individual", "group", "organisation", "other"]).toContain(entity.type);
    expect(["owner", "steward", "maintainer", "contributor", "other"]).toContain(entity.role);
    expect(entity.description.length).toBeLessThanOrEqual(2000);
    expect(entity.webpageUrl.url).toBe(new URL(MANIFEST_URL).origin);
  });

  it("gives every project a valid guid, an SPDX license and up to 10 tags", () => {
    const guids = manifest.projects.map((p) => p.guid);
    expect(new Set(guids).size).toBe(guids.length);
    for (const p of manifest.projects) {
      expect(p.guid).toMatch(GUID);
      expect(p.description.length).toBeLessThanOrEqual(2000);
      expect(p.licenses.every((l) => l.startsWith("spdx:"))).toBe(true);
      expect(p.tags.length).toBeLessThanOrEqual(10);
      for (const tag of p.tags) expect(tag).toMatch(TAG);
    }
  });

  it("proves every URL with a well-known file, so the GitHub copy verifies too", () => {
    const links = [manifest.entity.webpageUrl, ...manifest.projects.flatMap((p) => [p.webpageUrl, p.repositoryUrl])] as {
      url: string;
      wellKnown?: string;
    }[];
    for (const link of links) {
      expect(link.wellKnown, `${link.url} needs a wellKnown URL`).toMatch(/\/\.well-known\/funding-manifest-urls$/);
    }
  });

  it("keeps the mirror on another host than the main manifest", () => {
    expect(new URL(MIRROR_URL).host).not.toBe(new URL(MANIFEST_URL).host);
  });

  it("only uses channels that exist in its plans", () => {
    const channels = new Set(manifest.funding.channels.map((c) => c.guid));
    for (const c of manifest.funding.channels) expect(c.guid).toMatch(GUID);
    for (const plan of manifest.funding.plans) {
      expect(plan.guid).toMatch(GUID);
      expect(plan.currency).toMatch(/^[A-Z]{3}$/);
      expect(plan.amount).toBeGreaterThanOrEqual(0);
      for (const c of plan.channels) expect(channels.has(c), `plan ${plan.guid} uses unknown channel ${c}`).toBe(true);
    }
  });
});

describe("funding routes", () => {
  it("serves the manifest as JSON anyone can fetch", async () => {
    const res = await worker.fetch(new Request("https://oss.codercops.com/funding.json"), makeEnv(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await res.json()).toEqual(manifest);
  });

  it("lists the manifest in the well-known file", async () => {
    const res = await worker.fetch(new Request("https://oss.codercops.com/.well-known/funding-manifest-urls"), makeEnv(), ctx);
    expect(res.status).toBe(200);
    expect((await res.text()).trim().split("\n")).toEqual(MANIFEST_URLS);
  });
});
