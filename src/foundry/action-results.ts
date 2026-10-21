/**
 * Correlates Director actions sent to the browser with the module's
 * actionResult reply, which arrives after the GM approves or declines.
 */

import { randomUUID } from 'crypto';
import type { ActionResultMessage } from '../types/index.js';

interface Waiter {
  resolve: (msg: ActionResultMessage) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ActionResults {
  private waiters = new Map<string, Waiter>();

  /** A fresh correlation id and a promise for its result. Rejects after `timeoutMs`. */
  await(timeoutMs: number): { correlationId: string; promise: Promise<ActionResultMessage> } {
    const correlationId = randomUUID();
    const promise = new Promise<ActionResultMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(correlationId);
        reject(new Error(`no answer from Foundry within ${Math.round(timeoutMs / 1000)}s (the GM may not have decided yet)`));
      }, timeoutMs);
      this.waiters.set(correlationId, { resolve, timer });
    });
    return { correlationId, promise };
  }

  apply(msg: ActionResultMessage): void {
    const waiter = this.waiters.get(msg.correlationId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.waiters.delete(msg.correlationId);
    waiter.resolve(msg);
  }

  get pending(): number {
    return this.waiters.size;
  }

  /** Fail everything in flight, e.g. when the module disconnects. */
  cancelAll(reason: string): void {
    for (const [id, waiter] of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve({ type: 'actionResult', correlationId: id, ok: false, detail: reason });
    }
    this.waiters.clear();
  }
}
