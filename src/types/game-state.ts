/** Game state types for the in-memory store. */

import type { FateActor, FateRollResult } from './fate-core.js';
import type { FoundryScene, FoundryCombat } from '../foundry/types.js';

export interface ChatRoll {
  formula: string;
  total: number;
  /** Raw dice results */
  dice: number[];
}

export interface ChatMessageRecord {
  id: string;
  speakerActorId: string;
  speakerAlias: string;
  content: string;
  type: number;
  whisper: string[];
  rolls: ChatRoll[];
  parsedRoll?: FateRollResult;
  timestamp: string;
}

export interface GameState {
  worldId: string | null;
  actors: Map<string, FateActor>;
  scene: FoundryScene | null;
  combat: FoundryCombat | null;
  chatHistory: ChatMessageRecord[];
  connectedAt: string | null;
}
