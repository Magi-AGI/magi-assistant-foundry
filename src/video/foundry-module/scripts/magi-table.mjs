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
    if (op.sheet) await this._applySheet(actor, op.sheet);
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

  /** A creature's statblock changed (gear taken or equipped, a spell slot spent, a condition). */
  async _sheet(op) {
    const actor = this._tokenDoc(op.key)?.actor ?? game.actors.find((a) => a.getFlag(FLAG, 'key') === op.key);
    if (!actor) throw new Error(`no actor ${op.key}`);
    await this._applySheet(actor, op.sheet);
  }

  /**
   * The Director's statblock on an actor. In dnd5e: abilities, saves, skills, AC, speed, size,
   * damage traits, coins, and items for its gear, features and spells (each flagged so the next
   * update replaces them). In any system: the statblock as HTML in the biography and a flag. A
   * fallen creature with something on it becomes viewable by everyone, so players can see the loot.
   */
  async _applySheet(actor, s) {
    const dnd = game.system.id === 'dnd5e';
    const has = (path) => foundry.utils.hasProperty(actor.system ?? {}, path);
    const update = { [`flags.${FLAG}.statblock`]: s.statblock ?? '' };
    if (has('details.biography.value')) update['system.details.biography.value'] = s.statblock ?? '';
    if (dnd && s.abilities) {
      for (const [k, a] of Object.entries(s.abilities)) {
        update[`system.abilities.${k}.value`] = a.value;
        update[`system.abilities.${k}.proficient`] = a.proficient;
      }
      for (const code of Object.keys(actor.system?.skills ?? {})) update[`system.skills.${code}.value`] = s.skills?.[code] ?? 0;
      if (s.ac != null) {
        update['system.attributes.ac.calc'] = 'flat';
        update['system.attributes.ac.flat'] = s.ac;
      }
      if (s.speed) update['system.attributes.movement.walk'] = s.speed;
      if (has('attributes.senses.ranges')) update['system.attributes.senses.ranges.darkvision'] = s.darkvision || null;
      else if (has('attributes.senses')) update['system.attributes.senses.darkvision'] = s.darkvision || 0;
      if (s.size) update['system.traits.size'] = s.size;
      for (const t of ['dr', 'dv', 'di', 'ci']) if (has(`traits.${t}`)) update[`system.traits.${t}.value`] = s[t] ?? [];
      if (has('traits.languages.custom')) update['system.traits.languages.custom'] = s.languages ?? '';
      if (s.currency && has('currency')) update['system.currency'] = s.currency;
      if (actor.type === 'npc') {
        if (s.cr != null) update['system.details.cr'] = s.cr;
        if (has('details.type.value')) update['system.details.type.value'] = s.type;
      }
      for (const [level, slots] of Object.entries(s.spellcasting?.slots ?? {})) {
        if (!has(`spells.spell${level}`)) continue;
        update[`system.spells.spell${level}.override`] = slots;
        update[`system.spells.spell${level}.value`] = slots - (s.spellcasting.used?.[level] ?? 0);
      }
    }
    try {
      await actor.update(update);
    } catch (err) {
      console.warn(`${FLAG} | could not write the statblock for ${actor.name}; keeping the text only:`, err);
      await actor.update({ [`flags.${FLAG}.statblock`]: s.statblock ?? '' }).catch(() => {});
    }
    if (dnd) await this._applyItems(actor, s);
    await this._applyConditions(actor, s.conditions ?? []);
    const looted = !!actor.getFlag(FLAG, 'lootable');
    if (!!s.lootable !== looted) {
      const level = s.lootable ? CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER : CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE;
      await actor.update({ 'ownership.default': level, [`flags.${FLAG}.lootable`]: !!s.lootable });
    }
  }

  /** Replace the items the Director made on this actor with the sheet's gear, features and spells. */
  async _applyItems(actor, s) {
    const old = actor.items.filter((i) => i.getFlag(FLAG, 'item')).map((i) => i.id);
    if (old.length) await actor.deleteEmbeddedDocuments('Item', old);
    const types = game.documentTypes?.Item ?? Object.keys(CONFIG.Item.dataModels ?? {});
    const docs = (s.items ?? []).map((it) => this._itemData(it, types));
    if (s.class && types.includes('class')) {
      const hd = `d${s.class.hd}`;
      docs.unshift({ name: s.class.name, type: 'class', flags: { [FLAG]: { item: true } },
        system: { identifier: s.class.identifier, levels: s.class.levels, hd: { denomination: hd }, hitDice: hd } });
    }
    if (!docs.length) return;
    try {
      await actor.createEmbeddedDocuments('Item', docs);
    } catch (err) {
      console.warn(`${FLAG} | creating ${actor.name}'s items together failed; trying one at a time:`, err);
      for (const doc of docs) {
        try {
          await actor.createEmbeddedDocuments('Item', [doc]);
        } catch (one) {
          const plain = { name: doc.name, type: types.includes('loot') ? 'loot' : doc.type, flags: doc.flags,
            system: { description: doc.system?.description ?? { value: '' }, quantity: doc.system?.quantity ?? 1 } };
          await actor.createEmbeddedDocuments('Item', [plain]).catch((e) => console.warn(`${FLAG} | skipped ${doc.name}:`, e));
        }
      }
    }
  }

  /** One sheet item (see director/srd5e.py foundry_export) as dnd5e item data. */
  _itemData(it, types) {
    const type = types.includes(it.type) ? it.type : (types.includes('loot') ? 'loot' : it.type);
    const system = { description: { value: it.description ? `<p>${esc(it.description)}</p>` : '' } };
    const doc = { name: it.name, type, flags: { [FLAG]: { item: true } }, system };
    if (['weapon', 'equipment', 'consumable', 'loot', 'tool'].includes(type)) {
      system.quantity = it.quantity ?? 1;
      system.weight = { value: it.weight ?? 0, units: 'lb' };
      if (it.price) system.price = { value: it.price, denomination: 'gp' };
    }
    if (type === 'weapon' || type === 'equipment') system.equipped = !!it.equipped;
    if (type === 'weapon' && it.weapon) {
      const w = it.weapon;
      const dice = (d) => ({ number: d.number || null, denomination: d.denomination || null, bonus: d.bonus ?? '',
        types: w.damage.type ? [w.damage.type] : [] });
      system.type = { value: w.kind };
      system.damage = { base: dice(w.damage) };
      if (w.versatile) system.damage.versatile = dice(w.versatile);
      system.properties = w.properties ?? [];
      system.range = { value: w.range?.value ?? null, long: w.range?.long ?? null, reach: w.range?.reach ?? null, units: 'ft' };
      if (w.kind === 'natural') system.proficient = 1;
    }
    if (type === 'equipment' && it.armor) {
      system.type = { value: it.armor.type };
      system.armor = { value: it.armor.value, dex: it.armor.dex };
      if (it.armor.strength) system.strength = it.armor.strength;
      if (it.armor.stealth) system.properties = ['stealthDisadvantage'];
    }
    if (type === 'consumable') system.type = { value: it.consumable ?? 'trinket' };
    if (type === 'loot') system.type = { value: 'gear' };
    if (type === 'feat') system.type = { value: it.feat ?? 'monster' };
    if (type === 'spell') {
      system.level = it.level ?? 0;
      system.preparation = { mode: 'prepared', prepared: true };
      system.method = 'spell';
      system.prepared = 1;
    }
    return doc;
  }

  /** Unconscious and prone, as the sheet says (the dead get the Defeated marker from the `defeated` op). */
  async _applyConditions(actor, conditions) {
    const known = new Set((CONFIG.statusEffects ?? []).map((e) => e.id));
    for (const id of ['unconscious', 'prone']) {
      if (!known.has(id)) continue;
      const on = conditions.includes(id) || (id === 'unconscious' && conditions.includes('stable'));
      if (actor.statuses?.has(id) === on) continue;
      try {
        await actor.toggleStatusEffect(id, { active: on });
      } catch (err) {
        console.warn(`${FLAG} | could not set ${id} on ${actor.name}:`, err);
      }
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

  /** The Foundry ids of these users (null for a name with no user), e.g. for signing someone in from outside. */
  async _userIds(op) {
    return Object.fromEntries(op.names.map((n) => [n, game.users.getName(n)?.id ?? null]));
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
