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
  /** Whether the GM has let the Director run this table (the "Director runs the table" setting). */
  tableControl?: boolean;
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
  /** 'posted', 'rolled', 'declined-by-gm', 'no-actor', 'table-control-off', 'error: …' */
  detail: string;
  /** Structured results, e.g. what a tableCommand created. */
  data?: unknown;
}

/** Something a person did at the table in Foundry, for the Director to act on. */
export type TableEvent =
  | { kind: 'tokenMoved'; key: string; name: string; cell: [number, number]; user: string }
  | { kind: 'chat'; user: string; text: string };

export interface TableEventMessage {
  type: 'tableEvent';
  event: TableEvent;
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
  | ActionResultMessage
  | TableEventMessage;

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

/** A square on the Director's grid: [column, row]. */
export type Cell = [number, number];

/**
 * One change to the table the Director runs: the scene and its map, tokens,
 * chat, and the Foundry users who play. Everything is keyed by the Director's
 * own names, stored on the documents as `flags.magi-bridge.key`.
 */
export type TableOp =
  | { op: 'scene'; key: string; name: string; cols: number; rows: number; background: string;
      features: { cell: Cell; w?: number; h?: number; colour: string; label: string; blocks: boolean }[] }
  | { op: 'token'; key: string; name: string; cell: Cell; colour: string; kind: 'pc' | 'foe' | 'npc';
      owners: string[]; hp?: [number, number] }
  | { op: 'move'; key: string; cell: Cell }
  | { op: 'remove'; keys: string[] }
  | { op: 'defeated'; key: string; value: boolean }
  | { op: 'hp'; key: string; value: number; max: number }
  | { op: 'line'; key: string; from: Cell; to: Cell; colour: string }
  | { op: 'chat'; speaker: string; text: string; whisperTo?: string[] }
  | { op: 'users'; users: { name: string; password: string; role: 'player' | 'assistant' }[] }
  | { op: 'userIds'; names: string[] };

/**
 * AI Director: apply table ops in order. Only honoured when the GM has turned
 * on the module's "Director runs the table" setting; there is no per-op
 * confirmation, because a map that waits for a click on every step is unplayable.
 */
export interface TableCommandMessage {
  type: 'tableCommand';
  correlationId: string;
  ops: TableOp[];
}

export type SidecarMessage =
  | WhisperMessage
  | PostAsActorMessage
  | RollForActorMessage
  | TableCommandMessage
  | QueryStateMessage
  | PingMessage
  | RecordingControlMessage;
