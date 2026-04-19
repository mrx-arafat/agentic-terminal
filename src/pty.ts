export const INTERACTIVE_TOKENS = ["sudo", "ssh", "su", "scp", "passwd", "docker login", "mysql", "psql"] as const;

export function needsPty(command: string): boolean {
  const trimmed = command.trim();
  for (const token of INTERACTIVE_TOKENS) {
    if (token === "docker login" && trimmed.includes(token)) return true;
    if (trimmed.startsWith(token + " ") || trimmed === token) return true;
  }
  return false;
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*\x07|[@-Z\\-_])/g, "");
}

export async function runInteractive(opts: { command: string; cwd: string; timeoutMs: number }): Promise<{ exitCode: number; output: string; error?: string }> {
  let pty;
  try {
    pty = await import("node-pty");
  } catch (e) {
    return { exitCode: -1, output: "", error: "node-pty not installed; reinstall to enable interactive commands: npm install -g agentic-terminal@latest" };
  }

  return new Promise((resolve) => {
    let modeReset = false;
    const restoreMode = () => {
      if (!modeReset) {
        modeReset = true;
        try {
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
          }
          process.stdin.resume();
        } catch (e) {
          // ignore
        }
      }
    };

    let accumulated = "";
    const MAX_OUTPUT = 20 * 1024; // 20KB

    try {
      if (process.stdin.isTTY) {
        process.stdin.pause();
        process.stdin.setRawMode(true);
        process.stdin.resume();
      }

      const child = pty.spawn("bash", ["-lc", opts.command], {
        cwd: opts.cwd,
        cols: process.stdout.columns ?? 80,
        rows: process.stdout.rows ?? 24,
        env: process.env,
      });

      const onData = (data: Buffer) => {
        child.write(data.toString());
      };

      process.stdin.on("data", onData);

      child.onData((data: string) => {
        process.stdout.write(data);
        accumulated += data;
        if (accumulated.length > MAX_OUTPUT) {
          accumulated = accumulated.slice(-MAX_OUTPUT);
        }
      });

      const timeout = setTimeout(() => {
        child.kill();
      }, opts.timeoutMs);

      child.onExit((e: { exitCode: number }) => {
        clearTimeout(timeout);
        process.stdin.removeListener("data", onData);
        restoreMode();
        resolve({ exitCode: e.exitCode, output: stripAnsi(accumulated) });
      });
    } catch (e) {
      restoreMode();
      resolve({ exitCode: -1, output: "", error: String(e) });
    }
  });
}
