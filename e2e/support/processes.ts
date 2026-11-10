import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

/** One line a program printed: its JSON fields when it logs JSON, and the raw text always. */
export type LogLine = Record<string, unknown> & { text: string };

export type Exit = { code: number | null; signal: NodeJS.Signals | null };

export interface RunningApp {
  // Every line so far, stdout and stderr, in arrival order
  readonly lines: readonly LogLine[];
  /** The first line from index `from` on that matches. Fails if the program exits first. */
  waitForLine(match: (line: LogLine) => boolean, from?: number): Promise<LogLine>;
  /** Polls the URL until it answers 2xx. Fails if the program exits first. */
  waitForHttp(url: string): Promise<void>;
  /** Sends SIGTERM and resolves with how the program ended. */
  stop(): Promise<Exit>;
}

const repoRoot = new URL('../../', import.meta.url);
const WAIT_MS = 45_000;
const STOP_MS = 20_000;

/**
 * Runs a built app (`apps/<name>/dist/main.js`) as its own process, as `pnpm start` would, with
 * only the env passed here, so a developer's shell never leaks in. The API still loads the
 * repo-root .env through ConfigModule, so pass every setting it reads: passed values win.
 */
export function startApp(name: 'api' | 'worker', env: Record<string, string>): RunningApp {
  const entry = fileURLToPath(new URL(`apps/${name}/dist/main.js`, repoRoot));
  const child = spawn(process.execPath, [entry], {
    env: { PATH: process.env.PATH ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // If the test runner dies without its teardown, the program must not run on by itself
  const killChild = (): void => void child.kill('SIGKILL');
  process.once('exit', killChild);
  const lines: LogLine[] = [];
  let exit: Exit | undefined;
  const exited = new Promise<Exit>((resolve) => {
    child.once('exit', (code, signal) => {
      process.off('exit', killChild);
      exit = { code, signal };
      resolve(exit);
    });
  });
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', (text) => lines.push(parseLine(text)));
  }

  // Polls `check` until it returns true; on failure the error carries the program's last lines
  async function until(what: string, check: () => Promise<boolean> | boolean): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await check())) {
      if (exit) throw failure(`${name} exited (${describeExit(exit)}) before ${what}`);
      if (Date.now() > deadline) throw failure(`${name}: no ${what} within ${WAIT_MS} ms`);
      await sleep(100);
    }
  }

  function failure(message: string): Error {
    const tail = lines.slice(-40).map((line) => `  ${line.text}`);
    return new Error([message, 'Last lines:', ...tail].join('\n'));
  }

  return {
    lines,
    async waitForLine(match, from = 0) {
      let found: LogLine | undefined;
      await until('matching log line', () => {
        found = lines.slice(from).find(match);
        return found !== undefined;
      });
      return found as LogLine;
    },
    async waitForHttp(url) {
      await until(`answer from ${url}`, async () => {
        try {
          return (await fetch(url)).ok;
        } catch {
          return false;
        }
      });
    },
    async stop() {
      if (exit) return exit;
      child.kill('SIGTERM');
      // Unref'd: once the program has stopped, this timer must not keep the test run alive
      const timeout = sleep(STOP_MS, undefined, { ref: false });
      const ended = await Promise.race([exited, timeout]);
      if (ended) return ended;
      child.kill('SIGKILL');
      throw failure(`${name} did not stop within ${STOP_MS} ms of SIGTERM`);
    },
  };
}

function parseLine(text: string): LogLine {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null) return { ...parsed, text };
  } catch {
    // Not JSON: Nest's own log format, or a stack trace
  }
  return { text };
}

function describeExit(exit: Exit): string {
  return exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`;
}

/** A port nothing listens on right now, for the API to listen on. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address !== null && typeof address === 'object') resolve(address.port);
        else reject(new Error('Could not find a free port'));
      });
    });
  });
}
