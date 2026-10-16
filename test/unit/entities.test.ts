import { describe, expect, test } from "bun:test";
import { diffEntities, extractEntities } from "../../src/entities.ts";

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
      { type: "renamed", name: "loadUser", path: "services/user.ts", from: { name: "fetchUser", path: "api/user.ts" }, score: 1, tier: 0 },
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
    expect(events).toEqual([{ type: "modified", name: "f", path: "a.ts", tier: 0 }]);
  });
});
