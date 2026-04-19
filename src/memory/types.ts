export type ProjectType =
  | "node"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "php"
  | "ruby"
  | "unknown";

export interface CommonError {
  /** Regex or substring pattern to match the error message */
  pattern: string;
  /** Suggested fix */
  fix: string;
  /** 0-100 — how confident we are this fix applies */
  confidence: number;
  /** How many times this error was seen */
  count: number;
  /** Fraction of times this fix successfully resolved the error */
  successRate: number;
}

export interface ToolPattern {
  tool: string;
  /** 0-1 — fraction of calls that succeeded */
  successRate: number;
  avgDurationMs: number;
  callCount: number;
}

export interface ProjectMemory {
  projectName: string;
  projectType: ProjectType;
  createdAt: number;
  lastUpdated: number;
  commonErrors: CommonError[];
  toolPatterns: ToolPattern[];
  /** Raw content of .agentic-rules.md if it exists */
  projectRules?: string;
}

export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  outcome: "success" | "failed" | "rejected";
  durationMs: number;
  error?: string;
}
