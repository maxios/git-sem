import { describe, expect, test } from "bun:test";
import { cosine, embed, stem, words } from "../../src/embed.ts";
import { byRelevance, commitVector } from "../../src/search-index.ts";

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

describe("commit search vectors (#13)", () => {
  const editor = "editor: a source that journals and undoes";
  const billing = "billing: monthly invoices with a history of past payments and refunds";
  const q = embed("undo history");

  test("a model's paraphrase that drops the subject's words cannot push the right commit down", () => {
    const ed = commitVector(editor, "Added panels beside the canvas.", "inferred");
    const bi = commitVector(billing, "Invoices keep a history of past payments and refunds.", "inferred");
    expect(cosine(q, ed)).toBeGreaterThan(cosine(q, bi));
  });

  test("an inferred intent still adds findable words", () => {
    const ed = commitVector(editor, "Added panels beside the canvas.", "inferred");
    expect(cosine(embed("panels beside the canvas"), ed)).toBeGreaterThan(0.15);
  });

  test("an authored intent counts as much as the message", () => {
    const authored = commitVector(editor, "Let people undo edits in the canvas", "authored");
    const inferred = commitVector(editor, "Let people undo edits in the canvas", "inferred");
    const intentQuery = embed("undo edits canvas");
    expect(cosine(intentQuery, authored)).toBeGreaterThan(cosine(intentQuery, inferred));
  });
});

describe("ranking ties", () => {
  test("an entity comes before the commit that added it when they score the same", () => {
    const hits = [
      { kind: "commit" as const, score: 0.871 },
      { kind: "entity" as const, score: 0.868 },
      { kind: "commit" as const, score: 0.9 },
    ];
    expect(hits.sort(byRelevance).map((h) => `${h.kind}:${h.score}`)).toEqual(["commit:0.9", "entity:0.868", "commit:0.871"]);
  });
});
