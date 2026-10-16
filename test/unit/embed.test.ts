import { describe, expect, test } from "bun:test";
import { cosine, embed, stem, words } from "../../src/embed.ts";

describe("stem (#6)", () => {
  test("maps related forms to one key", () => {
    const groups = [
      ["undo", "undoes"],
      ["journal", "journals"],
      ["retry", "retries"],
      ["cache", "cached", "caching", "caches"],
      ["run", "running"],
      ["invoice", "invoices"],
      ["fix", "fixes", "fixed"],
    ];
    for (const group of groups) expect(new Set(group.map(stem)).size).toBe(1);
  });

  test("keeps unrelated short words and numbers intact", () => {
    expect(stem("bus")).toBe("bus");
    expect(stem("class")).toBe("class");
    expect(stem("404")).toBe("404");
    expect(stem("status")).toBe("status");
  });

  test("identifiers are split before stemming", () => {
    expect(words("retriesWithBackoff")).toEqual(["retry", "with", "backoff"]);
  });
});

describe("embed", () => {
  test("a query matches a document that uses another form of its words", () => {
    const doc = embed("editor: a source that journals and undoes");
    const other = embed("billing: monthly invoices");
    const q = embed("undo history");
    expect(cosine(q, doc)).toBeGreaterThan(0.15);
    expect(cosine(q, doc)).toBeGreaterThan(cosine(q, other));
  });
});
