/** WebSocket protocol types between Foundry module and sidecar. */

import type { FateActor } from './fate-core.js';
import type { FoundryScene, FoundryCombat } from '../foundry/types.js';
import type { ChatMessageRecord } from './game-state.js';

// --- Messages from Foundry module → Sidecar ---

export interface GameReadyMessage {
  type: 'gameReady';
  worldId?: string;
  /** Foundry game system id (game.system.id). */
  gameSystem?: string;
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

export interface RecordingStatusMessage {
  type: 'recordingStatus';
  recording: boolean;
  /** Why the state changed: 'started', 'stopped', 'blocked-no-gm', 'blocked-gate', 'blocked-no-canvas', 'snapshot' (sent on connect/queryState), etc. */
  reason: string;
  /** Echoed from a sidecar-driven recordingControl message, when applicable. */
  correlationId?: string;
}

/** The outcome of a Director action (postAsActor / rollForActor) after the GM's decision. */
export interface ActionResultMessage {
  type: 'actionResult';
  correlationId: string;
  ok: boolean;
  /** 'posted', 'rolled', 'declined-by-gm', 'no-actor', 'error: …' */
  detail: string;
}

export type ModuleMessage =
  | GameReadyMessage
  | ChatMessageMessage
  | ChatMessageUpdateMessage
  | ActorUpdateMessage
  | CombatUpdateMessage
  | SceneChangeMessage
  | VideoChunkMessage
  | PongMessage
  | RecordingStatusMessage
  | ActionResultMessage;

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

export interface RecordingControlMessage {
  type: 'recordingControl';
  action: 'start' | 'stop';
  /** Optional caller-supplied id; the browser echoes it back in the resulting recordingStatus so callers can correlate request/response. */
  correlationId?: string;
}

/**
 * AI Director: speak as an actor (a simulated player's character, or an NPC).
 * Unless the sidecar runs with DIRECTOR_AUTONOMOUS=true, the module asks the GM
 * to approve this exact text before posting it.
 */
export interface PostAsActorMessage {
  type: 'postAsActor';
  actorId: string;
  content: string;
  correlationId: string;
  requireConfirm: boolean;
}

/** AI Director: roll for an actor, with the same GM confirmation. */
export interface RollForActorMessage {
  type: 'rollForActor';
  actorId: string;
  formula: string;
  flavor?: string;
  correlationId: string;
  requireConfirm: boolean;
}

export type SidecarMessage =
  | WhisperMessage
  | PostAsActorMessage
  | RollForActorMessage
  | QueryStateMessage
  | PingMessage
  | RecordingControlMessage;
