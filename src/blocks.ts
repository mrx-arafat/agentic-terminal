/** Defines interfaces for block records and todo items. */
export interface BlockRecord {
  id: number;
  cwd: string;
  command: string;
  startedAt: number;
  durationMs: number;
  exitCode: number | null;
  output: string;
  truncated: boolean;
}

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "done";
}

export interface BgProcess {
  id: number;
  pid: number;
  command: string;
  cwd: string;
  logPath: string;
  startedAt: number;
  status: "running" | "exited";
  exitCode: number | null;
}
