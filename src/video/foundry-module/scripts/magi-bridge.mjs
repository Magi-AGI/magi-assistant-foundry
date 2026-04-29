/**
 * Magi Bridge — Foundry VTT module (v13)
 *
 * Runs in the GM's browser. Connects to the Magi sidecar via WebSocket
 * and streams game state (actors, chat, combat, scenes, video).
 *
 * Architecture constraint: Foundry v13 has NO server-side module scripts.
 * Everything runs client-side in the GM's browser.
 *
 * Traffic isolation: Game state and video use separate WebSocket connections
 * to avoid head-of-line blocking. Video chunks (~430KB every 5s) would
 * otherwise delay small game-state events at the TCP layer.
 */

const MODULE_ID = 'magi-bridge';
const LOG_PREFIX = 'Magi Bridge |';

class MagiBridge {
  /** @type {WebSocket|null} Game state WebSocket */
  ws = null;

  /** @type {WebSocket|null} Video WebSocket (separate connection) */
  videoWs = null;

  /** @type {number} Reconnect delay in ms */
  reconnectDelay = 1000;

  /** @type {number} Max reconnect delay (cap) */
  maxReconnectDelay = 30000;

  /** @type {ReturnType<typeof setTimeout>|null} */
  reconnectTimer = null;

  /** @type {number} Video reconnect delay in ms */
  videoReconnectDelay = 1000;

  /** @type {ReturnType<typeof setTimeout>|null} */
  videoReconnectTimer = null;

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

    game.settings.register(MODULE_ID, 'videoSidecarUrl', {
      name: game.i18n.localize('MAGI_BRIDGE.Settings.VideoSidecarUrl.Name'),
      hint: game.i18n.localize('MAGI_BRIDGE.Settings.VideoSidecarUrl.Hint'),
      scope: 'world',
      config: true,
      type: String,
      default: 'ws://127.0.0.1:3301',
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

  // ─── Game-State WebSocket Connection ───────────────────────

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

      // Note: video capture no longer auto-starts on connect. The GM must
      // explicitly start it via the scene-controls toolbar button or the
      // module API (game.modules.get('magi-bridge').api.startRecording()).
      // This prevents accidental long recordings from idle browser tabs.
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
      // Video capture and video WS continue independently — they have
      // their own connection and reconnect logic. Only tear them down
      // on intentional disconnect (module shutdown).
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
    this._disconnectVideo();
    if (this.ws) {
      this.ws.close(1000, 'Module shutting down');
      this.ws = null;
    }
  }

  // ─── Video WebSocket Connection ────────────────────────────

  _connectVideo() {
    // Guard: skip if already connected or connecting
    if (this.videoWs && (this.videoWs.readyState === WebSocket.OPEN || this.videoWs.readyState === WebSocket.CONNECTING)) {
      return;
    }
    // Cancel pending reconnect timer to avoid duplicate connections
    if (this.videoReconnectTimer) {
      clearTimeout(this.videoReconnectTimer);
      this.videoReconnectTimer = null;
    }

    const baseUrl = game.settings.get(MODULE_ID, 'videoSidecarUrl');
    const token = game.settings.get(MODULE_ID, 'sidecarToken');
    const url = token ? `${baseUrl}?token=${encodeURIComponent(token)}` : baseUrl;

    try {
      this.videoWs = new WebSocket(url);
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to create video WebSocket:`, err);
      this._scheduleVideoReconnect();
      return;
    }

    this.videoWs.onopen = () => {
      console.log(`${LOG_PREFIX} Video WS connected`);
      this.videoReconnectDelay = 1000;
    };

    this.videoWs.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'ping') {
          this.videoWs?.send(JSON.stringify({ type: 'pong' }));
        }
      } catch { /* ignore parse errors on video channel */ }
    };

    this.videoWs.onclose = () => {
      console.log(`${LOG_PREFIX} Video WS closed`);
      this.videoWs = null;
      if (!this.intentionalClose && game.settings.get(MODULE_ID, 'enableVideoCapture')) {
        this._scheduleVideoReconnect();
      }
    };

    this.videoWs.onerror = (err) => {
      console.error(`${LOG_PREFIX} Video WS error:`, err);
    };
  }

  _scheduleVideoReconnect() {
    if (this.videoReconnectTimer) return;
    console.log(`${LOG_PREFIX} Video WS reconnecting in ${this.videoReconnectDelay}ms...`);
    this.videoReconnectTimer = setTimeout(() => {
      this.videoReconnectTimer = null;
      this._connectVideo();
    }, this.videoReconnectDelay);
    this.videoReconnectDelay = Math.min(this.videoReconnectDelay * 2, this.maxReconnectDelay);
  }

  _disconnectVideo() {
    if (this.videoReconnectTimer) {
      clearTimeout(this.videoReconnectTimer);
      this.videoReconnectTimer = null;
    }
    if (this.videoWs) {
      this.videoWs.close(1000, 'Video shutting down');
      this.videoWs = null;
    }
  }

  /** Send a video chunk on the dedicated video WS. Drops if unavailable. */
  _sendVideo(msg) {
    if (this.videoWs && this.videoWs.readyState === WebSocket.OPEN) {
      this.videoWs.send(JSON.stringify(msg));
    }
    // No fallback to main WS — sending ~430KB video chunks on the game-state
    // connection would reintroduce head-of-line blocking. Chunks are dropped
    // until the video WS reconnects.
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

  // ─── Recording control (public API) ─────────────────────

  /** True if video is actively being recorded right now. */
  isRecording() {
    return !!(this.mediaRecorder && this.mediaRecorder.state === 'recording');
  }

  /** Start a recording session. Returns true if started, false if blocked. */
  startRecording() {
    if (!game.user.isGM) {
      ui.notifications.warn('Only the GM can start video recording.');
      return false;
    }
    if (!game.settings.get(MODULE_ID, 'enableVideoCapture')) {
      ui.notifications.warn('Video capture is disabled in module settings. Enable it first under Configure Settings → Module Settings → Magi Bridge.');
      return false;
    }
    if (this.isRecording()) {
      ui.notifications.info('Video recording is already running.');
      return false;
    }
    if (!this.videoWs && !this.videoReconnectTimer) {
      this._connectVideo();
    }
    this._startVideoCapture(2);
    if (this.isRecording()) {
      ui.notifications.info('Video recording started.');
      ui.controls?.render();
      return true;
    }
    return false;
  }

  /** Stop the current recording session. Returns true if stopped, false if no-op. */
  stopRecording() {
    if (!game.user.isGM) return false;
    if (!this.isRecording()) {
      ui.notifications.info('No active video recording.');
      return false;
    }
    this._stopVideoCapture();
    this._disconnectVideo();
    ui.notifications.info('Video recording stopped.');
    ui.controls?.render();
    return true;
  }

  /** Convenience: start if stopped, stop if started. */
  toggleRecording() {
    return this.isRecording() ? this.stopRecording() : this.startRecording();
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
        if (event.data.size > 0) {
          const reader = new FileReader();
          reader.onloadend = () => {
            const base64 = /** @type {string} */ (reader.result).split(',')[1];
            if (base64) {
              this._sendVideo({
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

  // Expose recording control on the module's public API so macros, the
  // browser console, or external orchestration (Discord session lifecycle)
  // can drive recording without touching the bridge instance directly.
  const mod = game.modules.get(MODULE_ID);
  if (mod) {
    mod.api = {
      startRecording: () => bridge.startRecording(),
      stopRecording: () => bridge.stopRecording(),
      toggleRecording: () => bridge.toggleRecording(),
      isRecording: () => bridge.isRecording(),
    };
  }
});

Hooks.once('ready', () => {
  bridge.ready();
});

// Add a toolbar button under the Tokens scene controls so the GM has a
// one-click start/stop. Defensive against v12 array shape and v13 object shape.
Hooks.on('getSceneControlButtons', (controls) => {
  if (!game.user?.isGM) return;

  const tool = {
    name: 'magi-record',
    title: bridge.isRecording() ? 'Stop Magi Video Recording' : 'Start Magi Video Recording',
    icon: 'fas fa-video',
    toggle: true,
    active: bridge.isRecording(),
    button: false,
    visible: true,
    onClick: () => bridge.toggleRecording(),
  };

  if (Array.isArray(controls)) {
    const group = controls.find((c) => c.name === 'token' || c.name === 'tokens');
    if (group) {
      if (!group.tools) group.tools = [];
      if (Array.isArray(group.tools)) group.tools.push(tool);
      else group.tools[tool.name] = tool;
    }
  } else if (controls && typeof controls === 'object') {
    const group = controls.tokens || controls.token;
    if (group) {
      if (!group.tools) group.tools = {};
      group.tools[tool.name] = tool;
    }
  }
});
