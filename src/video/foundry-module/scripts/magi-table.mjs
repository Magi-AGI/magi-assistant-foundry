/**
 * Magi Bridge — the table the AI Director runs.
 *
 * When the GM turns on "Director runs the table", Magi Server's Director can
 * draw each scene's map, place and walk tokens for the party, the foes and the
 * people in the scene, mark the fallen, draw attack lines, narrate and whisper,
 * and make Foundry users for the people it seats. It sends these as
 * `tableCommand` ops through the sidecar; this file applies them with the
 * GM's permissions.
 *
 * Everything the Director makes carries `flags.magi-bridge.key`, its own name
 * for the thing ("Kestrel", "Goblin 2", "scene:ford"), so it can find it again.
 *
 * It also reports what people do at that table (`tableEvent`): a token one of
 * them dragged, and what they write in chat, so the Director can apply the move
 * (or put the token back) and read their answers.
 */

const FLAG = 'magi-bridge';
/** Pixels per Director grid square. */
export const CELL = 100;
const FOLDER_NAME = 'Magi Director';

const esc = (s) => foundry.utils.escapeHTML(String(s ?? ''));

export class MagiTable {
  /** @param {(msg: object) => void} send */
  constructor(send) {
    this.send = send;
    /** @type {string|null} */
    this.sceneId = null;
  }

  // ─── Commands from the Director ─────────────────────────

  async apply(ops) {
    const data = {};
    for (const op of ops) {
      const handler = this[`_${op.op}`];
      if (!handler) throw new Error(`unknown table op ${op.op}`);
      const out = await handler.call(this, op);
      if (out !== undefined) data[op.key ?? op.op] = out;
    }
    return data;
  }

  get scene() {
    return game.scenes.get(this.sceneId)
      ?? game.scenes.find((s) => s.active && s.getFlag(FLAG, 'key'))
      ?? null;
  }

  _requireScene() {
    const scene = this.scene;
    if (!scene) throw new Error('no Director scene yet (send a scene op first)');
    return scene;
  }

  /** A scene per Director scene: floor colour, features as locked drawings. Clears what an earlier run left. */
  async _scene(op) {
    const data = {
      name: op.name,
      width: op.cols * CELL,
      height: op.rows * CELL,
      padding: 0,
      backgroundColor: op.background,
      grid: { size: CELL, type: CONST.GRID_TYPES.SQUARE },
      tokenVision: false,
      fog: { exploration: false },
      navigation: true,
      flags: { [FLAG]: { key: op.key } },
    };
    let scene = game.scenes.find((s) => s.getFlag(FLAG, 'key') === op.key);
    if (scene) await scene.update(data);
    else scene = await Scene.create(data);

    const stale = (collection) => collection.filter((d) => d.getFlag(FLAG, 'key') || d.getFlag(FLAG, 'feature')).map((d) => d.id);
    const oldTokens = stale(scene.tokens);
    if (oldTokens.length) await scene.deleteEmbeddedDocuments('Token', oldTokens, { magiDirector: true });
    const oldDrawings = stale(scene.drawings);
    if (oldDrawings.length) await scene.deleteEmbeddedDocuments('Drawing', oldDrawings);

    const drawings = op.features.map((f) => ({
      x: f.cell[0] * CELL,
      y: f.cell[1] * CELL,
      shape: { type: 'r', width: (f.w ?? 1) * CELL, height: (f.h ?? 1) * CELL },
      fillType: CONST.DRAWING_FILL_TYPES.SOLID,
      fillColor: f.colour,
      fillAlpha: f.blocks ? 0.9 : 0.6,
      strokeWidth: 0,
      strokeAlpha: 0,
      locked: true,
      flags: { [FLAG]: { feature: true, label: f.label, blocks: f.blocks } },
    }));
    if (drawings.length) await scene.createEmbeddedDocuments('Drawing', drawings);
    if (!scene.active) await scene.activate();
    this.sceneId = scene.id;
    return scene.id;
  }

  async _folder() {
    const found = game.folders.find((f) => f.type === 'Actor' && f.name === FOLDER_NAME);
    return found ?? Folder.create({ name: FOLDER_NAME, type: 'Actor' });
  }

  /** One world actor per Director key, reused across runs, owned by the people who play it. */
  async _actor(op) {
    const types = game.documentTypes?.Actor ?? Object.keys(CONFIG.Actor.dataModels ?? {});
    const want = op.kind === 'pc' ? 'character' : 'npc';
    const type = types.includes(want) ? want : (types.find((t) => t !== 'base') ?? 'base');
    const ownership = { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE };
    for (const name of op.owners) {
      const user = game.users.getName(name);
      if (user) ownership[user.id] = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
    }
    let actor = game.actors.find((a) => a.getFlag(FLAG, 'key') === op.key);
    if (actor) {
      await actor.update({ name: op.name, ownership });
    } else {
      const folder = await this._folder();
      actor = await Actor.create({
        name: op.name, type, folder: folder.id, ownership,
        img: op.kind === 'foe' ? 'icons/svg/skull.svg' : 'icons/svg/mystery-man.svg',
        flags: { [FLAG]: { key: op.key } },
      });
    }
    return actor;
  }

  _tokenDoc(key) {
    return this.scene?.tokens.find((t) => t.getFlag(FLAG, 'key') === key) ?? null;
  }

  async _token(op) {
    const scene = this._requireScene();
    const actor = await this._actor(op);
    if (op.hp) await this._setHp(actor, op.hp[0], op.hp[1]);
    const disposition = { pc: CONST.TOKEN_DISPOSITIONS.FRIENDLY, npc: CONST.TOKEN_DISPOSITIONS.NEUTRAL,
      foe: CONST.TOKEN_DISPOSITIONS.HOSTILE }[op.kind];
    const data = {
      name: op.name,
      actorId: actor.id,
      actorLink: true,
      x: op.cell[0] * CELL,
      y: op.cell[1] * CELL,
      width: 1,
      height: 1,
      disposition,
      displayName: CONST.TOKEN_DISPLAY_MODES.ALWAYS,
      displayBars: CONST.TOKEN_DISPLAY_MODES.OWNER_HOVER,
      lockRotation: true,
      sight: { enabled: false },
      texture: { src: actor.img || 'icons/svg/mystery-man.svg', tint: op.colour },
      flags: { [FLAG]: { key: op.key } },
    };
    const existing = this._tokenDoc(op.key);
    if (existing) {
      await existing.update(data, { magiDirector: true });
      return existing.id;
    }
    const [created] = await scene.createEmbeddedDocuments('Token', [data], { magiDirector: true });
    return created.id;
  }

  async _move(op) {
    const token = this._tokenDoc(op.key);
    if (!token) throw new Error(`no token ${op.key}`);
    await token.update({ x: op.cell[0] * CELL, y: op.cell[1] * CELL }, { magiDirector: true, animate: true });
  }

  async _remove(op) {
    const scene = this.scene;
    if (!scene) return;
    const keys = new Set(op.keys);
    const tokens = scene.tokens.filter((t) => keys.has(t.getFlag(FLAG, 'key'))).map((t) => t.id);
    if (tokens.length) await scene.deleteEmbeddedDocuments('Token', tokens, { magiDirector: true });
    const drawings = scene.drawings.filter((d) => keys.has(d.getFlag(FLAG, 'key'))).map((d) => d.id);
    if (drawings.length) await scene.deleteEmbeddedDocuments('Drawing', drawings);
  }

  async _defeated(op) {
    const actor = this._tokenDoc(op.key)?.actor;
    if (!actor) return;
    const id = CONFIG.specialStatusEffects?.DEFEATED ?? 'dead';
    await actor.toggleStatusEffect(id, { active: op.value, overlay: true });
  }

  async _hp(op) {
    const actor = this._tokenDoc(op.key)?.actor;
    if (actor) await this._setHp(actor, op.value, op.max);
  }

  /** HP where the game system keeps it (dnd5e, pf2e: system.attributes.hp); ignored elsewhere. */
  async _setHp(actor, value, max) {
    if (!foundry.utils.hasProperty(actor.system ?? {}, 'attributes.hp')) return;
    try {
      await actor.update({ 'system.attributes.hp.value': value, 'system.attributes.hp.max': max });
    } catch (err) {
      console.warn(`${FLAG} | could not set HP for ${actor.name}:`, err);
    }
  }

  /** An attack: a line from the attacker's square to the target's. */
  async _line(op) {
    const scene = this._requireScene();
    const [x1, y1] = op.from.map((c) => c * CELL + CELL / 2);
    const [x2, y2] = op.to.map((c) => c * CELL + CELL / 2);
    const ox = Math.min(x1, x2);
    const oy = Math.min(y1, y2);
    const [line] = await scene.createEmbeddedDocuments('Drawing', [{
      x: ox,
      y: oy,
      shape: { type: 'p', width: Math.abs(x2 - x1) || 1, height: Math.abs(y2 - y1) || 1, points: [x1 - ox, y1 - oy, x2 - ox, y2 - oy] },
      strokeColor: op.colour,
      strokeWidth: 8,
      strokeAlpha: 0.9,
      fillType: CONST.DRAWING_FILL_TYPES.NONE,
      locked: true,
      flags: { [FLAG]: { key: op.key } },
    }]);
    return line.id;
  }

  /** Narration, or a whisper to the named users only. */
  async _chat(op) {
    const whisper = (op.whisperTo ?? []).map((n) => game.users.getName(n)?.id).filter(Boolean);
    if (op.whisperTo?.length && !whisper.length) return 'nobody to whisper to';
    await ChatMessage.create({
      content: esc(op.text).replace(/\n/g, '<br>'),
      speaker: { alias: op.speaker },
      whisper,
      flags: { [FLAG]: { director: true } },
    });
  }

  /** Foundry users for the people the Director seats. An existing user keeps its password. */
  async _users(op) {
    const out = {};
    for (const u of op.users) {
      if (game.users.getName(u.name)) {
        out[u.name] = 'exists';
        continue;
      }
      const role = u.role === 'assistant' ? CONST.USER_ROLES.ASSISTANT : CONST.USER_ROLES.PLAYER;
      await User.create({ name: u.name, role, password: u.password });
      out[u.name] = 'created';
    }
    return out;
  }

  // ─── What people do at the table ────────────────────────

  registerHooks() {
    Hooks.on('updateToken', (doc, change, options, userId) => {
      if (options?.magiDirector || userId === game.user.id) return;
      if (!('x' in change) && !('y' in change)) return;
      const key = doc.getFlag(FLAG, 'key');
      if (!key) return;
      const size = doc.parent?.grid?.size ?? CELL;
      this.send({
        type: 'tableEvent',
        event: { kind: 'tokenMoved', key, name: doc.name, cell: [Math.round(doc.x / size), Math.round(doc.y / size)],
          user: game.users.get(userId)?.name ?? '' },
      });
    });

    Hooks.on('createChatMessage', (msg, _options, userId) => {
      if (userId === game.user.id || msg.getFlag(FLAG, 'director')) return;
      const div = document.createElement('div');
      div.innerHTML = msg.content ?? '';
      const text = (div.textContent ?? '').trim();
      if (!text) return;
      this.send({ type: 'tableEvent', event: { kind: 'chat', user: (msg.author ?? msg.user)?.name ?? '', text } });
    });
  }
}
