// control-plane/src/domains/sync/sseWriteQueue.ts
import type { Response } from 'express';
import { EventEmitter } from 'node:events';

export type EnqueueResult = 'ok' | 'oversized' | 'closed' | 'full';

export interface SseWriteQueueOptions {
  maxFrames: number;
  maxBytes: number;
  maxFrameBytes: number;
  slowClientMs: number;
  onSlowClient?: () => void;
}

interface DataItem {
  frame: string;
  cursor?: bigint;
}

/**
 * Bounded outbound SSE queue: frame count + byte budget for data frames,
 * dedicated control lane for shutdown (never dropped by data caps).
 */
export class SseWriteQueue extends EventEmitter {
  private readonly data: DataItem[] = [];
  private dataBytes = 0;
  /** Bytes handed to res.write but not yet drained (backpressure). */
  private inflightBytes = 0;
  private control: string | null = null;
  private pumping = false;
  private closed = false;
  private waitingForDrain = false;
  private slowTimer: ReturnType<typeof setTimeout> | null = null;
  private lastWrittenCursor: bigint | null = null;

  constructor(
    private readonly res: Response,
    private readonly opts: SseWriteQueueOptions
  ) {
    super();
    this.res.on('drain', () => {
      this.waitingForDrain = false;
      this.inflightBytes = 0;
      this.clearSlowTimer();
      this.emit('space');
      void this.pump();
    });
    this.res.on('close', () => this.close());
    this.res.on('error', () => this.close());
  }

  get pendingFrames(): number {
    return this.data.length + (this.control ? 1 : 0);
  }

  get pendingBytes(): number {
    return (
      this.dataBytes +
      this.inflightBytes +
      (this.control ? Buffer.byteLength(this.control) : 0)
    );
  }

  get writtenCursor(): bigint | null {
    return this.lastWrittenCursor;
  }

  private schedulePump(): void {
    if (this.waitingForDrain || this.closed) return;
    queueMicrotask(() => void this.pump());
  }

  /** Enqueue a data frame (durable event, cursor, or ping). */
  enqueueData(frame: string, cursor?: bigint): EnqueueResult {
    if (this.closed) return 'closed';
    const size = Buffer.byteLength(frame);
    if (size > this.opts.maxFrameBytes || size > this.opts.maxBytes) {
      return 'oversized';
    }
    if (
      this.data.length >= this.opts.maxFrames ||
      this.dataBytes + this.inflightBytes + size > this.opts.maxBytes
    ) {
      return 'full';
    }
    this.data.push({ frame, cursor });
    this.dataBytes += size;
    this.schedulePump();
    return 'ok';
  }

  /** Control lane — always accepted (overwrites prior pending shutdown). */
  enqueueControl(frame: string): EnqueueResult {
    if (this.closed) return 'closed';
    this.control = frame;
    this.schedulePump();
    return 'ok';
  }

  /** Wait until there is capacity for a frame of `size` bytes, or closed. */
  async waitForSpace(size: number, signal?: AbortSignal): Promise<'ok' | 'closed'> {
    if (size > this.opts.maxFrameBytes || size > this.opts.maxBytes) {
      return 'closed';
    }
    for (;;) {
      if (this.closed) return 'closed';
      if (
        this.data.length < this.opts.maxFrames &&
        this.dataBytes + this.inflightBytes + size <= this.opts.maxBytes
      ) {
        return 'ok';
      }
      try {
        await new Promise<void>((resolve, reject) => {
          const onSpace = () => {
            cleanup();
            resolve();
          };
          const onClose = () => {
            cleanup();
            resolve();
          };
          const onAbort = () => {
            cleanup();
            reject(new Error('aborted'));
          };
          const cleanup = () => {
            this.off('space', onSpace);
            this.off('closed', onClose);
            signal?.removeEventListener('abort', onAbort);
          };
          this.on('space', onSpace);
          this.on('closed', onClose);
          signal?.addEventListener('abort', onAbort, { once: true });
        });
      } catch {
        return 'closed';
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearSlowTimer();
    this.emit('closed');
    this.emit('space');
  }

  private clearSlowTimer(): void {
    if (this.slowTimer) {
      clearTimeout(this.slowTimer);
      this.slowTimer = null;
    }
  }

  private armSlowTimer(): void {
    if (this.slowTimer || this.closed) return;
    this.slowTimer = setTimeout(() => {
      this.slowTimer = null;
      this.opts.onSlowClient?.();
      this.close();
      try {
        this.res.end();
      } catch {
        /* ignore */
      }
    }, this.opts.slowClientMs);
  }

  private safeWrite(chunk: string): boolean | 'error' {
    try {
      return this.res.write(chunk);
    } catch {
      return 'error';
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.closed || this.waitingForDrain) return;
    this.pumping = true;
    try {
      while (!this.closed && !this.waitingForDrain) {
        if (this.control !== null) {
          const next = this.control;
          this.control = null;
          const ok = this.safeWrite(next);
          if (ok === 'error') {
            this.close();
            break;
          }
          if (!ok) {
            this.inflightBytes += Buffer.byteLength(next);
            this.waitingForDrain = true;
            this.armSlowTimer();
            break;
          }
          continue;
        }
        const item = this.data[0];
        if (!item) break;
        this.data.shift();
        this.dataBytes -= Buffer.byteLength(item.frame);
        const ok = this.safeWrite(item.frame);
        if (ok === 'error') {
          this.close();
          break;
        }
        if (item.cursor !== undefined) {
          if (this.lastWrittenCursor === null || item.cursor > this.lastWrittenCursor) {
            this.lastWrittenCursor = item.cursor;
          }
        }
        if (!ok) {
          this.inflightBytes += Buffer.byteLength(item.frame);
          this.waitingForDrain = true;
          this.armSlowTimer();
          break;
        }
        // Capacity freed in our queue (frame left for the socket); wake waiters.
        this.emit('space');
      }
    } finally {
      this.pumping = false;
      if (!this.waitingForDrain && !this.closed && (this.control || this.data.length > 0)) {
        void this.pump();
      }
    }
  }
}

export function formatSseEvent(opts: {
  event?: string;
  id?: string | bigint;
  data: string;
}): string {
  let out = '';
  if (opts.id !== undefined) out += `id: ${opts.id}\n`;
  if (opts.event) out += `event: ${opts.event}\n`;
  out += `data: ${opts.data}\n\n`;
  return out;
}

export function formatSseComment(text: string): string {
  return `: ${text}\n\n`;
}
