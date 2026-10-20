/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import raw from "../wrangler.jsonc?raw";
import { parseJsonc } from "../scripts/jsonc";

describe("parseJsonc", () => {
  it("reads comments at the end of a line", () => {
    expect(parseJsonc('{\n  "workers_dev": true, // keep the workers.dev address\n  "a": 1\n}')).toEqual({ workers_dev: true, a: 1 });
  });

  it("reads block comments", () => {
    expect(parseJsonc('{\n  /* the main route */\n  "a": /* inline */ 1\n}')).toEqual({ a: 1 });
  });

  it("reads trailing commas", () => {
    expect(parseJsonc('{ "routes": [{ "pattern": "oss.codercops.com" },], }')).toEqual({ routes: [{ pattern: "oss.codercops.com" }] });
  });

  it("keeps // and /* inside strings", () => {
    expect(parseJsonc('{ "url": "https://oss.codercops.com/a", "glob": "src/*/x" } // done')).toEqual({
      url: "https://oss.codercops.com/a",
      glob: "src/*/x",
    });
  });

  it("parses today's wrangler.jsonc the same as before", () => {
    expect(parseJsonc(raw)).toEqual(JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")));
  });

  it("throws on invalid JSON", () => {
    expect(() => parseJsonc('{ "a": }')).toThrow();
  });
});
