/**
 * In-process mirror of the browser-side video recording state.
 *
 * The browser-side magi-bridge module is the source of truth: it owns the
 * MediaRecorder. The sidecar mirrors the state so MCP tools can answer
 * recording_status synchronously and so recording_start/recording_stop can
 * await a confirming recordingStatus message before resolving.
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { logger } from '../logger.js';
import type { RecordingStatusMessage } from '../types/index.js';

export interface RecordingStateSnapshot {
  /** True iff the browser confirmed it is actively recording. */
  recording: boolean;
  /** ISO timestamp of the last state mutation (transition or snapshot). */
  lastChangedAt: string;
  /** Reason string from the most recent status update. */
  lastReason: string;
  /** True iff we have ever received a status from the browser since startup. */
  knownToBrowser: boolean;
}

interface RecordingStateEvents {
  status: [snapshot: RecordingStateSnapshot, correlationId: string | undefined];
}

export class RecordingStateStore extends EventEmitter<RecordingStateEvents> {
  private state: RecordingStateSnapshot = {
    recording: false,
    lastChangedAt: new Date().toISOString(),
    lastReason: 'init',
    knownToBrowser: false,
  };

  /** Current state snapshot. */
  get snapshot(): RecordingStateSnapshot {
    return { ...this.state };
  }

  /** Apply a recordingStatus message from the browser. */
  apply(msg: RecordingStatusMessage): void {
    const next: RecordingStateSnapshot = {
      recording: msg.recording,
      lastChangedAt: new Date().toISOString(),
      lastReason: msg.reason,
      knownToBrowser: true,
    };
    this.state = next;
    logger.debug(`Recording state: ${next.recording ? 'recording' : 'stopped'} (${next.lastReason})`);
    this.emit('status', { ...next }, msg.correlationId);
  }

  /**
   * Mark state as unknown (browser disconnected). The MediaRecorder may still
   * be running on the page until the page reloads — but since the page can no
   * longer reach us, treat status as not-known. Subsequent tool calls will
   * report disconnected.
   */
  markDisconnected(): void {
    if (!this.state.knownToBrowser) return;
    this.state = {
      recording: false,
      lastChangedAt: new Date().toISOString(),
      lastReason: 'disconnected',
      knownToBrowser: false,
    };
    logger.debug('Recording state: cleared (browser disconnected)');
  }

  /**
   * Generate a fresh correlation id and return a promise that resolves with the
   * next recordingStatus echoing that id, or rejects on timeout. Used by the
   * recording_start / recording_stop MCP tools to make their replies meaningful.
   */
  awaitNextStatusForCorrelation(timeoutMs: number): { correlationId: string; promise: Promise<RecordingStateSnapshot> } {
    const correlationId = randomUUID();
    const promise = new Promise<RecordingStateSnapshot>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('status', listener);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for browser recordingStatus`));
      }, timeoutMs);

      const listener = (snapshot: RecordingStateSnapshot, echoedId: string | undefined): void => {
        if (echoedId !== correlationId) return;
        clearTimeout(timer);
        this.off('status', listener);
        resolve(snapshot);
      };
      this.on('status', listener);
    });
    return { correlationId, promise };
  }
}
