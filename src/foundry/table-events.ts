/**
 * What people did at the Director's table in Foundry (dragged a token, wrote
 * in chat), numbered so Magi Server can read only what is new.
 */

import type { TableEvent } from '../types/index.js';

const MAX_EVENTS = 500;

export interface NumberedTableEvent {
  seq: number;
  at: string;
  event: TableEvent;
}

export class TableEvents {
  private events: NumberedTableEvent[] = [];
  private nextSeq = 1;

  push(event: TableEvent): void {
    this.events.push({ seq: this.nextSeq++, at: new Date().toISOString(), event });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  /** Events after `after`, oldest first, and the last sequence number handed out. */
  since(after: number, limit = 100): { events: NumberedTableEvent[]; last: number } {
    const events = this.events.filter((e) => e.seq > after).slice(0, limit);
    return { events, last: this.nextSeq - 1 };
  }
}
