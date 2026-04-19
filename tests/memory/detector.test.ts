import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { detectProjectType, getProjectName } from "../../src/memory/detector.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-detect-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("detectProjectType", () => {
  it("detects node from package.json", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
    expect(detectProjectType(tmpDir)).toBe("node");
  });

  it("detects python from pyproject.toml", () => {
    fs.writeFileSync(path.join(tmpDir, "pyproject.toml"), "");
    expect(detectProjectType(tmpDir)).toBe("python");
  });

  it("detects python from requirements.txt", () => {
    fs.writeFileSync(path.join(tmpDir, "requirements.txt"), "");
    expect(detectProjectType(tmpDir)).toBe("python");
  });

  it("detects go from go.mod", () => {
    fs.writeFileSync(path.join(tmpDir, "go.mod"), "");
    expect(detectProjectType(tmpDir)).toBe("go");
  });

  it("detects rust from Cargo.toml", () => {
    fs.writeFileSync(path.join(tmpDir, "Cargo.toml"), "");
    expect(detectProjectType(tmpDir)).toBe("rust");
  });

  it("returns unknown for empty directory", () => {
    expect(detectProjectType(tmpDir)).toBe("unknown");
  });

  it("prefers node over python when both present", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
    fs.writeFileSync(path.join(tmpDir, "requirements.txt"), "");
    expect(detectProjectType(tmpDir)).toBe("node");
  });
});

describe("getProjectName", () => {
  it("uses package.json name for node projects", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "my-cool-app" }),
    );
    expect(getProjectName(tmpDir)).toBe("my-cool-app");
  });

  it("falls back to directory name when package.json has no name", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
    const name = getProjectName(tmpDir);
    expect(typeof name).toBe("string");
    expect(name.length).toBeGreaterThan(0);
  });

  it("uses directory name for non-node projects", () => {
    const name = getProjectName(tmpDir);
    expect(name).toBe(path.basename(tmpDir).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "project");
  });

  it("sanitizes names (lowercase, hyphens only)", () => {
    const dirWithSpaces = fs.mkdtempSync(path.join(os.tmpdir(), "my project-"));
    try {
      const name = getProjectName(dirWithSpaces);
      expect(name).not.toMatch(/\s/);
    } finally {
      fs.rmdirSync(dirWithSpaces);
    }
  });
});
