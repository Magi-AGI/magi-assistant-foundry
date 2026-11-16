// A stand-in for the bits of Foundry v13 the MAGI tab touches (scripts/panel-test/run.mjs).
// A minimal stand-in for Foundry v13's client globals: enough to load the Magi Bridge module and render its MAGI tab.
const params = new URLSearchParams(location.search);
const GM = params.get('gm') === '1';
const hooks = {};
window.Hooks = {
  on(n, f) { (hooks[n] ??= []).push({ f }); },
  once(n, f) { (hooks[n] ??= []).push({ f, once: true }); },
  callAll(n, ...a) { for (const h of [...(hooks[n] ?? [])]) { h.f(...a); if (h.once) hooks[n] = hooks[n].filter((x) => x !== h); } },
};
window.CONST = { USER_ROLES: { PLAYER: 1, TRUSTED: 2, ASSISTANT: 3, GAMEMASTER: 4 },
  TOKEN_DISPOSITIONS: { HOSTILE: -1, NEUTRAL: 0, FRIENDLY: 1 } };
class Coll extends Map {
  get contents() { return [...this.values()]; }
  filter(f) { return this.contents.filter(f); }
  find(f) { return this.contents.find(f); }
  getName(n) { return this.contents.find((x) => x.name === n); }
  map(f) { return this.contents.map(f); }
  some(f) { return this.contents.some(f); }
}
const mkUser = (id, name, role, character) => ({ id, name, role, isGM: role >= 3, character: character ? { name: character } : null });
const users = new Coll([
  ['gm1', mkUser('gm1', 'Gamemaster', 4)], ['ix', mkUser('ix', 'Ix', 4)],
  ['ana', mkUser('ana', 'ana', 1, 'Kestrel')], ['bram', mkUser('bram', 'bram', 1, 'Bram')],
]);
const me = users.get(params.get('user') ?? (GM ? 'gm1' : 'ana'));
let nextId = 1;
class ChatMsg {
  constructor(d) { Object.assign(this, d); this.id = d.id ?? `m${nextId++}`; this.timestamp = d.timestamp ?? Date.now(); }
  get author() { return users.get(this.authorId); }
  getFlag(scope, key) { return this.flags?.[scope]?.[key]; }
  get visible() { return !this.whisper?.length || this.whisper.includes(me.id) || this.authorId === me.id; }
}
window.__messages = new Coll();
window.ChatMessage = {
  async create(d, { as } = {}) {
    const m = new ChatMsg({ ...d, authorId: as ?? me.id });
    window.__messages.set(m.id, m);
    window.__created = (window.__created ?? []).concat([m]);
    Hooks.callAll('createChatMessage', m, {}, m.authorId);
    return m;
  },
};
window.__ChatMsg = ChatMsg;
const settings = {};
const registered = {};
window.game = {
  user: me, users, messages: window.__messages, world: { id: 'w' }, system: { id: 'dnd5e' },
  actors: new Coll(), scenes: new Coll(), folders: new Coll(), combat: null,
  i18n: { localize: (k) => k },
  settings: {
    register(m, k, c) { registered[k] = c; if (!(k in settings)) settings[k] = c.default; },
    get(m, k) { return settings[k]; },
    async set(m, k, v) { settings[k] = v; registered[k]?.onChange?.(v); },
  },
  socket: { emitted: [], handlers: [], emit(n, d) { this.emitted.push(d); window.__socketOut?.(d); }, on(n, f) { this.handlers.push(f); } },
  modules: new Map([['magi-bridge', {}]]),
};
window.__settings = settings;
window.ui = { notifications: { info: (t) => console.log('INFO', t), warn: (t) => console.log('WARN', t), error: (t) => console.log('ERROR', t) } };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
class ApplicationV2 {
  static DEFAULT_OPTIONS = {};
  constructor(options = {}) { this.options = { ...this.constructor.DEFAULT_OPTIONS, ...options }; this.rendered = false; }
  async render() {
    if (!this.element) {
      const frame = document.createElement('section');
      frame.className = 'app window-app ' + (this.options.classes ?? []).join(' ');
      frame.innerHTML = `<header class="window-header">${this.options.window?.title ?? ''} <a class="close">×</a></header><div class="window-content"></div>`;
      frame.querySelector('.close').onclick = () => this.close();
      document.getElementById('windows').append(frame);
      this.element = frame;
    }
    const r = await this._renderHTML();
    this._replaceHTML(r, this.element.querySelector('.window-content'));
    this.rendered = true;
    return this;
  }
  async close() { this._onClose?.({}); this.element?.remove(); this.element = null; this.rendered = false; }
  bringToFront() {}
}
class AbstractSidebarTab extends ApplicationV2 {
  async render() {
    if (!this.element) {
      this.element = document.createElement('section');
      this.element.id = this.constructor.tabName;
      this.element.className = 'tab sidebar-tab active';
      document.getElementById('sidebar-content').append(this.element);
    }
    this._replaceHTML(await this._renderHTML(), this.element);
    this.rendered = true;
    return this;
  }
}
class Sidebar { static TABS = { chat: {}, combat: {}, actors: {}, settings: { icon: 'fa-solid fa-gears' } }; }
window.foundry = {
  utils: { escapeHTML: esc, hasProperty: () => false },
  applications: { api: { ApplicationV2 }, sidebar: window.__noSidebar ? {} : { Sidebar, AbstractSidebarTab } },
};
window.CONFIG = { ui: {} };
// The bridge's sidecar socket, played by the test.
window.__ws = [];
window.WebSocket = class {
  static OPEN = 1;
  constructor(url) { this.url = url; this.readyState = 1; window.__ws.push(this); this.sent = []; setTimeout(() => this.onopen?.(), 10); }
  send(d) { this.sent.push(JSON.parse(d)); }
  close() {}
};
window.__boot = () => {
  Hooks.callAll('init');
  if (GM) window.__settings.bridgeUser = 'Gamemaster';
  Hooks.callAll('ready');
  window.ui.sidebar = { tabGroups: { primary: 'chat' } };
  // The sidebar's tab bar, as Foundry would draw it from Sidebar.TABS.
  const bar = document.querySelector('#sidebar-tabs menu');
  for (const [name, cfg] of Object.entries(foundry.applications.sidebar.Sidebar?.TABS ?? Sidebar.TABS)) {
    const li = document.createElement('li');
    li.innerHTML = `<button data-tab="${name}" class="${cfg.icon ?? ''}" title="${cfg.tooltip ?? name}">${name === 'magi' ? '🎩' : name[0]}</button>`;
    bar.append(li);
  }
  Hooks.callAll('renderSidebar');
  if (!CONFIG.ui.magi) return;
  window.ui.magi = new CONFIG.ui.magi();
  window.ui.magi.render({ force: true });
};
