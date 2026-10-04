// The preparation queue's process-wide state (Phase 3 checkpoint 3d): which
// applications a generator currently holds, and the global concurrency limits.
// Kept on globalThis so every route module (and hot reloads) share ONE
// registry. Both the queue workers and the synchronous prepareApplication
// register here, so the same application is never generated twice at once.

// Two jobs in progress at once: the second job's work queues behind the first's
// Ollama calls, so throughput barely changes (measured, 2 jobs: 348.7 s with 2
// workers vs 366.7 s with 1) — but both jobs show progress and PDF/database
// steps overlap generation. 3 would only add waiting (Ollama is serial).
export const PREPARATION_WORKERS = 2;
// Ollama on this machine runs one generation at a time (OLLAMA_NUM_PARALLEL=1):
// more concurrent requests only wait inside Ollama (counting against their
// timeouts) — measured: 1 and 2 give the same time for one job (206.5 s vs 206.8 s).
export const OLLAMA_CONCURRENCY = 1;
// LibreOffice instances sharing one user profile are not safe in parallel
// (measured: 3 concurrent conversions → 1 failed with no PDF); one takes ~2.3 s.
export const PDF_CONCURRENCY = 1;

export class Semaphore {
  private waiting: (() => void)[] = [];
  private running = 0;
  readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
  get inUse() {
    return this.running;
  }
}

export type StageKey = "cv" | "document" | "coverLetter" | "answers";
export type StageState = "pending" | "running" | "done" | "failed" | "skipped";

export type ActiveJob = {
  applicationId: number;
  startedAt: number;
  stages: Partial<Record<StageKey, StageState>>;
  errors: Partial<Record<StageKey, string>>;
};

export type QueueState = {
  active: Map<number, ActiveJob>;
  ollama: Semaphore;
  pdf: Semaphore;
  workers: number;
  /** Last completed per-stage timings (ms), for performance logging. */
  lastTimings: Map<number, Record<string, number>>;
};

const GLOBAL_KEY = "__jobAgentPreparationQueue";

function fresh(options: { workers?: number; ollama?: number; pdf?: number } = {}): QueueState {
  return {
    active: new Map(),
    ollama: new Semaphore(options.ollama ?? OLLAMA_CONCURRENCY),
    pdf: new Semaphore(options.pdf ?? PDF_CONCURRENCY),
    workers: options.workers ?? PREPARATION_WORKERS,
    lastTimings: new Map(),
  };
}

/** One registry per server process. */
export function queueState(): QueueState {
  const g = globalThis as unknown as Record<string, QueueState | undefined>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = fresh();
  return g[GLOBAL_KEY]!;
}

/** For tests and benchmarks: a fresh registry with chosen limits. */
export function resetQueueState(options: { workers?: number; ollama?: number; pdf?: number } = {}) {
  (globalThis as unknown as Record<string, QueueState>)[GLOBAL_KEY] = fresh(options);
}
