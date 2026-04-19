import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { MemoryStore } from "../../src/memory/store.js";
import type { ProjectMemory } from "../../src/memory/types.js";

let tmpDir: string;
let store: MemoryStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-store-"));
  store = new MemoryStore(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const baseMemory: ProjectMemory = {
  projectName: "test-project",
  projectType: "node",
  createdAt: 1000,
  lastUpdated: 1000,
  commonErrors: [],
  toolPatterns: [],
};

describe("MemoryStore", () => {
  it("returns null for unknown project", async () => {
    const result = await store.load("nonexistent");
    expect(result).toBeNull();
  });

  it("saves and loads memory", async () => {
    await store.save(baseMemory);
    const loaded = await store.load("test-project");
    expect(loaded).not.toBeNull();
    expect(loaded!.projectName).toBe("test-project");
    expect(loaded!.projectType).toBe("node");
  });

  it("overwrites on second save", async () => {
    await store.save(baseMemory);
    await store.save({ ...baseMemory, projectType: "python" });
    const loaded = await store.load("test-project");
    expect(loaded!.projectType).toBe("python");
  });

  it("creates parent directories automatically", async () => {
    const nestedStore = new MemoryStore(path.join(tmpDir, "deep", "nested"));
    await nestedStore.save(baseMemory);
    const loaded = await nestedStore.load("test-project");
    expect(loaded).not.toBeNull();
  });

  it("initializes fresh memory for new project", async () => {
    const memory = await store.initialize("brand-new", "go", "/some/path");
    expect(memory.projectName).toBe("brand-new");
    expect(memory.projectType).toBe("go");
    expect(memory.commonErrors).toEqual([]);
    expect(memory.toolPatterns).toEqual([]);
    expect(memory.createdAt).toBeGreaterThan(0);
  });

  it("init saves to disk", async () => {
    await store.initialize("saved-new", "rust", "/some/path");
    const loaded = await store.load("saved-new");
    expect(loaded).not.toBeNull();
  });

  it("update merges fields", async () => {
    await store.save(baseMemory);
    await store.update("test-project", {
      commonErrors: [
        { pattern: "ENOENT", fix: "Check path", confidence: 90, count: 1, successRate: 1 },
      ],
    });
    const loaded = await store.load("test-project");
    expect(loaded!.commonErrors).toHaveLength(1);
    expect(loaded!.commonErrors[0].pattern).toBe("ENOENT");
  });

  it("update returns null when project not found", async () => {
    const result = await store.update("ghost", { projectType: "go" });
    expect(result).toBeNull();
  });
});
