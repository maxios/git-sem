import { describe, expect, test } from "bun:test";
import { diffEntities, extractEntities, familyOf, isTestPath, similarity } from "../../src/entities.ts";

const USER_TS = `import { db } from "./db";

export async function fetchUser(id: string) {
  const row = await db.users.find(id);
  if (!row) throw new Error("missing");
  return { id: row.id, name: row.name };
}

export class Session {
  private token = "";

  refresh(force: boolean): void {
    if (force) this.token = "";
  }

  get user() {
    return null;
  }
}

export const toId = (x: { id: string }) => x.id;

export interface User {
  id: string;
}
`;

describe("extractEntities", () => {
  test("finds functions, classes, methods, arrow functions and types in TypeScript", () => {
    const names = extractEntities("src/user.ts", USER_TS).map((e) => `${e.kind}:${e.name}`);
    expect(names).toEqual([
      "function:fetchUser",
      "class:Session",
      "method:Session.refresh",
      "method:Session.user",
      "function:toId",
      "type:User",
    ]);
  });

  test("records accurate line ranges", () => {
    const fetchUser = extractEntities("src/user.ts", USER_TS).find((e) => e.name === "fetchUser")!;
    expect([fetchUser.start, fetchUser.end]).toEqual([3, 7]);
  });

  test("ignores braces inside strings and comments", () => {
    const src = `function a() {\n  const s = "}}}"; // }\n  /* { */\n  return s;\n}\nfunction b() {}\n`;
    expect(extractEntities("x.ts", src).map((e) => [e.name, e.start, e.end])).toEqual([
      ["a", 1, 5],
      ["b", 6, 6],
    ]);
  });

  test("handles Python classes, methods and functions", () => {
    const src = `class Quota:\n    def check(self, n):\n        return n < 3\n\ndef compute_quota(user):\n    return 3\n`;
    expect(extractEntities("q.py", src).map((e) => e.name)).toEqual(["Quota", "Quota.check", "compute_quota"]);
  });

  test("handles Go and Rust", () => {
    expect(extractEntities("a.go", "func (s *S) Load(id int) error {\n\treturn nil\n}\n").map((e) => e.name)).toEqual(["Load"]);
    expect(extractEntities("a.rs", "pub fn load(id: u32) -> u32 {\n    id\n}\n").map((e) => e.name)).toEqual(["load"]);
  });

  test("unsupported languages yield nothing", () => {
    expect(extractEntities("README.md", "# function x() {}")).toEqual([]);
  });
});

describe("diffEntities", () => {
  const body = (name: string) =>
    `export function ${name}(id: string) {\n  const row = db.users.find(id);\n  return row ? row.name : null;\n}\n`;

  test("a pure rename across files is an exact Tier 0 link", () => {
    const events = diffEntities([{ path: "api/user.ts", content: body("fetchUser") }], [{ path: "services/user.ts", content: body("loadUser") }]);
    expect(events).toEqual([
      { type: "renamed", name: "loadUser", path: "services/user.ts", exported: true, from: { name: "fetchUser", path: "api/user.ts" }, score: 1, tier: 0 },
    ]);
  });

  test("rename plus edit is linked by similarity at Tier 1", () => {
    const edited = body("loadUser").replace("return row ? row.name : null;", "return row ? row.name.trim() : null;");
    const [event] = diffEntities([{ path: "a.ts", content: body("fetchUser") }], [{ path: "a.ts", content: edited }]);
    expect(event?.type).toBe("renamed");
    expect(event?.tier).toBe(1);
  });

  test("two equally good successors are ambiguous, not guessed", () => {
    const events = diffEntities(
      [{ path: "a.ts", content: body("fetchUser") }],
      [{ path: "a.ts", content: `${body("loadUser")}\n${body("getUser")}` }],
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("ambiguous");
    expect(events[0]?.candidates?.map((c) => c.name).sort()).toEqual(["getUser", "loadUser"]);
  });

  test("unrelated code is added and removed, not linked", () => {
    const events = diffEntities(
      [{ path: "a.ts", content: "function alpha() {\n  return 1 + 2;\n}\n" }],
      [{ path: "a.ts", content: "function omega(list) {\n  for (const x of list) console.log(x.label);\n}\n" }],
    );
    expect(events.map((e) => `${e.type}:${e.name}`).sort()).toEqual(["added:omega", "removed:alpha"]);
  });

  test("an edit in place is modified", () => {
    const events = diffEntities([{ path: "a.ts", content: body("f") }], [{ path: "a.ts", content: body("f").replace("null", "undefined") }]);
    expect(events).toEqual([{ type: "modified", name: "f", path: "a.ts", exported: true, tier: 0 }]);
  });

  test("unrelated short functions are not linked as renames (#4)", () => {
    const events = diffEntities(
      [{ path: "a.ts", content: "export function count(xs) {\n  return xs.length\n}\n" }],
      [{ path: "b.ts", content: "export function width(box) {\n  return box.left\n}\n" }],
    );
    expect(events.map((e) => `${e.type}:${e.name}`).sort()).toEqual(["added:width", "removed:count"]);
  });

  test("a short function that is renamed unchanged still links exactly", () => {
    const events = diffEntities(
      [{ path: "a.ts", content: "export function count(xs) {\n  return xs.length\n}\n" }],
      [{ path: "a.ts", content: "export function size(xs) {\n  return xs.length\n}\n" }],
    );
    expect(events).toMatchObject([{ type: "renamed", name: "size", from: { name: "count" }, tier: 0 }]);
  });

  test("similarity ignores syntax and keywords", () => {
    const a = "function a(x) { if (x) { return this.y; } return null; }";
    const b = "function b(z) { if (z) { return this.w; } return null; }";
    expect(similarity(a, "a", b, "b")).toBe(0);
  });
});

describe("export and language awareness (#3)", () => {
  test("exported entities per language", () => {
    const exported = (path: string, src: string) => extractEntities(path, src).map((e) => `${e.name}:${e.exported}`);
    expect(exported("a.ts", "export function a() {}\nfunction b() {}\nexport class C {\n  run() {\n  }\n  private hide() {\n  }\n}\n")).toEqual([
      "a:true",
      "b:false",
      "C:true",
      "C.run:true",
      "C.hide:false",
    ]);
    expect(exported("a.go", "func Load() {\n}\nfunc load() {\n}\n")).toEqual(["Load:true", "load:false"]);
    expect(exported("a.py", "def run():\n    pass\ndef _helper():\n    pass\n")).toEqual(["run:true", "_helper:false"]);
    expect(exported("a.rs", "pub fn a() {\n}\nfn b() {\n}\n")).toEqual(["a:true", "b:false"]);
  });

  test("language families and test paths", () => {
    expect(familyOf("web/time.ts")).toBe(familyOf("web/time.jsx"));
    expect(familyOf("web/time.ts")).not.toBe(familyOf("go/api.go"));
    expect(["src/a.test.ts", "tests/x.py", "pkg/a_test.go", "__tests__/a.js"].every(isTestPath)).toBe(true);
    expect(["src/a.ts", "src/testing.ts", "pkg/a.go"].some(isTestPath)).toBe(false);
  });
});

describe("wrapped signatures (#12)", () => {
  const span = (path: string, src: string) => extractEntities(path, src).map((e) => `${e.name}:${e.start}-${e.end}`);

  test("an arrow function whose parameters wrap is extracted, with its whole body", () => {
    const src = "export const pick = (\n  a: number,\n  b: number,\n): number => a + b;\n\nexport const next = 1;\n";
    expect(span("lib.ts", src)).toEqual(["pick:1-4"]);
  });

  test("a wrapped arrow function with a block body", () => {
    const src = "export const load = async (\n  id: string,\n  opts: Options,\n) => {\n  return db.find(id, opts);\n};\n";
    expect(span("a.ts", src)).toEqual(["load:1-6"]);
  });

  test("parameters with callback types do not end the parameter list early", () => {
    expect(span("a.ts", "export const on = (cb: () => void, n = f()) => cb();\n")).toEqual(["on:1-1"]);
  });

  test("a call assigned to a const is not a function", () => {
    expect(span("a.ts", "export const handler = createHandler(\n  a,\n  b,\n);\n")).toEqual([]);
  });

  test("a method whose parameters wrap is extracted", () => {
    const src = "export class Store {\n  async save(\n    key: string,\n    value: string,\n  ): Promise<void> {\n    await put(key, value);\n  }\n}\n";
    expect(span("s.ts", src)).toEqual(["Store:1-8", "Store.save:2-7"]);
  });

  test("a Python def whose parameters wrap keeps its body", () => {
    const src = "def compute_quota(\n    user,\n    plan,\n):\n    limit = plan.limit\n    return limit - user.used\n\ndef other():\n    pass\n";
    expect(span("q.py", src)).toEqual(["compute_quota:1-6", "other:8-9"]);
  });

  test("reformatting a one-line arrow into a wrapped one reads as modified, not removed", () => {
    const before = "export const pick = (a: number, b: number): number => a + b;\n";
    const after = "export const pick = (\n  a: number,\n  b: number,\n): number => a + b;\n";
    expect(diffEntities([{ path: "lib.ts", content: before }], [{ path: "lib.ts", content: after }])).toEqual([
      { type: "modified", name: "pick", path: "lib.ts", exported: true, tier: 0 },
    ]);
  });
});

describe("same-name moves of small entities (#11)", () => {
  const small = (call: string) => `export function countSlots(range) {\n  let n = 0;\n  ${call}(range, () => n++);\n  return n;\n}\n`;

  test("a short function moved with a small edit is moved, not removed + added", () => {
    const events = diffEntities([{ path: "a.ts", content: small("each") }], [{ path: "lib/a.ts", content: small("forEach") }]);
    expect(events).toMatchObject([{ type: "moved", name: "countSlots", path: "lib/a.ts", from: { name: "countSlots", path: "a.ts" }, tier: 1 }]);
  });

  test("two successors with the same name are not guessed", () => {
    const events = diffEntities(
      [{ path: "a.ts", content: small("each") }],
      [
        { path: "lib/a.ts", content: small("forEach") },
        { path: "lib/b.ts", content: small("map") },
      ],
    );
    expect(events.map((e) => `${e.type}:${e.path}`).sort()).toEqual(["added:lib/a.ts", "added:lib/b.ts", "removed:a.ts"]);
  });

  test("a reused name with an unrelated body is not a move", () => {
    const events = diffEntities(
      [{ path: "a.ts", content: small("each") }],
      [{ path: "b.ts", content: "export function countSlots(box) {\n  return box.width * box.height;\n}\n" }],
    );
    expect(events.map((e) => e.type).sort()).toEqual(["added", "removed"]);
  });

  test("a stronger cross-name link still wins over a weak same-name one", () => {
    const body = (name: string) => `export function ${name}(id: string) {\n  const row = db.users.find(id);\n  const extra = cache.lookup(row.key, row.region);\n  return row ? row.name : fallback.name;\n}\n`;
    const events = diffEntities(
      [{ path: "a.ts", content: body("fetchUser") }],
      [{ path: "b.ts", content: `${body("loadUser")}\nexport function fetchUser(id) {\n  return legacy.get(id, true);\n}\n` }],
    );
    expect(events).toContainEqual(expect.objectContaining({ type: "renamed", name: "loadUser", from: { name: "fetchUser", path: "a.ts" } }));
  });
});
