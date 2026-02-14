# Magi Assistant Foundry

## Project
Foundry VTT bridge sidecar — captures Fate Core game state (actors, chat, combat, scenes, video) from the GM's browser via WebSocket, then exposes it via MCP server for the AI GM Assistant.

## Tech Stack
- TypeScript + Node.js
- WebSocket (ws) for Foundry VTT module communication
- @modelcontextprotocol/sdk for MCP server (SSE transport)
- Zod for MCP tool input schemas

## Build & Run
- `npm run build` — compile TypeScript
- `npm run dev` — run with tsx (development)
- `npm start` — run compiled JS (production)
- `npm run test:integration` — run integration test (requires sidecar running)

## Project Structure
- `src/index.ts` — entry point, wires WS events → store → MCP
- `src/config.ts` — config loader (.env)
- `src/logger.ts` — log sanitizer with secret redaction
- `src/types/` — all TypeScript types
  - `fate-core.ts` — FateActor, FateAspect, FateSkill, FateStunt, FateTrack, FateRollResult
  - `game-state.ts` — GameState, ChatMessageRecord, ChatRoll
  - `protocol.ts` — ModuleMessage/SidecarMessage discriminated unions
- `src/foundry/` — Foundry VTT integration
  - `ws-server.ts` — WebSocket server (127.0.0.1:3300), token auth, ping/pong
  - `game-state-store.ts` — in-memory cache, EventEmitter for state changes
  - `fate-parser.ts` — Fate roll parsing, ladder labels
  - `types.ts` — FoundryScene, FoundryToken, FoundryCombat, FoundryCombatant
- `src/mcp/` — MCP server
  - `server.ts` — SSE transport, Bearer token auth, UDS support
  - `resources.ts` — game://state, actors, scene, combat, chat/recent, video/status
  - `tools.ts` — send_whisper, get_actor_details, search_chat, get_fate_ladder
  - `live-events.ts` — state change → MCP resource update notifications
- `src/video/` — Video capture
  - `capture.ts` — VideoCaptureCoordinator (base64 → WebM files)
  - `foundry-module/` — Foundry VTT module (browser JS, no build step)
    - `module.json` — Foundry module manifest (id: magi-bridge, v13)
    - `scripts/magi-bridge.mjs` — MagiBridge class (WS, hooks, serializers, video)
    - `lang/en.json` — localization strings
- `scripts/`
  - `install-module.sh` — symlink module into Foundry Data/modules
  - `integration-test.ts` — automated end-to-end test

## Architecture
- Foundry v13 has NO server-side module scripts — everything runs in GM's browser
- Module connects to sidecar via WebSocket (single active connection)
- Sidecar maintains in-memory game state cache (GameStateStore)
- MCP server exposes state as resources and tools for the GM Assistant
- Video capture is optional (training data, not real-time)

## Key Conventions
- WebSocket protocol uses typed JSON messages (ModuleMessage / SidecarMessage)
- Token auth on both WS (?token=) and MCP (Bearer / ?token= for SSE)
- Single active WS connection (new replaces old — reconnect-friendly)
- Ping/pong heartbeat: 15s interval, 10s timeout
- Chat ring buffer: 200 messages max
- Fate Core actor data uses UUID-keyed objects, not arrays
