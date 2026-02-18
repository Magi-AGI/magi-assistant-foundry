/**
 * Magi Bridge — Foundry VTT module (v13)
 *
 * Runs in the GM's browser. Connects to the Magi sidecar via WebSocket
 * and streams game state (actors, chat, combat, scenes, video).
 *
 * Architecture constraint: Foundry v13 has NO server-side module scripts.
 * Everything runs client-side in the GM's browser.
 */

const MODULE_ID = 'magi-bridge';
const LOG_PREFIX = 'Magi Bridge |';

class MagiBridge {
  /** @type {WebSocket|null} */
  ws = null;

  /** @type {number} Reconnect delay in ms */
  reconnectDelay = 1000;

  /** @type {number} Max reconnect delay (cap) */
  maxReconnectDelay = 30000;

  /** @type {ReturnType<typeof setTimeout>|null} */
  reconnectTimer = null;

  /** @type {boolean} */
  intentionalClose = false;

  /** @type {MediaRecorder|null} */
  mediaRecorder = null;

  /** @type {MediaStream|null} */
  captureStream = null;

  // ─── Lifecycle ───────────────────────────────────────────

  init() {
    // Register module settings
    game.settings.register(MODULE_ID, 'sidecarUrl', {
      name: game.i18n.localize('MAGI_BRIDGE.Settings.SidecarUrl.Name'),
      hint: game.i18n.localize('MAGI_BRIDGE.Settings.SidecarUrl.Hint'),
      scope: 'world',
      config: true,
      type: String,
      default: 'ws://127.0.0.1:3300',
    });

    game.settings.register(MODULE_ID, 'sidecarToken', {
      name: game.i18n.localize('MAGI_BRIDGE.Settings.SidecarToken.Name'),
      hint: game.i18n.localize('MAGI_BRIDGE.Settings.SidecarToken.Hint'),
      scope: 'world',
      config: true,
      restricted: true, // GM-only: prevents non-GM users from reading/modifying the token
      type: String,
      default: '',
    });

    game.settings.register(MODULE_ID, 'enableVideoCapture', {
      name: game.i18n.localize('MAGI_BRIDGE.Settings.EnableVideoCapture.Name'),
      hint: game.i18n.localize('MAGI_BRIDGE.Settings.EnableVideoCapture.Hint'),
      scope: 'world',
      config: true,
      type: Boolean,
      default: false,
    });
  }

  ready() {
    // Only activate for the GM
    if (!game.user.isGM) {
      console.log(`${LOG_PREFIX} Not GM — module inactive`);
      return;
    }

    console.log(`${LOG_PREFIX} GM detected — connecting to sidecar`);
    this._connect();
    this._registerHooks();
  }

  // ─── WebSocket Connection ────────────────────────────────

  _connect() {
    const baseUrl = game.settings.get(MODULE_ID, 'sidecarUrl');
    const token = game.settings.get(MODULE_ID, 'sidecarToken');
    const url = token ? `${baseUrl}?token=${encodeURIComponent(token)}` : baseUrl;

    this.intentionalClose = false;

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to create WebSocket:`, err);
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      console.log(`${LOG_PREFIX} Connected to sidecar`);
      this.reconnectDelay = 1000; // Reset backoff
      ui.notifications.info(game.i18n.localize('MAGI_BRIDGE.Connected'));

      // Send full game state snapshot
      this._sendGameReady();

      // Start video capture if enabled
      if (game.settings.get(MODULE_ID, 'enableVideoCapture')) {
        this._startVideoCapture(2);
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this._handleSidecarMessage(msg);
      } catch (err) {
        console.warn(`${LOG_PREFIX} Failed to parse message:`, err);
      }
    };

    this.ws.onclose = () => {
      console.log(`${LOG_PREFIX} WebSocket closed`);
      this.ws = null;
      this._stopVideoCapture();
      if (!this.intentionalClose) {
        ui.notifications.warn(game.i18n.localize('MAGI_BRIDGE.Reconnecting'));
        this._scheduleReconnect();
      }
    };

    this.ws.onerror = (err) => {
      console.error(`${LOG_PREFIX} WebSocket error:`, err);
    };
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    console.log(`${LOG_PREFIX} Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, this.reconnectDelay);

    // Exponential backoff with cap
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  _send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  disconnect() {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._stopVideoCapture();
    if (this.ws) {
      this.ws.close(1000, 'Module shutting down');
      this.ws = null;
    }
  }

  // ─── Sidecar Message Handling ────────────────────────────

  _handleSidecarMessage(msg) {
    switch (msg.type) {
      case 'whisper':
        this._handleWhisper(msg);
        break;
      case 'queryState':
        this._sendGameReady();
        break;
      case 'ping':
        this._send({ type: 'pong' });
        break;
      default:
        console.warn(`${LOG_PREFIX} Unknown sidecar message:`, msg.type);
    }
  }

  _handleWhisper(payload) {
    const content = payload.title
      ? `<h3>${payload.title}</h3>${payload.content}`
      : payload.content;

    ChatMessage.create({
      content,
      whisper: [game.user.id],
      speaker: { alias: 'Magi GM Assistant' },
    });
  }

  // ─── Game State Snapshot ─────────────────────────────────

  _sendGameReady() {
    const actors = {};
    for (const actor of game.actors) {
      actors[actor.id] = this._serializeActor(actor);
    }

    const scene = game.scenes.active ? this._serializeScene(game.scenes.active) : null;
    const combat = game.combat ? this._serializeCombat(game.combat) : null;
    const chatHistory = game.messages.contents.slice(-50)
      .filter((m) => {
        // Apply same whisper filter as live hooks — exclude GM-only whispers
        if (m.whisper?.length > 0) {
          const gmOnly = m.whisper.length === 1
            && (m.whisper[0] === game.user.id || m.whisper[0]?.id === game.user.id);
          if (gmOnly) return false;
        }
        return true;
      })
      .map((m) => this._serializeChatMessage(m));

    this._send({
      type: 'gameReady',
      worldId: game.world?.id ?? '',
      actors,
      scene,
      combat,
      chatHistory,
    });
  }

  // ─── Serializers ─────────────────────────────────────────

  _serializeActor(actor) {
    const sys = actor.system;

    // Aspects — Fate Core Official stores as an object with UUID keys
    const aspects = [];
    if (sys.aspects) {
      for (const [, asp] of Object.entries(sys.aspects)) {
        if (asp && asp.name) {
          aspects.push({
            name: asp.name,
            type: asp.type ?? 'Other',
            value: asp.value ?? asp.name,
          });
        }
      }
    }

    // Skills — stored as object with skill name keys
    const skills = [];
    if (sys.skills) {
      for (const [name, skill] of Object.entries(sys.skills)) {
        if (skill && typeof skill.rank === 'number') {
          skills.push({ name, rank: skill.rank });
        }
      }
    }

    // Stunts
    const stunts = [];
    if (sys.stunts) {
      for (const [, stunt] of Object.entries(sys.stunts)) {
        if (stunt && stunt.name) {
          stunts.push({
            name: stunt.name,
            description: stunt.description ?? '',
          });
        }
      }
    }

    // Stress tracks
    const tracks = [];
    if (sys.tracks) {
      for (const [, track] of Object.entries(sys.tracks)) {
        if (track && track.name) {
          const size = track.size ?? track.boxes?.length ?? 0;
          const value = [];
          if (track.boxes) {
            for (let i = 0; i < size; i++) {
              value.push(!!track.boxes[i]?.checked);
            }
          }
          tracks.push({ name: track.name, size, value });
        }
      }
    }

    return {
      id: actor.id,
      name: actor.name,
      type: actor.type,
      img: actor.img ?? '',
      aspects,
      skills,
      stunts,
      tracks,
      fatePoints: sys.fatePoints?.current ?? sys.fatePoints ?? 0,
      refresh: sys.fatePoints?.refresh ?? sys.refresh ?? 0,
    };
  }

  _serializeScene(scene) {
    const tokens = [];
    if (scene.tokens) {
      for (const token of scene.tokens) {
        tokens.push({
          id: token.id,
          name: token.name,
          actorId: token.actorId ?? '',
          x: token.x,
          y: token.y,
          hidden: token.hidden ?? false,
        });
      }
    }

    return {
      id: scene.id,
      name: scene.name,
      active: scene.active,
      width: scene.width ?? 0,
      height: scene.height ?? 0,
      gridSize: scene.grid?.size ?? scene.gridSize ?? 50,
      tokens,
    };
  }

  _serializeCombat(combat) {
    const combatants = [];
    for (const c of combat.combatants) {
      combatants.push({
        id: c.id,
        actorId: c.actorId ?? '',
        name: c.name,
        initiative: c.initiative,
        defeated: c.defeated ?? false,
      });
    }

    return {
      id: combat.id,
      round: combat.round,
      turn: combat.turn,
      combatants,
    };
  }

  _serializeChatMessage(msg) {
    const rolls = [];
    if (msg.rolls && msg.rolls.length > 0) {
      for (const roll of msg.rolls) {
        rolls.push({
          formula: roll.formula ?? '',
          total: roll.total ?? 0,
          dice: roll.dice?.flatMap((d) => d.results?.map((r) => r.result) ?? []) ?? [],
        });
      }
    }

    return {
      id: msg.id,
      speakerActorId: msg.speaker?.actor ?? '',
      speakerAlias: msg.speaker?.alias ?? msg.author?.name ?? 'Unknown',
      content: msg.content ?? '',
      type: msg.type ?? 0,
      isGm: msg.author?.isGM ?? false,
      whisper: msg.whisper?.map((u) => (typeof u === 'string' ? u : u.id)) ?? [],
      rolls,
      timestamp: msg.timestamp ? new Date(msg.timestamp).toISOString() : new Date().toISOString(),
    };
  }

  // ─── Foundry Hooks ──────────────────────────────────────

  _registerHooks() {
    Hooks.on('createChatMessage', (msg) => {
      // Skip messages whispered only to the GM (e.g., Magi Assistant's own advice)
      // to avoid feeding our own output back into the reasoning loop.
      if (msg.whisper?.length > 0) {
        const gmOnly = msg.whisper.length === 1
          && (msg.whisper[0] === game.user.id || msg.whisper[0]?.id === game.user.id);
        if (gmOnly) return;
      }

      this._send({
        type: 'chatMessage',
        message: this._serializeChatMessage(msg),
      });
    });

    // Fate rolls may be updated after creation (e.g., revised totals from modifiers)
    Hooks.on('updateChatMessage', (msg) => {
      // Same whisper filter as createChatMessage — skip GM-only whispers
      if (msg.whisper?.length > 0) {
        const gmOnly = msg.whisper.length === 1
          && (msg.whisper[0] === game.user.id || msg.whisper[0]?.id === game.user.id);
        if (gmOnly) return;
      }

      this._send({
        type: 'chatMessageUpdate',
        message: this._serializeChatMessage(msg),
      });
    });

    Hooks.on('updateActor', (actor) => {
      this._send({
        type: 'actorUpdate',
        actorId: actor.id,
        actor: this._serializeActor(actor),
      });
    });

    Hooks.on('updateCombat', (combat) => {
      this._send({
        type: 'combatUpdate',
        combat: this._serializeCombat(combat),
      });
    });

    Hooks.on('deleteCombat', () => {
      this._send({
        type: 'combatUpdate',
        combat: null,
      });
    });

    Hooks.on('updateScene', (scene) => {
      if (scene.active) {
        this._send({
          type: 'sceneChange',
          scene: this._serializeScene(scene),
        });
      }
    });
  }

  // ─── Video Capture ──────────────────────────────────────

  _startVideoCapture(fps = 2) {
    try {
      const canvas = document.querySelector('#board') ?? document.querySelector('canvas');
      if (!canvas) {
        console.warn(`${LOG_PREFIX} No canvas found for video capture`);
        return;
      }

      this.captureStream = canvas.captureStream(fps);
      this.mediaRecorder = new MediaRecorder(this.captureStream, {
        mimeType: 'video/webm;codecs=vp8',
        videoBitsPerSecond: 500_000,
      });

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0 && this.ws?.readyState === WebSocket.OPEN) {
          const reader = new FileReader();
          reader.onloadend = () => {
            const base64 = /** @type {string} */ (reader.result).split(',')[1];
            if (base64) {
              this._send({
                type: 'videoChunk',
                data: base64,
                timestamp: new Date().toISOString(),
              });
            }
          };
          reader.readAsDataURL(event.data);
        }
      };

      // 5-second chunks
      this.mediaRecorder.start(5000);
      console.log(`${LOG_PREFIX} Video capture started (${fps} fps, 500kbps)`);
    } catch (err) {
      console.warn(`${LOG_PREFIX} Video capture not available:`, err);
    }
  }

  _stopVideoCapture() {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
      this.mediaRecorder = null;
    }
    if (this.captureStream) {
      for (const track of this.captureStream.getTracks()) {
        track.stop();
      }
      this.captureStream = null;
    }
  }
}

// ─── Module Registration ─────────────────────────────────

const bridge = new MagiBridge();

Hooks.once('init', () => {
  bridge.init();
});

Hooks.once('ready', () => {
  bridge.ready();
});
