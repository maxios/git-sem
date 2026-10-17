import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DECLARES, pickaxeArgs } from "../../src/merge.ts";

const SRC = join(resolve(import.meta.dir, "../.."), "src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
  });
}

// GNU regex extensions that BSD/macOS regcomp does not understand (issue #8).
const GNU_ONLY = /\\\\[bBwWsS<>`']/;

describe("git regex portability", () => {
  test("the stale-reference pickaxe uses a plain string, not a regex", () => {
    const args = pickaxeArgs("fetchUser");
    expect(args).toEqual(["-S", "fetchUser"]);
    expect(args.join(" ")).not.toMatch(/\\/);
  });

  test("no git -G or --grep argument in src uses GNU-only regex escapes", () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      for (const [i, line] of readFileSync(file, "utf8").split("\n").entries()) {
        const passesRegexToGit = /["'`](-G|--grep(=)?)["'`]/.test(line) || /-G\$\{|--grep=\$\{/.test(line);
        if (passesRegexToGit && GNU_ONLY.test(line)) offenders.push(`${file}:${i + 1}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("declaration matcher used by check (#12)", () => {
  const cases: Array<[string, boolean]> = [
    ["export const pick = (", true],
    ["function pick(a) {", true],
    ["export async function pick(a) {", true],
    ["  pick(a, b) {", true],
    ["  async pick(a: string): Promise<void> {", true],
    ["func (s *S) pick(id int) error {", true],
    ["def pick(", true],
    ["  pick(1, 2);", false],
    ["const total = pick(1, 2);", false],
    ["obj.pick(1)", false],
    ["// pick is gone", false],
    ["import { pick } from './lib';", false],
  ];
  for (const [line, declares] of cases) {
    test(`${declares ? "declares" : "only uses"}: ${line}`, () => {
      expect(DECLARES("pick").test(line)).toBe(declares);
    });
  }
});
