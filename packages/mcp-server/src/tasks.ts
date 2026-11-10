/**
 * MCP task store.
 *
 * Implements the `io.modelcontextprotocol/tasks` extension (Beta, to Core):
 * a long-running tool call returns a task handle, the client polls
 * `tasks/get`, and the server resolves the task when the work finishes.
 */

import type { McpTask, TaskStatus } from "@helix/contracts";

export interface TaskRecord {
  task: McpTask;
  /** Set once the task reaches a terminal state. */
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
  /** The tool that produced this task. */
  toolName: string;
  /** The arguments the tool was called with. */
  arguments: Record<string, unknown>;
  createdAtMs: number;
}

export class TaskStore {
  #tasks = new Map<string, TaskRecord>();
  #ttlMs: number;

  constructor(opts: { ttlMs?: number } = {}) {
    this.#ttlMs = opts.ttlMs ?? 60 * 60 * 1000;
  }

  get size(): number {
    return this.#tasks.size;
  }

  /** Create a task in the `working` state. */
  create(opts: {
    taskId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    statusMessage?: string;
    pollIntervalMs?: number;
    now?: number;
  }): TaskRecord {
    const now = opts.now ?? Date.now();
    const record: TaskRecord = {
      task: {
        taskId: opts.taskId,
        status: "working",
        ...(opts.statusMessage ? { statusMessage: opts.statusMessage } : {}),
        createdAt: new Date(now).toISOString(),
        lastUpdatedAt: new Date(now).toISOString(),
        ttlMs: this.#ttlMs,
        pollIntervalMs: opts.pollIntervalMs ?? 5000,
      },
      toolName: opts.toolName,
      arguments: opts.arguments,
      createdAtMs: now,
    };
    this.#tasks.set(opts.taskId, record);
    return record;
  }

  get(taskId: string): TaskRecord | undefined {
    const record = this.#tasks.get(taskId);
    if (!record) return undefined;
    if (Date.now() - record.createdAtMs > this.#ttlMs) {
      this.#tasks.delete(taskId);
      return undefined;
    }
    return record;
  }

  /** Move a task to a new status. */
  update(
    taskId: string,
    status: TaskStatus,
    extra: { statusMessage?: string; result?: Record<string, unknown>; error?: TaskRecord["error"] } = {},
  ): TaskRecord | undefined {
    const record = this.#tasks.get(taskId);
    if (!record) return undefined;
    record.task.status = status;
    record.task.lastUpdatedAt = new Date().toISOString();
    if (extra.statusMessage) record.task.statusMessage = extra.statusMessage;
    if (extra.result) record.result = extra.result;
    if (extra.error) record.error = extra.error;
    if (status === "completed" || status === "failed" || status === "cancelled") {
      record.task.pollIntervalMs = 0;
    }
    return record;
  }

  /** Cancel a task. Cancellation is cooperative: the work may still finish. */
  cancel(taskId: string): TaskRecord | undefined {
    const record = this.#tasks.get(taskId);
    if (!record) return undefined;
    if (record.task.status === "completed" || record.task.status === "failed") return record;
    record.task.status = "cancelled";
    record.task.lastUpdatedAt = new Date().toISOString();
    record.task.statusMessage = "Cancelled by the client.";
    return record;
  }

  /** All non-terminal tasks. */
  pending(): TaskRecord[] {
    return [...this.#tasks.values()].filter(
      (r) => r.task.status === "working" || r.task.status === "input_required",
    );
  }
}
