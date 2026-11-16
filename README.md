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

> **Status.** The Director tools, the table the Director runs (`table_apply`,
> `table_events`) and the dnd5e / pf2e actor data pass scripted end-to-end
> tests against a fake module, and Magi Server plays whole sessions through the
> sidecar that way, but **they have not yet been tested in a real Foundry
> world.** Treat this as a prototype.

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
| `director_status` | **Director.** Connection, game system, whether actions need the GM, whether the Director may run the table, and actions awaiting the GM |
| `table_apply` | **Director runs the table.** Apply ops in order: draw a scene's map and activate it, place / move / remove tokens, mark one defeated, set HP, draw an attack line, narrate or whisper, make Foundry users for the people seated |
| `table_events` | **Director runs the table.** Tokens people dragged and what they wrote in chat, since a sequence number |
| `advisor_inbox` | **MAGI advisor.** Questions asked in the MAGI tab since a sequence number (who, role, character, text), with an optional long-poll wait |
| `advisor_say` | **MAGI advisor.** Answer a question, or give live feedback to named users, the GMs, or everyone, in the MAGI tab |

### The MAGI tab: advisor chat for players and GMs

The module adds a **MAGI** tab to Foundry's right sidebar, for every user
(the bridge itself still runs only in the bridge GM's browser). It holds:

- **A chat with the MAGI advisor** that pops out into its own window. Anyone
  can ask; quick buttons ask the common things (a player: *My character*,
  *Explain a rule*, *Recap*, *What next?*; a GM: *Spotlight*, *Pacing*,
  *Complication*, *Recap*). MAGI's live feedback arrives here too: the
  Director's co-pilot advice for a seated person, and GM-only notes such as
  who has been quiet. A new message while the tab is closed shows a badge and,
  optionally, a notification.
- **Status**: is a bridge GM logged in, is the sidecar connected, is Magi
  Server's advisor listening, does the Director run the table.
- **Features**: for players, how to play at a Director-run table (answering in
  chat, dragging your token, `take` / `equip` / `stow`, lootable bodies); for
  GMs, the *MAGI advisor* and *Director runs the table* switches, *Sort
  Director actors*, video recording (on the bridge browser), settings, and a
  link to the MAGI dashboard (setting *MAGI dashboard URL*).

Questions and answers are whispered chat messages flagged
`flags.magi-bridge.advisor`, so Foundry settles who asked (a user can only
write as themselves) and who sees what:

| Who asks | Question seen by | Answer seen by |
| --- | --- | --- |
| a player | them and the GMs | them and the GMs |
| a GM | GMs only | GMs only |

An answer counts only if a GM wrote it (the bridge GM posts MAGI's words),
so a player can't fake one, and a player can't ask for GM-only advice. These
messages are hidden from the chat log (each user can turn on *Show MAGI
advisor messages in chat*) and are never passed to the Director as table talk.

The bridge relays each question to the sidecar (`advisorAsk`); Magi Server's
advisor (`director/advisor.py`) long-polls `advisor_inbox` and answers with
`advisor_say`. Questions asked while the bridge was down are relayed when it
reconnects (up to ten minutes old); the sidecar marks answered questions, so a
restarted advisor doesn't answer twice. A GM can switch the advisor off with
the *MAGI advisor* setting.

Everything the Director makes is filed under **Magi Director**. In Actors it
is split into **Player Characters**, **NPCs** (neutral or friendly), **Foes**
(hostile) and **Lootable Bodies** (a fallen foe or bystander still carrying
something; characters stay with the party). In Scenes, the Director's scenes
go in a **Magi Director** folder. An actor moves when its kind or loot
changes. Older actors and scenes are sorted when the bridge starts, or with
*Sort Director actors*. Gear, spells and features are items embedded in those
actors, not world items, so they need no folder of their own.

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

### When the Director runs the table

Magi Server can also run a whole table on Foundry: its built-in grid is the
rules, and Foundry is the map people see and play on (Magi Server's
`director/foundry.py`, `magi director foundry`). For that the GM turns on
**Configure Settings → Magi Bridge → Director runs the table**, and the module
then applies `tableCommand` ops (`src/video/foundry-module/scripts/magi-table.mjs`)
without a dialog per step, because a map that waits for a click on every
footstep is unplayable:

- a Foundry scene per Director scene (`padding: 0`, 100 px squares, floor
  colour, features as locked drawings), activated; a scene is cleared of what
  an earlier run left when it is drawn again;
- one world actor per character, foe or bystander (folder "Magi Director",
  owned by the Foundry users who play it), with a linked token; foes are
  hostile, bystanders neutral; HP is set where the system keeps it
  (`system.attributes.hp`), and a downed one gets the defeated status;
- attack lines as drawings, narration and real whispers in chat, and users
  for the people the Director seats (players, or an assistant GM).

Everything it makes is tagged `flags.magi-bridge.key` so it can be found
again. People's token drags (`updateToken` by another user) and chat lines
come back as `tableEvent` messages, buffered by the sidecar for `table_events`.
Speaking or rolling as an existing actor still goes through the GM dialog.

The **Bridge user** setting names the one user whose browser connects to the
sidecar. Set it (the headless GM does) when an assistant GM also plays, so
their browser does not take over the single connection.

### A server nobody sits at: the headless GM

Foundry modules run only in a browser, so a Foundry server without a GM at a
keyboard needs one. `scripts/headless-gm.mjs` is that browser: a headless
Chromium (Playwright) that accepts the license agreement if asked, logs in to
setup with the admin key, launches the world, joins as the GM, enables this
module, points it at the sidecar, makes itself the bridge user, and with
`DIRECTOR_RUNS_TABLE=true` turns on "Director runs the table". It then
watches the page and starts over if Foundry restarts.

The `Dockerfile` builds one image for both the sidecar (`node dist/index.js`,
the default) and the headless GM (`node scripts/headless-gm.mjs`). Magi
Server's `deploy/foundry/` runs them with Foundry itself (the official
licensed release, via the `felddy/foundryvtt` image and your foundryvtt.com
account) on its dev server.

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

Magi Server's `director/foundry.py` is an MCP client of `/mcp` for running a
table (`table_apply`, `table_events`, `director_status`).

**Known gap:** the suggest-mode actions above (an adapter that calls
`post_as_actor` and friends once `ActionGate` has approved an action) are not
wired yet. Any MCP client can drive the sidecar (`scripts/director-test.ts`
is one).

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
npm run test:table         # Director runs the table: ops, the GM's setting, events
npm run test:advisor       # MAGI advisor: questions in, answers out, status
npm run test:panel         # the MAGI tab in Chromium against a stand-in Foundry (no sidecar needed)
```

Both use a fake module in place of Foundry. The next step is a session in a
real Foundry world with a dnd5e table.

## Layout

See [CLAUDE.md](CLAUDE.md) for a file-by-file map and protocol conventions.

## License

See [LICENSE](LICENSE).
