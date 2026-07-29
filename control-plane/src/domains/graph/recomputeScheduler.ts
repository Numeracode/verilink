// control-plane/src/domains/graph/recomputeScheduler.ts
import { logger } from '../../shared/logger.js';
import { config } from '../../config.js';
import { recomputeNow } from './scoreComputationService.js';

export type RecomputeFn = (evaluationTime: Date) => Promise<unknown>;

export interface RecomputeSchedulerOptions {
  debounceMs?: number;
  intervalMs?: number;
  recompute?: RecomputeFn;
}

/**
 * In-process single-flight score recompute scheduler (Plan 6).
 * Debounced ingest dirty + hourly tick; stop drains ≤1 dirty rerun.
 */
export class RecomputeScheduler {
  private running = false;
  private dirty = false;
  private stopping = false;
  private started = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private activeRun: Promise<void> | null = null;

  private readonly debounceMs: number;
  private readonly intervalMs: number;
  private readonly recompute: RecomputeFn;

  constructor(opts: RecomputeSchedulerOptions = {}) {
    this.debounceMs = opts.debounceMs ?? config.scoreRecompute.debounceMs;
    this.intervalMs = opts.intervalMs ?? config.scoreRecompute.intervalMs;
    this.recompute = opts.recompute ?? ((t) => recomputeNow(t));
  }

  start(): void {
    this.stopping = false;
    this.started = true;
    if (this.intervalTimer) return;
    this.intervalTimer = setInterval(() => {
      if (this.stopping) return;
      void this.kick();
    }, this.intervalMs);
    // Allow Node test runners to exit if a suite forgets stop().
    this.intervalTimer.unref?.();
  }

  /** After successful attestation ingest — coalesce via debounce when idle. */
  markDirty(): void {
    // No-op until start() so integration suites that only exercise ingest
    // do not schedule background recomputes against a test pool.
    if (this.stopping || !this.started) return;
    if (this.running) {
      this.dirty = true;
      return;
    }
    this.scheduleDebounce();
  }

  private scheduleDebounce(): void {
    if (this.stopping || this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this.stopping) return;
      void this.kick();
    }, this.debounceMs);
  }

  /** Entry used by hourly tick and debounce. */
  kick(): Promise<void> {
    if (this.stopping && !this.running) {
      return Promise.resolve();
    }
    if (this.running) {
      this.dirty = true;
      return this.activeRun ?? Promise.resolve();
    }
    this.running = true;
    this.activeRun = this.runLoop().finally(() => {
      this.running = false;
      this.activeRun = null;
    });
    return this.activeRun;
  }

  private async runLoop(): Promise<void> {
    // Normal loop: repeat while dirty and not stopping.
    for (;;) {
      this.dirty = false;
      const evaluationTime = new Date();
      try {
        await this.recompute(evaluationTime);
      } catch (err) {
        logger.error({ err }, 'score recompute failed');
      }

      if (this.dirty && !this.stopping) {
        continue;
      }
      break;
    }

    // Shutdown drain: at most one already-dirty rerun.
    if (this.stopping && this.dirty) {
      this.dirty = false;
      try {
        await this.recompute(new Date());
      } catch (err) {
        logger.error({ err }, 'score recompute failed (shutdown drain)');
      }
      // Discard dirty set during the drain rerun.
      this.dirty = false;
    }
  }

  /**
   * stop accepting triggers → cancel timers → await active → drain ≤1 dirty → exit.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }

    if (this.activeRun) {
      await this.activeRun;
      return;
    }

    // Idle but dirty (e.g. debounce cancelled before fire): drain one.
    if (this.dirty) {
      this.running = true;
      this.dirty = false;
      try {
        await this.recompute(new Date());
      } catch (err) {
        logger.error({ err }, 'score recompute failed (shutdown idle drain)');
      } finally {
        this.dirty = false;
        this.running = false;
      }
    }
  }

  /** Test helpers */
  get isRunning(): boolean {
    return this.running;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  get isStopping(): boolean {
    return this.stopping;
  }
}

let defaultScheduler: RecomputeScheduler | null = null;

export function getRecomputeScheduler(): RecomputeScheduler {
  if (!defaultScheduler) {
    defaultScheduler = new RecomputeScheduler();
  }
  return defaultScheduler;
}

export function setRecomputeSchedulerForTests(scheduler: RecomputeScheduler | null): void {
  defaultScheduler = scheduler;
}
