import { readFile, rm, writeFile } from "node:fs/promises";

export type Release = () => Promise<void>;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Try to take an exclusive lock file. Returns a release function, or null if another live process holds it. */
export async function tryLock(path: string): Promise<Release | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(path, String(process.pid), { flag: "wx" });
      return () => rm(path, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const holder = Number((await readFile(path, "utf8").catch(() => "")).trim());
      if (holder && isAlive(holder)) return null;
      await rm(path, { force: true }); // stale lock from a crashed indexer
    }
  }
  return null;
}

/** Wait for the lock, polling until the timeout. */
export async function waitLock(path: string, timeoutMs: number): Promise<Release | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const release = await tryLock(path);
    if (release || Date.now() >= deadline) return release;
    await Bun.sleep(50);
  }
}
