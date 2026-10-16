import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { spawnText } from "../../src/proc.ts";

describe("spawnText", () => {
  test("a child that ignores stdin still succeeds", async () => {
    const input = "x".repeat(1 << 20); // larger than a pipe buffer
    for (let i = 0; i < 20; i++) {
      const r = await spawnText(["sh", "-c", "echo ok"], { cwd: tmpdir(), input });
      expect(r).toMatchObject({ code: 0, stdout: "ok\n" });
    }
  });

  test("large input reaches a child that reads it", async () => {
    const input = "y".repeat(1 << 20);
    const r = await spawnText(["wc", "-c"], { cwd: tmpdir(), input });
    expect(r.stdout.trim()).toBe(String(input.length));
  });

  test("timeouts are reported", async () => {
    const r = await spawnText(["sleep", "5"], { cwd: tmpdir(), timeoutMs: 100 });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBe(-1);
  });
});
