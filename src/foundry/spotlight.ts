/**
 * Spotlight: who at the table has been acting, from recent chat.
 *
 * The AI Director's core signal for a live table. A player-owned actor that
 * has not spoken or rolled in a while is someone the GM may want to invite
 * in. Counts in-character messages and rolls by speaking actor; GM-only
 * whispers never reach the store, so the assistant's own advice is not counted.
 */

import type { ChatMessageRecord, FateActor } from '../types/index.js';

export interface SpotlightEntry {
  actorId: string;
  name: string;
  turns: number;
  share: number;
  /** Messages since this actor last spoke or rolled; null if not in the window. */
  messagesSince: number | null;
}

export function computeSpotlight(chat: ChatMessageRecord[], actors: FateActor[], window = 60): SpotlightEntry[] {
  const recent = chat.slice(-window);
  const players = actors.filter((a) => a.playerOwned ?? a.type === 'character');
  const counts = new Map<string, number>();
  const last = new Map<string, number>();
  recent.forEach((msg, i) => {
    if (!msg.speakerActorId || msg.isGm && !players.some((p) => p.id === msg.speakerActorId)) return;
    counts.set(msg.speakerActorId, (counts.get(msg.speakerActorId) ?? 0) + 1);
    last.set(msg.speakerActorId, i);
  });
  const total = players.reduce((n, p) => n + (counts.get(p.id) ?? 0), 0);
  return players
    .map((p) => ({
      actorId: p.id,
      name: p.name,
      turns: counts.get(p.id) ?? 0,
      share: total ? (counts.get(p.id) ?? 0) / total : 0,
      messagesSince: last.has(p.id) ? recent.length - 1 - (last.get(p.id) as number) : null,
    }))
    .sort((a, b) => a.turns - b.turns);
}
