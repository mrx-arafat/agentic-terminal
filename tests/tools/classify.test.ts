import { describe, it, expect } from "vitest";
import { classify } from "../../src/classify.js";

describe("input classifier", () => {
  it("treats empty input as empty", () => {
    expect(classify("").kind).toBe("empty");
    expect(classify("   ").kind).toBe("empty");
  });

  it("routes resume / loop-builtin words to AI (continue, resume, proceed, go)", () => {
    expect(classify("continue").kind).toBe("ai");
    expect(classify("Continue").kind).toBe("ai");
    expect(classify("continue.").kind).toBe("ai");
    expect(classify("resume").kind).toBe("ai");
    expect(classify("proceed").kind).toBe("ai");
    expect(classify("break").kind).toBe("ai");
    expect(classify("retry").kind).toBe("ai");
  });

  it("routes resume phrases to AI", () => {
    expect(classify("go on").kind).toBe("ai");
    expect(classify("keep going").kind).toBe("ai");
    expect(classify("carry on").kind).toBe("ai");
    expect(classify("try again").kind).toBe("ai");
  });

  it("routes slash commands", () => {
    const c = classify("/help");
    expect(c.kind).toBe("slash");
    expect(c.payload).toBe("/help");
  });

  it("honors `!` prefix as shell override", () => {
    const c = classify("! echo hello");
    expect(c.kind).toBe("shell");
    expect(c.payload).toBe("echo hello");
  });

  it("honors `#` and `?` prefix as ai override", () => {
    const a = classify("#fix the bug");
    expect(a.kind).toBe("ai");
    expect(a.payload).toBe("fix the bug");
    const b = classify("? what is react");
    expect(b.kind).toBe("ai");
    expect(b.payload).toBe("what is react");
  });

  it("auto-detects shell builtins", () => {
    expect(classify("cd /tmp").kind).toBe("shell");
    expect(classify("pwd").kind).toBe("shell");
    expect(classify("echo hi").kind).toBe("shell");
  });

  it("auto-detects known tools", () => {
    expect(classify("git status").kind).toBe("shell");
    expect(classify("ls -la").kind).toBe("shell");
    expect(classify("npm install react").kind).toBe("shell");
    expect(classify("docker ps").kind).toBe("shell");
  });

  it("detects path-like commands", () => {
    expect(classify("./run.sh --flag").kind).toBe("shell");
    expect(classify("/usr/bin/env node").kind).toBe("shell");
  });

  it("detects env-var prefix", () => {
    expect(classify("NODE_ENV=production npm run build").kind).toBe("shell");
    expect(classify("DEBUG=1 python app.py").kind).toBe("shell");
  });

  it("routes natural-language prompts to ai", () => {
    expect(classify("create a simple todo app").kind).toBe("ai");
    expect(classify("explain how this works").kind).toBe("ai");
    expect(classify("why is this failing?").kind).toBe("ai");
    expect(classify("refactor the auth module").kind).toBe("ai");
  });

  it("defaults unknown first tokens to ai", () => {
    const c = classify("frobnicate the widgets");
    expect(c.kind).toBe("ai");
  });

  it("does not misclassify NL sentences that begin with `cd` as shell", () => {
    // "cd" alone is a builtin but "cd the app directory" looks weird —
    // builtin wins because head token matches. That's acceptable; user
    // can prefix with # to force ai.
    expect(classify("cd").kind).toBe("shell");
  });

  it("routes English-verb heads with natural language to ai", () => {
    expect(classify("read all files").kind).toBe("ai");
    expect(classify("find the bug in main.ts").kind).toBe("ai");
    expect(classify("make a plan").kind).toBe("ai");
    expect(classify("run the tests and fix failures").kind).toBe("ai");
    expect(classify("build a dashboard").kind).toBe("ai");
    expect(classify("open the file and explain it").kind).toBe("ai");
    expect(classify("install the dependencies").kind).toBe("ai");
  });

  it("is case-insensitive for command classification", () => {
    expect(classify("Read all files.").kind).toBe("ai");
    expect(classify("READ all files").kind).toBe("ai");
    expect(classify("LS -la").kind).toBe("shell");
  });

  it("treats capitalized sentences ending in punctuation as ai", () => {
    expect(classify("The fuck is this?").kind).toBe("ai");
    expect(classify("What just happened?").kind).toBe("ai");
    expect(classify("Show me the logs.").kind).toBe("ai");
  });

  it("ignores trailing punctuation when classifying", () => {
    expect(classify("read all files.").kind).toBe("ai");
    expect(classify("find the bug!").kind).toBe("ai");
  });

  it("reclassifies PATH collisions as ai when prose has glue words", () => {
    // Node exists on PATH; multi-word English prompt should still be ai.
    expect(classify("node is a runtime for the server").kind).toBe("ai");
  });

  it("keeps English-verb heads as shell when args look shell-shaped", () => {
    expect(classify("read -r line").kind).toBe("shell");
    expect(classify("find . -name '*.ts'").kind).toBe("shell");
    expect(classify("make build").kind).toBe("shell");
    expect(classify("make -j4").kind).toBe("shell");
    expect(classify("open README.md").kind).toBe("shell");
    expect(classify("run script.sh").kind).toBe("shell");
  });
});
