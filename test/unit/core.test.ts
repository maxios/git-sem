import { describe, expect, test } from "bun:test";
import {
  keyOf,
  mergeRecords,
  parseNote,
  resolveIntent,
  serializeNote,
  type ArtifactRecord,
} from "../../src/artifacts.ts";
import { parseRawZ } from "../../src/changes.ts";
import { installBlock, HOOK_BEGIN } from "../../src/commands/init.ts";

function intent(over: Partial<ArtifactRecord>): ArtifactRecord {
  return {
    v: 1,
    kind: "intent",
    object: "c0ffee",
    source: "inferred",
    engine: "command",
    model: "m1",
    prompt: "intent/v1",
    tier: 2,
    confidence: 0.9,
    value: { text: "x" },
    evidence: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("artifact keys", () => {
  test("a new model or prompt produces a new key", () => {
    const a = intent({});
    expect(keyOf(intent({ model: "m2" }))).not.toBe(keyOf(a));
    expect(keyOf(intent({ prompt: "intent/v2" }))).not.toBe(keyOf(a));
  });

  test("merging never replaces an existing record", () => {
    const original = intent({ value: { text: "original" } });
    const duplicate = intent({ value: { text: "rewritten" } });
    const merged = mergeRecords([original], [duplicate]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.value).toEqual({ text: "original" });
  });
});

describe("note format", () => {
  test("round-trips and survives a union merge (concatenate, sort, dedupe)", () => {
    const a = intent({ model: "m1" });
    const b = intent({ model: "m2" });
    const mine = serializeNote([a]);
    const theirs = serializeNote([a, b]);
    const unioned = [...new Set(`${mine}${theirs}`.split("\n").filter(Boolean))].sort().join("\n");
    expect(parseNote(unioned).map((r) => r.model).sort()).toEqual(["m1", "m2"]);
  });

  test("ignores malformed and unknown lines", () => {
    const text = `not json\n{"v":2,"kind":"future"}\n${JSON.stringify(intent({}))}\n`;
    expect(parseNote(text)).toHaveLength(1);
  });

  test("same key from two machines keeps the earliest record", () => {
    const early = intent({ createdAt: "2026-01-01T00:00:00.000Z", value: { text: "early" } });
    const late = intent({ createdAt: "2026-02-01T00:00:00.000Z", value: { text: "late" } });
    const parsed = parseNote(serializeNote([late, early]).concat(JSON.stringify(late)));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.value).toEqual({ text: "early" });
  });
});

describe("intent resolution", () => {
  const current = { engine: "command", model: "m2", prompt: "intent/v1" };

  test("authored beats every inferred intent", () => {
    const records = [
      intent({ model: "m2" }),
      intent({ source: "authored", author: "k@x", engine: "human", tier: 0, value: { text: "mine" } }),
    ];
    expect(resolveIntent(records, current)?.value).toEqual({ text: "mine" });
  });

  test("the latest authored intent wins", () => {
    const records = [
      intent({ source: "authored", author: "a", createdAt: "2026-01-01T00:00:00.000Z", value: { text: "old" } }),
      intent({ source: "authored", author: "a", createdAt: "2026-03-01T00:00:00.000Z", value: { text: "new" } }),
    ];
    expect(resolveIntent(records)?.value).toEqual({ text: "new" });
  });

  test("prefers the configured engine, then the highest tier", () => {
    const heuristic = intent({ engine: "heuristic", model: "none", prompt: "heuristic/v1", tier: 0 });
    const m1 = intent({ model: "m1" });
    const m2 = intent({ model: "m2" });
    expect(resolveIntent([heuristic, m1, m2], current)).toBe(m2);
    expect(resolveIntent([heuristic, m1])).toBe(m1);
  });
});

describe("raw diff parsing", () => {
  test("parses additions, modifications, deletions and renames", () => {
    const blob = "a".repeat(40);
    const zero = "0".repeat(40);
    const out = [
      `:000000 100644 ${zero} ${blob} A`, "src/new.ts",
      `:100644 100644 ${blob} ${blob} M`, "src/changed.ts",
      `:100644 000000 ${blob} ${zero} D`, "src/gone.ts",
      `:100644 100644 ${blob} ${blob} R087`, "api/user.ts", "services/user.ts",
      "",
    ].join("\0");
    expect(parseRawZ(out)).toEqual([
      { status: "A", path: "src/new.ts", blob, mode: "100644" },
      { status: "M", path: "src/changed.ts", blob, mode: "100644" },
      { status: "D", path: "src/gone.ts", blob: undefined, mode: "000000" },
      { status: "R", path: "services/user.ts", from: "api/user.ts", blob, mode: "100644", similarity: 87 },
    ]);
  });
});

describe("hook installation", () => {
  test("creates, appends to, and upgrades hooks idempotently", () => {
    const fresh = installBlock(undefined);
    expect(fresh.startsWith("#!/bin/sh\n")).toBe(true);
    expect(installBlock(fresh)).toBe(fresh);

    const custom = "#!/bin/sh\necho custom\n";
    const appended = installBlock(custom);
    expect(appended.startsWith(custom)).toBe(true);
    expect(appended.split(HOOK_BEGIN)).toHaveLength(2);
    expect(installBlock(appended)).toBe(appended);
  });
});
