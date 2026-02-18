import { config as dotenvConfig } from 'dotenv';
import { registerSecret } from './logger.js';

dotenvConfig();

export interface FoundryConfig {
  wsPort: number;
  wsToken: string;
  mcpPort: number;
  mcpSocketPath: string;
  mcpAuthToken: string;
  videoDir: string;
  /** Root of the Foundry VTT Data directory (for image enumeration). */
  foundryDataDir: string;
}

let _config: FoundryConfig | null = null;

export function getConfig(): FoundryConfig {
  if (_config) return _config;

  const wsToken = process.env.WS_AUTH_TOKEN ?? '';
  const mcpAuthToken = process.env.MCP_AUTH_TOKEN ?? '';

  // Register secrets for log redaction before config creation
  if (wsToken) registerSecret(wsToken);
  if (mcpAuthToken) registerSecret(mcpAuthToken);

  _config = {
    wsPort: parseInt(process.env.WS_PORT ?? '3300', 10) || 3300,
    wsToken,
    mcpPort: parseInt(process.env.MCP_PORT ?? '3002', 10) || 3002,
    mcpSocketPath: process.env.MCP_SOCKET_PATH ?? '',
    mcpAuthToken,
    videoDir: process.env.VIDEO_DIR ?? './data/video',
    foundryDataDir: process.env.FOUNDRY_DATA_DIR ?? '',
  };

  return _config;
}
