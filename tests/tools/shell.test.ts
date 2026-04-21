import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCompletions, expandTilde, suggestDir } from "../../src/shell.js";

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "at-shell-"));
  fs.mkdirSync(path.join(tmp, "files"));
  fs.mkdirSync(path.join(tmp, "simple-python-script"));
  fs.writeFileSync(path.join(tmp, "readme.txt"), "hi");
  fs.writeFileSync(path.join(tmp, ".hidden"), "x");
});

describe("expandTilde", () => {
  it("expands ~ and ~/sub", () => {
    expect(expandTilde("~")).toBe(os.homedir());
    expect(expandTilde("~/foo")).toBe(path.join(os.homedir(), "foo"));
    expect(expandTilde("foo")).toBe("foo");
  });
});

describe("suggestDir", () => {
  it("matches by prefix", () => {
    expect(suggestDir(tmp, "fi")).toBe("files");
    expect(suggestDir(tmp, "sim")).toBe("simple-python-script");
  });
  it("falls back to substring", () => {
    expect(suggestDir(tmp, "python")).toBe("simple-python-script");
  });
  it("returns undefined on no match", () => {
    expect(suggestDir(tmp, "zzzzz")).toBeUndefined();
  });
});

describe("buildCompletions", () => {
  it("completes directories only for cd", () => {
    const [matches] = buildCompletions("cd ", tmp);
    expect(matches).toContain("files/");
    expect(matches).toContain("simple-python-script/");
    expect(matches).not.toContain("readme.txt");
  });

  it("completes by prefix", () => {
    const [matches] = buildCompletions("cd s", tmp);
    expect(matches).toEqual(["simple-python-script/"]);
  });

  it("completes files for non-cd commands", () => {
    const [matches] = buildCompletions("cat r", tmp);
    expect(matches).toEqual(["readme.txt"]);
  });

  it("hides dotfiles unless user typed a leading dot", () => {
    const [noDot] = buildCompletions("cat ", tmp);
    expect(noDot.some((m) => m.startsWith("."))).toBe(false);
    const [withDot] = buildCompletions("cat .", tmp);
    expect(withDot).toContain(".hidden");
  });
});
