import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pickaxeArgs } from "../../src/merge.ts";

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
