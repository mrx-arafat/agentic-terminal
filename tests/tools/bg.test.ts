import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TOOL_HANDLERS, type ToolContext } from "../../src/tools.js";
import type { BgProcess, BlockRecord, TodoItem } from "../../src/blocks.js";

function makeCtx(cwd: string): ToolContext {
  return {
    cwd,
    readPaths: new Set<string>(),
    blocks: [] as BlockRecord[],
    todos: [] as TodoItem[],
    bgProcs: [] as BgProcess[],
  };
}

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "at-bg-"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("bash background + bg_logs + bg_stop + bg_list", () => {
  it("starts a background process, streams logs, and stops it", async () => {
    const tmp = mkTmp();
    const ctx = makeCtx(tmp);

    const start = await TOOL_HANDLERS.bash(
      { command: "for i in 1 2 3 4 5 6 7 8 9 10; do echo line-$i; sleep 0.1; done", background: true },
      ctx,
    );
    expect(start).toMatch(/started bg id=0 pid=\d+/);
    expect(ctx.bgProcs?.length).toBe(1);
    const proc = ctx.bgProcs![0];
    expect(proc.status).toBe("running");

    await sleep(300);

    const list = await TOOL_HANDLERS.bg_list({}, ctx);
    expect(list).toMatch(/id=0 pid=\d+ running/);

    const logs = await TOOL_HANDLERS.bg_logs({ id: 0 }, ctx);
    expect(logs).toMatch(/line-1/);

    const stop = await TOOL_HANDLERS.bg_stop({ id: 0, force: true }, ctx);
    expect(stop).toMatch(/sent SIGKILL/);

    await sleep(100);
    expect(ctx.bgProcs![0].status).toBe("exited");
  });

  it("records exit status after natural completion", async () => {
    const tmp = mkTmp();
    const ctx = makeCtx(tmp);
    await TOOL_HANDLERS.bash({ command: "echo done", background: true }, ctx);
    // wait for exit
    for (let i = 0; i < 30; i++) {
      if (ctx.bgProcs![0].status === "exited") break;
      await sleep(50);
    }
    expect(ctx.bgProcs![0].status).toBe("exited");
    const logs = await TOOL_HANDLERS.bg_logs({ id: 0 }, ctx);
    expect(logs).toMatch(/done/);
    expect(logs).toMatch(/exited\(0\)/);
  });

  it("errors on unknown bg id", async () => {
    const tmp = mkTmp();
    const ctx = makeCtx(tmp);
    const a = await TOOL_HANDLERS.bg_logs({ id: 42 }, ctx);
    expect(a).toMatch(/error: no bg process id=42/);
    const b = await TOOL_HANDLERS.bg_stop({ id: 42 }, ctx);
    expect(b).toMatch(/error: no bg process id=42/);
  });
});
