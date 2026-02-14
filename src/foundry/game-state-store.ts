/**
 * In-memory cache of Foundry game state.
 * Updated by WebSocket events, read by MCP resources.
 * Emits 'stateChanged' with affected resource URIs for MCP push notifications.
 */

import { EventEmitter } from 'events';
import { logger } from '../logger.js';
import type {
  FateActor,
  GameState,
  ChatMessageRecord,
  FoundryScene,
  FoundryCombat,
} from '../types/index.js';

const CHAT_RING_BUFFER_SIZE = 200;
const DEBOUNCE_MS = 500;

export interface GameStateStoreEvents {
  stateChanged: [uris: string[]];
}

export class GameStateStore extends EventEmitter<GameStateStoreEvents> {
  private state: GameState = {
    worldId: null,
    actors: new Map(),
    scene: null,
    combat: null,
    chatHistory: [],
    connectedAt: null,
  };

  // Debounce: coalesce rapid state changes (e.g., token drags) into one notification
  private pendingUris = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Replace entire state from a gameReady payload. */
  applyGameReady(payload: {
    worldId?: string;
    actors: Record<string, FateActor>;
    scene: FoundryScene | null;
    combat: FoundryCombat | null;
    chatHistory: ChatMessageRecord[];
  }): void {
    // Detect world change: if the Foundry server was rebooted with a different world,
    // clear all state to prevent cross-campaign data leaks.
    const incomingWorldId = payload.worldId ?? null;
    if (this.state.worldId !== null && incomingWorldId !== null &&
        this.state.worldId !== incomingWorldId) {
      logger.warn(`GameStateStore: world changed (${this.state.worldId} → ${incomingWorldId}), clearing stale state`);
    }

    this.state.worldId = incomingWorldId;
    this.state.actors = new Map(Object.entries(payload.actors));
    this.state.scene = payload.scene;
    this.state.combat = payload.combat;
    this.state.chatHistory = payload.chatHistory.slice(-CHAT_RING_BUFFER_SIZE);
    this.state.connectedAt = new Date().toISOString();

    logger.info(`GameStateStore: gameReady — ${this.state.actors.size} actors, scene=${payload.scene?.name ?? 'none'}, world=${incomingWorldId ?? 'unknown'}`);

    // Full snapshot: flush immediately (no debounce)
    this.notifyChanged([
      'game://state',
      'game://actors',
      'game://scene',
      'game://combat',
      'game://chat/recent',
    ], true);
  }

  /** Append a chat message to the ring buffer. */
  applyChatMessage(msg: ChatMessageRecord): void {
    this.state.chatHistory.push(msg);
    if (this.state.chatHistory.length > CHAT_RING_BUFFER_SIZE) {
      this.state.chatHistory.shift();
    }
    this.notifyChanged(['game://chat/recent']);
  }

  /** Update an existing chat message in the ring buffer (e.g., revised Fate roll). */
  applyChatMessageUpdate(msg: ChatMessageRecord): void {
    const idx = this.state.chatHistory.findIndex((m) => m.id === msg.id);
    if (idx !== -1) {
      this.state.chatHistory[idx] = msg;
      this.notifyChanged(['game://chat/recent']);
    }
  }

  /** Replace an actor entirely. */
  applyActorUpdate(actorId: string, actor: FateActor): void {
    this.state.actors.set(actorId, actor);
    this.notifyChanged([
      'game://actors',
      `game://actors/${actorId}`,
    ]);
  }

  /** Replace combat state. */
  applyCombatUpdate(combat: FoundryCombat | null): void {
    this.state.combat = combat;
    this.notifyChanged(['game://combat']);
  }

  /** Replace active scene. */
  applySceneChange(scene: FoundryScene | null): void {
    this.state.scene = scene;
    this.notifyChanged(['game://scene']);
  }

  // --- Debounced notification ---

  /**
   * Coalesce rapid state changes into a single 'stateChanged' emission.
   * Token drags can fire dozens of updateActor hooks per second — this
   * prevents a notification storm to MCP subscribers.
   */
  private notifyChanged(uris: string[], immediate = false): void {
    for (const uri of uris) {
      this.pendingUris.add(uri);
    }

    if (immediate) {
      this.flushNotifications();
      return;
    }

    // Reset debounce timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.flushNotifications();
    }, DEBOUNCE_MS);
  }

  private flushNotifications(): void {
    if (this.pendingUris.size === 0) return;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    const uris = Array.from(this.pendingUris);
    this.pendingUris.clear();
    this.emit('stateChanged', uris);
  }

  // --- Read methods ---

  getState(): GameState {
    return this.state;
  }

  getActor(id: string): FateActor | undefined {
    return this.state.actors.get(id);
  }

  getActors(): FateActor[] {
    return Array.from(this.state.actors.values());
  }

  getCombat(): FoundryCombat | null {
    return this.state.combat;
  }

  getScene(): FoundryScene | null {
    return this.state.scene;
  }

  getRecentChat(n: number = 50): ChatMessageRecord[] {
    return this.state.chatHistory.slice(-n);
  }

  isConnected(): boolean {
    return this.state.connectedAt !== null;
  }

  /** Mark state as stale when the Foundry module disconnects. */
  markDisconnected(): void {
    if (this.state.connectedAt === null) return; // Already disconnected
    this.state.connectedAt = null;
    logger.info('GameStateStore: Foundry module disconnected — state marked stale');
    this.notifyChanged(['game://state'], true);
  }
}
