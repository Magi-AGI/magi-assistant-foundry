import { config as dotenvConfig } from 'dotenv';
import { registerSecret } from './logger.js';

dotenvConfig();

export interface FoundryConfig {
  wsPort: number;
  wsToken: string;
  /** Dedicated WebSocket port for video chunk traffic (default: wsPort + 1). */
  videoWsPort: number;
  mcpPort: number;
  mcpSocketPath: string;
  mcpAuthToken: string;
  videoDir: string;
  /** Root of the Foundry VTT Data directory (for image enumeration). */
  foundryDataDir: string;
  /**
   * AI Director: post and roll as actors without asking the GM each time.
   * Off by default; the GM confirms every action in Foundry (suggest mode).
   */
  directorAutonomous: boolean;
  /**
   * Address the WebSocket and MCP servers listen on. Loopback by default; a
   * container on a bridge network (Docker Desktop without host networking)
   * sets 0.0.0.0 and publishes the ports on the host's loopback only.
   */
  bindHost: string;
}

let _config: FoundryConfig | null = null;

export function getConfig(): FoundryConfig {
  if (_config) return _config;

  const wsToken = process.env.WS_AUTH_TOKEN ?? '';
  const mcpAuthToken = process.env.MCP_AUTH_TOKEN ?? '';

  // Register secrets for log redaction before config creation
  if (wsToken) registerSecret(wsToken);
  if (mcpAuthToken) registerSecret(mcpAuthToken);

  const wsPort = parseInt(process.env.WS_PORT ?? '3300', 10) || 3300;

  _config = {
    wsPort,
    wsToken,
    videoWsPort: parseInt(process.env.VIDEO_WS_PORT ?? '', 10) || (wsPort + 1),
    mcpPort: parseInt(process.env.MCP_PORT ?? '3002', 10) || 3002,
    mcpSocketPath: process.env.MCP_SOCKET_PATH ?? '',
    mcpAuthToken,
    videoDir: process.env.VIDEO_DIR ?? './data/video',
    foundryDataDir: process.env.FOUNDRY_DATA_DIR ?? '',
    directorAutonomous: process.env.DIRECTOR_AUTONOMOUS === 'true',
    bindHost: process.env.BIND_HOST || '127.0.0.1',
  };

  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(_config.bindHost);
  if (!loopback && (!wsToken || !mcpAuthToken)) {
    throw new Error(`BIND_HOST=${_config.bindHost} needs WS_AUTH_TOKEN and MCP_AUTH_TOKEN set`);
  }

  return _config;
}
