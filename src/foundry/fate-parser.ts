/**
 * Parse Fate rolls from chat messages.
 */

import type { FateRollResult } from '../types/fate-core.js';
import type { ChatMessageRecord } from '../types/game-state.js';

/** Fate ladder labels. */
export function fateLadder(value: number): string {
  const ladder: Record<number, string> = {
    8: 'Legendary',
    7: 'Epic',
    6: 'Fantastic',
    5: 'Superb',
    4: 'Great',
    3: 'Good',
    2: 'Fair',
    1: 'Average',
    0: 'Mediocre',
    '-1': 'Poor',
    '-2': 'Terrible',
  };
  if (value > 8) return `Beyond Legendary (+${value})`;
  if (value < -2) return `Abysmal (${value})`;
  return ladder[value] ?? `+${value}`;
}

/**
 * Attempt to parse a Fate roll from a chat message.
 * Fate rolls use 4dF (4 Fudge/Fate dice: each -1, 0, or +1) plus a modifier.
 * Returns null if the message doesn't contain a recognizable Fate roll.
 */
export function parseFateRoll(msg: ChatMessageRecord): FateRollResult | null {
  if (!msg.rolls || msg.rolls.length === 0) return null;

  const roll = msg.rolls[0];
  if (!roll) return null;

  // Fate dice produce values in [-1, 0, 1]
  const dice = roll.dice ?? [];
  const isFateRoll = dice.length === 4 && dice.every((d) => d >= -1 && d <= 1);

  if (!isFateRoll && dice.length > 0) return null;

  const diceTotal = dice.reduce((sum, d) => sum + d, 0);
  const total = roll.total ?? 0;
  const modifier = total - diceTotal;

  // Try to extract skill name from content (e.g., "Rolling Fight: 4dF+3")
  let skillName = '';
  const skillMatch = msg.content.match(/(?:Rolling|rolls?)\s+(\w[\w\s]*?)(?:\s*:|$)/i);
  if (skillMatch) {
    skillName = skillMatch[1].trim();
  }

  return {
    formula: roll.formula,
    diceValues: dice,
    modifier,
    total,
    skillName,
    ladder: fateLadder(total),
  };
}
