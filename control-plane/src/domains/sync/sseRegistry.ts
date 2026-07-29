// control-plane/src/domains/sync/sseRegistry.ts
import type { SseWriteQueue } from './sseWriteQueue.js';
import { formatSseEvent } from './sseWriteQueue.js';

export interface SseConnection {
  id: string;
  queue: SseWriteQueue;
  abort: AbortController;
  cleanup: () => void;
}

/**
 * Tracks active SSE connections for admission control and graceful shutdown.
 */
export class SseRegistry {
  private readonly connections = new Map<string, SseConnection>();
  private accepting = true;
  private nextId = 1;

  get size(): number {
    return this.connections.size;
  }

  get isAccepting(): boolean {
    return this.accepting;
  }

  stopAccepting(): void {
    this.accepting = false;
  }

  startAccepting(): void {
    this.accepting = true;
  }

  tryRegister(
    queue: SseWriteQueue,
    abort: AbortController,
    cleanup: () => void
  ): SseConnection | null {
    if (!this.accepting) return null;
    const id = `sse-${this.nextId++}`;
    const conn: SseConnection = { id, queue, abort, cleanup };
    this.connections.set(id, conn);
    return conn;
  }

  unregister(id: string): void {
    this.connections.delete(id);
  }

  async shutdownAll(drainMs: number): Promise<void> {
    this.stopAccepting();
    const frame = formatSseEvent({ event: 'shutdown', data: '{}' });
    const conns = [...this.connections.values()];
    for (const c of conns) {
      c.queue.enqueueControl(frame);
    }
    const deadline = Date.now() + drainMs;
    while (Date.now() < deadline && this.connections.size > 0) {
      await new Promise((r) => setTimeout(r, 25));
    }
    for (const c of [...this.connections.values()]) {
      c.abort.abort();
      c.queue.close();
      c.cleanup();
      this.connections.delete(c.id);
    }
  }
}

let registry = new SseRegistry();

export function getSseRegistry(): SseRegistry {
  return registry;
}

/** Test helper — replace singleton. */
export function setSseRegistryForTests(next: SseRegistry): void {
  registry = next;
}
