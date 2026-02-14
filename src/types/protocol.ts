/** WebSocket protocol types between Foundry module and sidecar. */

import type { FateActor } from './fate-core.js';
import type { FoundryScene, FoundryCombat } from '../foundry/types.js';
import type { ChatMessageRecord } from './game-state.js';

// --- Messages from Foundry module → Sidecar ---

export interface GameReadyMessage {
  type: 'gameReady';
  worldId?: string;
  actors: Record<string, FateActor>;
  scene: FoundryScene | null;
  combat: FoundryCombat | null;
  chatHistory: ChatMessageRecord[];
}

export interface ChatMessageMessage {
  type: 'chatMessage';
  message: ChatMessageRecord;
}

export interface ChatMessageUpdateMessage {
  type: 'chatMessageUpdate';
  message: ChatMessageRecord;
}

export interface ActorUpdateMessage {
  type: 'actorUpdate';
  actorId: string;
  actor: FateActor;
}

export interface CombatUpdateMessage {
  type: 'combatUpdate';
  combat: FoundryCombat | null;
}

export interface SceneChangeMessage {
  type: 'sceneChange';
  scene: FoundryScene | null;
}

export interface VideoChunkMessage {
  type: 'videoChunk';
  data: string;
  timestamp: string;
}

export interface PongMessage {
  type: 'pong';
}

export type ModuleMessage =
  | GameReadyMessage
  | ChatMessageMessage
  | ChatMessageUpdateMessage
  | ActorUpdateMessage
  | CombatUpdateMessage
  | SceneChangeMessage
  | VideoChunkMessage
  | PongMessage;

// --- Messages from Sidecar → Foundry module ---

export interface WhisperMessage {
  type: 'whisper';
  content: string;
  title?: string;
}

export interface QueryStateMessage {
  type: 'queryState';
}

export interface PingMessage {
  type: 'ping';
}

export type SidecarMessage =
  | WhisperMessage
  | QueryStateMessage
  | PingMessage;
