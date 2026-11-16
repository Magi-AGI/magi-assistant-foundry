/**
 * Questions people asked the MAGI advisor from Foundry's MAGI tab, numbered so
 * Magi Server's advisor reads only what is new. Magi Server long-polls
 * (`advisor_inbox` with `waitMs`), and whether it has polled lately is what the
 * MAGI tab shows as "advisor online".
 */

import type { AdvisorAsk } from '../types/index.js';

const MAX_ASKS = 300;
/** Magi Server counts as serving while it has polled within this window (it re-polls at least every ~25 s). */
export const SERVING_WINDOW_MS = 45_000;

export interface NumberedAsk {
  seq: number;
  at: string;
  ask: AdvisorAsk;
  /** Whether the advisor has answered it (advisor_say with this ask as replyTo succeeded). */
  answered: boolean;
}

export class AdvisorInbox {
  private asks: NumberedAsk[] = [];
  private nextSeq = 1;
  private waiters = new Set<() => void>();
  private lastPollAt = 0;
  private polling = 0;

  push(ask: AdvisorAsk): void {
    // The bridge relays unanswered questions again when it reconnects: keep one copy.
    if (this.asks.some((a) => a.ask.id === ask.id)) return;
    this.asks.push({ seq: this.nextSeq++, at: new Date().toISOString(), ask, answered: false });
    if (this.asks.length > MAX_ASKS) this.asks.splice(0, this.asks.length - MAX_ASKS);
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  /** Asks after `after`, oldest first, and the last sequence number handed out. */
  since(after: number, limit = 50): { asks: NumberedAsk[]; last: number } {
    const asks = this.asks.filter((a) => a.seq > after).slice(0, limit);
    return { asks, last: this.nextSeq - 1 };
  }

  /** Like `since`, but if nothing is new, wait up to `waitMs` for the next ask. */
  async wait(after: number, waitMs: number, limit = 50): Promise<{ asks: NumberedAsk[]; last: number }> {
    this.lastPollAt = Date.now();
    const now = this.since(after, limit);
    if (now.asks.length || waitMs <= 0) return now;
    this.polling += 1;
    try {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { this.waiters.delete(done); resolve(); }, waitMs);
        const done = () => { clearTimeout(timer); resolve(); };
        this.waiters.add(done);
      });
    } finally {
      this.polling -= 1;
      this.lastPollAt = Date.now();
    }
    return this.since(after, limit);
  }

  /** Whether Magi Server's advisor is listening (polling now, or polled within the window). */
  get serving(): boolean {
    return this.polling > 0 || Date.now() - this.lastPollAt < SERVING_WINDOW_MS;
  }

  /** Mark a question answered, so an advisor that restarts doesn't answer it again. */
  markAnswered(id: string): void {
    for (const a of this.asks) if (a.ask.id === id) a.answered = true;
  }

  /** The last sequence number handed out. */
  get last(): number {
    return this.nextSeq - 1;
  }
}
