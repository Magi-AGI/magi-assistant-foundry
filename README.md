# Magi Assistant Foundry

The Foundry VTT bridge for [Magi Server](https://github.com/Magi-AGI/magi-server).
It gives Magi's AI GM assistant and its [AI Director](https://github.com/Magi-AGI/magi-server/blob/main/docs/DIRECTOR.md)
a live view of a Foundry table, and a narrow, GM-approved way to act at it.

It has two parts:

- **The Magi Bridge module** (`src/video/foundry-module/`, module id `magi-bridge`).
  A Foundry v13 module that runs in the GM's browser. It reads actors, chat,
  combat and the current scene, and sends them to the sidecar. When the
  Director asks to speak or roll for an actor, it shows the GM the exact text
  or formula and does nothing unless the GM approves.
- **The sidecar** (`src/`, Node.js). A small local server that keeps the
  table's state in memory and exposes it to Magi Server as an
  [MCP](https://modelcontextprotocol.io) server: resources to read, tools to
  call.

> **Status.** The Director tools (`post_as_actor`, `roll_for_actor`,
> `get_spotlight`, `director_status`) and the dnd5e / pf2e actor data pass the
> scripted end-to-end test against a fake module, but **have not yet been
> tested in a real Foundry world.** Magi Server also does not call the sidecar
> yet: its `foundry` adapter, which would carry an approved Director action to
> these MCP tools, is a known gap (see [Magi Server](#how-it-talks-to-magi-server)
> below). Treat this as a prototype.

## How it works

```
 GM's browser (Foundry v13)          this repo, on the GM's machine            Magi Server
┌──────────────────────────┐  WS   ┌─────────────────────────────┐  MCP   ┌──────────────────┐
│ magi-bridge module       │──────▶│ sidecar                     │◀──────│ AI Director /     │
│  hooks: actors, chat,    │ :3300 │  GameStateStore (in memory) │ :3002 │ GM assistant      │
│  combat, scene           │◀──────│  MCP server  /mcp           │       │ (adapter: gap)    │
│  confirm dialog for      │       │  ActionResults (awaits GM)  │       └──────────────────┘
│  Director actions        │ :3301 │  video capture (optional)   │
└──────────────────────────┘──────▶└─────────────────────────────┘
```

- Foundry v13 has no server-side module scripts, so everything Foundry-side
  runs in the browser of the **GM**. The module stays inactive for players.
- The module opens a WebSocket to the sidecar (`ws://127.0.0.1:3300?token=…`).
  There is one active connection; a reconnect replaces the old one. A 15 s
  ping keeps it honest.
- On connect the module sends a full `gameReady` snapshot (including
  `gameSystem`), then incremental `actorUpdate`, `chatMessage`,
  `combatUpdate` and `sceneChange` messages as Foundry hooks fire. The sidecar
  caches them (chat is a 200-message ring buffer) and marks the state stale
  if the module disconnects.
- The sidecar serves MCP over Streamable HTTP at `http://127.0.0.1:3002/mcp`
  with a bearer token, or on a Unix socket if `MCP_SOCKET_PATH` is set. Each
  MCP client gets its own server instance, and state changes are pushed as
  resource-update notifications.
- Video capture is optional and off by default. When the GM enables it, the
  canvas is recorded as WebM and streamed on its own port (`3301`) to
  `VIDEO_DIR`, as training data rather than for real-time use.

### Game systems

Fate Core is the original target: actors carry aspects, skills, stunts,
stress tracks and fate points, and rolls are parsed onto the Fate ladder.
For `dnd5e` and `pf2e` worlds the module adds a `d20` block to each actor
(HP, AC, level, a short summary, and skill totals), which is what the Director
reads for D&D 5E, its first system.

## What Magi Server can use

### Resources

| URI | What it holds |
| --- | --- |
| `game://state` | The whole cached state: system, scene, combat, actors, connection |
| `game://actors`, `game://actors/{id}` | Actors, or one actor |
| `game://scene` | Current scene and tokens |
| `game://combat` | Active combat and turn order |
| `game://chat/recent` | The last 50 chat messages, with parsed Fate rolls |
| `game://video/status` | Video capture state |

### Tools

| Tool | What it does |
| --- | --- |
| `send_whisper` | Whisper a message to the GM |
| `get_actor_details` | Full details for one actor |
| `search_chat` | Case-insensitive search of recent chat |
| `get_fate_ladder` | Fate ladder label for a number |
| `list_images` | Images under `FOUNDRY_DATA_DIR` |
| `recording_start`, `recording_stop`, `recording_status` | Control optional video capture |
| `post_as_actor` | **Director.** Post an in-character message as an actor. The GM confirms first. |
| `roll_for_actor` | **Director.** Roll a dice formula for an actor and post it. The GM confirms first. |
| `get_spotlight` | **Director.** Messages and rolls per player character over recent chat, least-served first |
| `director_status` | **Director.** Connection, game system, whether actions need the GM, and actions awaiting the GM |

### The GM confirmation flow

The Director never acts at the table on its own by default. For
`post_as_actor` and `roll_for_actor`:

1. The sidecar checks the module is connected and the actor exists, then sends
   `postAsActor` / `rollForActor` to the module with a correlation id and
   `requireConfirm: true`.
2. In the GM's browser, a **Magi Director** dialog shows exactly what will be
   said, or exactly which formula will be rolled for whom.
3. If the GM approves, the module posts the chat message or evaluates the roll
   (with the actor's roll data) and posts it, flagged `magi-bridge.director`.
4. The module replies `actionResult`: `posted`, `rolled 1d20+5 = 17`,
   `declined-by-gm`, `no-actor`, or an error. The MCP tool call returns that
   result, so the caller knows whether the action happened.

The tool waits up to two minutes for the GM. If the module disconnects first,
every pending action is cancelled. Roll formulas are restricted to dice
syntax, and message text is HTML-escaped before it is shown or posted.

This is the table-side half of the approval boundary. Magi Server's
`ActionGate` is the other half: a GM or assistant GM approves the exact
content there before it is sent here at all (see the
[Director's suggest mode](https://github.com/Magi-AGI/magi-server/blob/main/docs/DIRECTOR.md)).
Setting `DIRECTOR_AUTONOMOUS=true` skips the Foundry dialog; leave it off
unless the GM has chosen to let the Director act on its own.

## How it talks to Magi Server

Magi Server is the research platform; its `director/` package is the AI
Director that models the people at a table and keeps all of them engaged.
Its `ttrpg-5e-foundry` configuration
([`director/configs/ttrpg-5e-foundry.yaml`](https://github.com/Magi-AGI/magi-server/blob/main/director/configs/ttrpg-5e-foundry.yaml))
enables a `foundry` adapter with three suggest-mode actions, which map onto
this sidecar's tools:

| Magi Server action | Sidecar tool |
| --- | --- |
| `whisper_gm` | `send_whisper` |
| `post_as_sim_player` | `post_as_actor` |
| `roll_for_sim_player` | `roll_for_actor` |

and reads the table through the resources plus `get_spotlight` and
`director_status`.

**Known gap:** the Magi Server side of this link, an adapter that connects to
`/mcp` and calls these tools once `ActionGate` has approved an action, is not
written yet. Today the sidecar can be driven by any MCP client (the
`scripts/director-test.ts` script is one), and Magi Server plays without
Foundry through its theatre-of-the-mind and built-in VTT tables.

See Magi Server's [README](https://github.com/Magi-AGI/magi-server#readme) and
[docs/DIRECTOR.md](https://github.com/Magi-AGI/magi-server/blob/main/docs/DIRECTOR.md)
for the Director itself.

## Setup

Requires Node.js 18+ and Foundry VTT v13.

1. **Install and configure the sidecar.**

   ```bash
   npm install
   cp .env.example .env
   ```

   Set `WS_AUTH_TOKEN` and `MCP_AUTH_TOKEN` to two long random strings. The
   MCP server stays off if `MCP_AUTH_TOKEN` is empty.

   | Variable | Default | Meaning |
   | --- | --- | --- |
   | `WS_PORT` | `3300` | Module game-state WebSocket |
   | `WS_AUTH_TOKEN` | | Token the module must present |
   | `VIDEO_WS_PORT` | `WS_PORT + 1` | Video WebSocket |
   | `MCP_PORT` | `3002` | MCP HTTP port |
   | `MCP_AUTH_TOKEN` | | Bearer token for `/mcp` |
   | `MCP_SOCKET_PATH` | | Unix socket instead of the port (Linux) |
   | `DIRECTOR_AUTONOMOUS` | `false` | Skip the GM confirmation dialog |
   | `VIDEO_DIR` | `./data/video` | Where video chunks go |
   | `FOUNDRY_DATA_DIR` | | Foundry Data directory, for `list_images` |

   Everything listens on `127.0.0.1` only, so the sidecar must run on the same
   machine as the GM's browser.

2. **Run it.**

   ```bash
   npm run dev          # or: npm run build && npm start
   ```

3. **Install the module into Foundry.**

   ```bash
   ./scripts/install-module.sh /path/to/FoundryVTT/Data
   ```

   This symlinks `src/video/foundry-module` into `Data/modules/magi-bridge`.
   Restart Foundry, enable **Magi Bridge** in the world's module list, and in
   its settings set the sidecar URL (`ws://127.0.0.1:3300`) and the auth
   token (the `WS_AUTH_TOKEN` value). Log in as the GM; the module connects
   and shows a notification.

4. **Point an MCP client at the sidecar:** `http://127.0.0.1:3002/mcp` with
   `Authorization: Bearer <MCP_AUTH_TOKEN>`.

## Testing

With the sidecar running (same `.env`):

```bash
npm run test:integration   # state flow end to end against a fake module
npm run test:director      # Director tools, including GM approve and decline
```

Both use a fake module in place of Foundry. The next step is a session in a
real Foundry world with a dnd5e table.

## Layout

See [CLAUDE.md](CLAUDE.md) for a file-by-file map and protocol conventions.

## License

See [LICENSE](LICENSE).
