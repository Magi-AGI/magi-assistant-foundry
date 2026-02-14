/**
 * Video capture coordinator — receives base64-encoded WebM chunks from Foundry module,
 * decodes them, and writes to files.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';

// WebM/EBML header signature: first 4 bytes of any WebM file
const EBML_HEADER = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

const ROTATION_COOLDOWN_MS = 30_000;

export class VideoCaptureCoordinator {
  private outputStream: fs.WriteStream | null = null;
  private filePath: string | null = null;
  private startTime: string | null = null;
  private totalBytes = 0;
  private chunkCount = 0;
  private backpressured = false;
  private lastRotationTime = 0;

  /** Handle an incoming video chunk from the Foundry module. */
  handleChunk(base64Data: string, timestamp: string): void {
    try {
      const buffer = Buffer.from(base64Data, 'base64');

      // Detect WebM header: if we see a new EBML header after the first chunk,
      // the browser was refreshed — rotate to a new file to avoid container corruption.
      if (this.outputStream && this.chunkCount > 0 && buffer.length >= 4 &&
          buffer[0] === EBML_HEADER[0] && buffer[1] === EBML_HEADER[1] &&
          buffer[2] === EBML_HEADER[2] && buffer[3] === EBML_HEADER[3]) {
        const now = Date.now();
        if (now - this.lastRotationTime < ROTATION_COOLDOWN_MS) {
          logger.warn('Video capture: rapid EBML header rotation (within cooldown) — rotating anyway to prevent corruption');
        }
        logger.info('Video capture: detected new EBML header mid-stream (browser refresh?) — rotating file');
        this.lastRotationTime = now;
        this.stop();
        // Fall through: startNewFile + write this header chunk as the first chunk of the new file
      }

      if (!this.outputStream) {
        this.startNewFile(timestamp);
      }

      // Drop chunks while backpressured to prevent memory buildup
      if (this.backpressured) {
        logger.debug('Video capture: dropping chunk (backpressured)');
        return;
      }

      const ok = this.outputStream!.write(buffer);
      this.totalBytes += buffer.length;
      this.chunkCount++;

      if (!ok) {
        this.backpressured = true;
        logger.warn('Video capture: backpressure detected, pausing until drain');
        this.outputStream!.once('drain', () => {
          this.backpressured = false;
          logger.debug('Video capture: drain received, resuming');
        });
      }

      if (this.chunkCount % 100 === 0) {
        logger.debug(`Video capture: ${this.chunkCount} chunks, ${(this.totalBytes / 1024 / 1024).toFixed(1)} MB`);
      }
    } catch (err) {
      logger.error('Video capture: failed to write chunk:', err);
    }
  }

  private startNewFile(timestamp: string): void {
    const config = getConfig();
    const videoDir = config.videoDir;

    // Ensure directory exists
    fs.mkdirSync(videoDir, { recursive: true });

    // Use full ISO timestamp for unique filename per session (no append = valid WebM)
    const safeName = new Date().toISOString().replace(/[:.]/g, '-');
    this.filePath = path.join(videoDir, `${safeName}-session.webm`);
    this.startTime = timestamp;
    this.totalBytes = 0;
    this.chunkCount = 0;
    this.backpressured = false;

    // flags: 'w' (not 'a') — each session gets a fresh file to produce valid WebM
    this.outputStream = fs.createWriteStream(this.filePath, { flags: 'w' });
    this.outputStream.on('error', (err) => {
      logger.error('Video capture: write stream error:', err);
    });

    logger.info(`Video capture: writing to ${this.filePath}`);
  }

  /** Get current capture status. */
  getStatus(): { active: boolean; filePath: string | null; startTime: string | null; totalBytes: number } {
    return {
      active: this.outputStream !== null,
      filePath: this.filePath,
      startTime: this.startTime,
      totalBytes: this.totalBytes,
    };
  }

  stop(): void {
    if (this.outputStream) {
      this.outputStream.end();
      this.outputStream = null;
      this.backpressured = false;
      logger.info(`Video capture stopped: ${this.filePath} (${(this.totalBytes / 1024 / 1024).toFixed(1)} MB)`);
    }
  }
}
