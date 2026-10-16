import type { FileSink } from "bun";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

export interface SpawnOptions {
  cwd: string;
  input?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

/**
 * Spawn a process, optionally feed it stdin, and collect its output as text.
 * Readers start before stdin is written so large inputs cannot deadlock.
 */
export async function spawnText(cmd: string[], opts: SpawnOptions): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();

  if (opts.input !== undefined) {
    const sink = proc.stdin as unknown as FileSink;
    sink.write(opts.input);
    await sink.end();
  }

  let timedOut = false;
  const timer =
    opts.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, opts.timeoutMs);

  try {
    const [out, err, code] = await Promise.all([stdout, stderr, proc.exited]);
    return { stdout: out, stderr: err, code: timedOut ? -1 : code, timedOut };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Spawn a process and collect stdout as raw bytes. */
export async function spawnBytes(cmd: string[], cwd: string): Promise<{ bytes: Uint8Array; code: number }> {
  const proc = Bun.spawn(cmd, { cwd, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const [buffer, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);
  return { bytes: new Uint8Array(buffer), code };
}
