import fs from "node:fs";
import path from "node:path";
import type { ProjectMemory, ProjectType } from "./types.js";

export class MemoryStore {
  constructor(private baseDir: string) {}

  private filePath(projectName: string): string {
    return path.join(this.baseDir, `${projectName}.json`);
  }

  async load(projectName: string): Promise<ProjectMemory | null> {
    const fp = this.filePath(projectName);
    if (!fs.existsSync(fp)) return null;
    try {
      return JSON.parse(fs.readFileSync(fp, "utf8")) as ProjectMemory;
    } catch {
      return null;
    }
  }

  async save(memory: ProjectMemory): Promise<void> {
    fs.mkdirSync(this.baseDir, { recursive: true });
    fs.writeFileSync(this.filePath(memory.projectName), JSON.stringify(memory, null, 2), "utf8");
  }

  async initialize(projectName: string, projectType: ProjectType, _cwd: string): Promise<ProjectMemory> {
    const now = Date.now();
    const memory: ProjectMemory = {
      projectName,
      projectType,
      createdAt: now,
      lastUpdated: now,
      commonErrors: [],
      toolPatterns: [],
    };
    await this.save(memory);
    return memory;
  }

  async update(projectName: string, updates: Partial<ProjectMemory>): Promise<ProjectMemory | null> {
    const existing = await this.load(projectName);
    if (!existing) return null;
    const updated: ProjectMemory = { ...existing, ...updates, lastUpdated: Date.now() };
    await this.save(updated);
    return updated;
  }
}
