/**
 * Magi Bridge — the MAGI tab in Foundry's right sidebar, for players and GMs.
 *
 * - The advisor chat: ask the MAGI advisor something and read its answers and
 *   live feedback (see magi-advisor.mjs for who sees what). It pops out into
 *   its own window.
 * - Status: is the Magi bridge connected, is Magi Server's advisor listening,
 *   does the Director run this table.
 * - The MAGI features each person can use: for players, how to play at a
 *   Director-run table; for GMs, the Director and bridge switches, sorting the
 *   Director's actors, video capture, and the MAGI dashboard.
 *
 * On Foundry v13 the tab is a real sidebar tab (AbstractSidebarTab). If that
 * API is missing or changes, a button is added to the sidebar's tab bar that
 * opens the same panel as a window, so the features never disappear.
 */

import {
  MODULE_ID, SOCKET, advisorFlag, ask, isGenuineReply, plainText,
} from './magi-advisor.mjs';

const TAB = 'magi';
const ICON = 'fa-solid fa-hat-wizard';
/** How long to wait for the bridge to answer a status request before calling it offline. */
const STATUS_TIMEOUT_MS = 4_000;

const esc = (s) => foundry.utils.escapeHTML(String(s ?? ''));

const PLAYER_PROMPTS = [
  { topic: 'character', label: 'My character', text: 'What is my character good at right now, and what could I try?' },
  { topic: 'rules', label: 'Explain a rule', text: 'Explain the rule that applies to what is happening right now.' },
  { topic: 'recap', label: 'Recap', text: 'Recap what has happened so far.' },
  { topic: 'next', label: 'What next?', text: 'What could my character do next?' },
];

const GM_PROMPTS = [
  { topic: 'spotlight', label: 'Spotlight', text: 'Who has not had the spotlight lately, and how could I bring them in?' },
  { topic: 'pacing', label: 'Pacing', text: 'How is the pacing? Should I speed up, slow down or change scene?' },
  { topic: 'complication', label: 'Complication', text: 'Suggest a complication that fits this scene and the people at the table.' },
  { topic: 'recap', label: 'Recap', text: 'Recap the session so far for me.' },
];

/** What the bridge reports: is it up, is the advisor listening, does the Director run the table. */
const status = {
  known: false,
  bridge: false,
  sidecar: false,
  advisor: false,
  advisorEnabled: true,
  tableControl: false,
  bridgeUser: '',
  recording: false,
};

const views = new Set();
let bridgeRef = null;
let statusTimer = null;
let unseen = 0;

function refreshAll() {
  for (const view of views) view.refresh();
  updateBadge();
}

function updateBadge() {
  const button = document.querySelector(`#sidebar-tabs [data-tab="${TAB}"], #magi-sidebar-fallback`);
  if (!button) return;
  button.classList.toggle('magi-unseen', unseen > 0);
  button.dataset.magiUnseen = unseen > 0 ? String(Math.min(unseen, 9)) : '';
}

function panelVisible() {
  const tabActive = ui.sidebar?.tabGroups?.primary === TAB && !ui.sidebar?._collapsed && ui.sidebar?.expanded !== false;
  return tabActive || [...views].some((v) => v.isPopout && v.rendered);
}

// ─── Status ──────────────────────────────────────────────

/** The bridge's own status, when this browser is the bridge. */
function localStatus() {
  return bridgeRef?.active ? bridgeRef.advisorStatus() : null;
}

function requestStatus() {
  const local = localStatus();
  if (local) {
    Object.assign(status, local, { known: true });
    refreshAll();
    return;
  }
  game.socket.emit(SOCKET, { type: 'statusRequest' });
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    Object.assign(status, { known: true, bridge: false, sidecar: false, advisor: false });
    refreshAll();
  }, STATUS_TIMEOUT_MS);
}

/** Called by the bridge when this browser is the bridge and something changed. */
export function bridgeStatusChanged(next) {
  Object.assign(status, next, { known: true });
  refreshAll();
}

function onSocket(data) {
  if (data?.type !== 'status') return;
  clearTimeout(statusTimer);
  Object.assign(status, data.status, { known: true });
  refreshAll();
}

function statusLine() {
  if (!game.settings.get(MODULE_ID, 'advisorEnabled')) return { cls: 'off', text: 'The GM has switched the MAGI advisor off' };
  if (!status.known) return { cls: 'wait', text: 'Checking…' };
  if (!status.bridge) return { cls: 'off', text: 'MAGI is offline: no bridge GM is logged in' };
  if (!status.sidecar) return { cls: 'off', text: 'The bridge is not connected to the Magi sidecar' };
  if (!status.advisor) return { cls: 'wait', text: 'Connected, but Magi Server\'s advisor is not listening' };
  return { cls: 'on', text: 'MAGI advisor online' };
}

// ─── Messages ────────────────────────────────────────────

function advisorMessages() {
  return game.messages.filter((m) => {
    const flag = advisorFlag(m);
    if (!flag || !m.visible) return false;
    return flag.kind === 'ask' || isGenuineReply(m);
  });
}

function onlyMine() {
  return game.user.isGM && game.settings.get(MODULE_ID, 'advisorOnlyMine');
}

function messageHtml(msg) {
  const flag = advisorFlag(msg);
  const author = msg.author ?? msg.user;
  const mine = author?.id === game.user.id;
  const time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  let who;
  let badge = '';
  if (flag.kind === 'ask') {
    who = mine ? 'You' : esc(author?.name ?? '?');
    if (flag.audience === 'gm') badge = 'GM only';
  } else {
    who = 'MAGI';
    if (flag.audience === 'gm') badge = 'GM only';
    else if (flag.audience === 'table') badge = 'Everyone';
    else if (flag.to && game.user.isGM && flag.to !== game.user.name) badge = `to ${esc(flag.to)}`;
  }
  const classes = ['magi-msg', flag.kind === 'ask' ? 'magi-ask' : 'magi-say', mine ? 'magi-mine' : ''].join(' ');
  return `<li class="${classes}" data-message-id="${msg.id}">
    <header><span class="magi-who">${who}</span>${badge ? `<span class="magi-badge">${badge}</span>` : ''}<time>${time}</time></header>
    <div class="magi-body">${msg.content}</div>
  </li>`;
}

function onChatMessage(msg, created) {
  if (!advisorFlag(msg)) return;
  if (created && isGenuineReply(msg) && msg.visible && !panelVisible()) {
    unseen += 1;
    if (game.settings.get(MODULE_ID, 'advisorToasts')) {
      ui.notifications.info(`MAGI: ${plainText(msg.content).slice(0, 140)}`);
    }
  }
  refreshAll();
}

// ─── The panel ───────────────────────────────────────────

/**
 * One rendering of the panel, in the sidebar tab or a popout window. `full`
 * adds the features and settings below the chat; the popout is chat only.
 */
class PanelView {
  constructor({ isPopout = false } = {}) {
    this.isPopout = isPopout;
    this.root = null;
    this.draft = '';
  }

  get rendered() {
    return !!this.root?.isConnected;
  }

  mount(root) {
    this.root = root;
    root.classList.add('magi-panel');
    if (this.isPopout) root.classList.add('magi-popout');
    root.innerHTML = this.template();
    this.bind();
    this.refresh();
    views.add(this);
  }

  unmount() {
    views.delete(this);
    this.root = null;
  }

  template() {
    const gm = game.user.isGM;
    const prompts = gm ? GM_PROMPTS : PLAYER_PROMPTS;
    const placeholder = gm ? 'Ask MAGI for GM advice (only GMs see this)…' : 'Ask MAGI anything (only you and the GM see this)…';
    return `
      <header class="magi-head">
        <span class="magi-title"><i class="${ICON}"></i> MAGI</span>
        <span class="magi-status" data-role="status"></span>
        ${this.isPopout ? '' : '<button type="button" class="magi-icon" data-action="popout" data-tooltip="Pop out the chat"><i class="fa-solid fa-arrow-up-right-from-square"></i></button>'}
      </header>
      ${gm ? `<label class="magi-filter"><input type="checkbox" data-action="only-mine"> Only my conversations</label>` : ''}
      <ol class="magi-log" data-role="log"></ol>
      <div class="magi-quick">${prompts.map((p) => `<button type="button" data-action="quick" data-topic="${p.topic}" data-text="${esc(p.text)}">${esc(p.label)}</button>`).join('')}</div>
      <form class="magi-ask-form" data-role="form">
        <textarea name="text" rows="2" placeholder="${esc(placeholder)}"></textarea>
        <button type="submit" data-tooltip="Send (Enter)"><i class="fa-solid fa-paper-plane"></i></button>
      </form>
      ${this.isPopout ? '' : `<section class="magi-features" data-role="features"></section>`}`;
  }

  bind() {
    const root = this.root;
    const form = root.querySelector('[data-role="form"]');
    const box = form.querySelector('textarea');
    box.value = this.draft;
    box.addEventListener('input', () => { this.draft = box.value; });
    box.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        form.requestSubmit();
      }
    });
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const text = box.value.trim();
      if (!text) return;
      box.value = '';
      this.draft = '';
      await this.send(text);
    });
    root.addEventListener('click', (ev) => this.onClick(ev));
    root.addEventListener('change', (ev) => this.onChange(ev));
  }

  async send(text, topic = '') {
    if (!game.settings.get(MODULE_ID, 'advisorEnabled')) {
      ui.notifications.warn('The GM has switched the MAGI advisor off.');
      return;
    }
    if (status.known && !status.advisor) {
      ui.notifications.warn('MAGI is not listening right now; your question is saved and will be answered when it is back (within 10 minutes).');
    }
    try {
      await ask(text, topic);
    } catch (err) {
      ui.notifications.error(`Could not ask MAGI: ${err?.message ?? err}`);
    }
  }

  async onClick(ev) {
    const el = ev.target.closest('[data-action]');
    if (!el || el.tagName === 'INPUT') return;
    const action = el.dataset.action;
    if (action === 'popout') return openPopout();
    if (action === 'quick') return this.send(el.dataset.text, el.dataset.topic);
    if (action === 'settings') {
      const cls = foundry.applications?.settings?.SettingsConfig ?? globalThis.SettingsConfig;
      return cls ? new cls().render({ force: true }) : undefined;
    }
    if (action === 'sort-actors') {
      const moved = await game.modules.get(MODULE_ID)?.api?.table?.sortActors();
      return ui.notifications.info(`Magi Director actors sorted (${moved ?? 0} moved).`);
    }
    if (action === 'record') {
      bridgeRef?.toggleRecording();
      return requestStatus();
    }
    if (action === 'refresh') return requestStatus();
  }

  async onChange(ev) {
    const el = ev.target;
    const setting = el.dataset.setting;
    if (setting) {
      await game.settings.set(MODULE_ID, setting, el.checked);
      return;
    }
    if (el.dataset.action === 'only-mine') {
      await game.settings.set(MODULE_ID, 'advisorOnlyMine', el.checked);
      refreshAll();
    }
  }

  refresh() {
    if (!this.rendered) return;
    const root = this.root;
    const line = statusLine();
    const statusEl = root.querySelector('[data-role="status"]');
    statusEl.className = `magi-status magi-${line.cls}`;
    statusEl.textContent = line.text;

    const filter = root.querySelector('[data-action="only-mine"]');
    if (filter) filter.checked = onlyMine();

    const log = root.querySelector('[data-role="log"]');
    let messages = advisorMessages();
    if (onlyMine()) {
      const mineAsks = new Set(messages.filter((m) => (m.author ?? m.user)?.id === game.user.id).map((m) => m.id));
      messages = messages.filter((m) => mineAsks.has(m.id) || mineAsks.has(advisorFlag(m).replyTo) || advisorFlag(m).audience !== 'asker');
    }
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.innerHTML = messages.length
      ? messages.slice(-200).map(messageHtml).join('')
      : `<li class="magi-empty">${game.user.isGM
        ? 'Ask MAGI for advice about the table. Its live feedback for you appears here too.'
        : 'Ask MAGI about your character, the rules or the story. Its live feedback for you appears here too.'}</li>`;
    if (atBottom || !this._scrolled) {
      log.scrollTop = log.scrollHeight;
      this._scrolled = true;
    }

    const features = root.querySelector('[data-role="features"]');
    if (features) features.innerHTML = game.user.isGM ? this.gmFeatures() : this.playerFeatures();
  }

  playerFeatures() {
    const character = game.user.character?.name;
    return `
      <details open><summary>Playing with MAGI</summary>
        <ul class="magi-help">
          <li>${character ? `You play <b>${esc(character)}</b>.` : 'No character is assigned to you yet.'}</li>
          <li>When the Director runs the table, it asks you what you do in chat: just answer there.</li>
          <li>Drag your own token to move. A move the rules don't allow snaps back, with the reason.</li>
          <li>Loot and gear in chat: <code>take the shortbow from Goblin 1</code>, <code>equip the shortbow</code>, <code>stow the dagger</code>.</li>
          <li>A fallen foe's sheet opens for everyone, so you can see what it carried.</li>
          <li>Questions you ask here are seen only by you and the GMs.</li>
        </ul>
      </details>
      ${this.dashboardLink()}`;
  }

  gmFeatures() {
    const s = status;
    const isBridge = !!bridgeRef?.active;
    const check = (setting, label, hint) => `
      <label class="magi-check" data-tooltip="${esc(hint)}">
        <input type="checkbox" data-setting="${setting}" ${game.settings.get(MODULE_ID, setting) ? 'checked' : ''}> ${esc(label)}
      </label>`;
    const dot = (on) => `<i class="fa-solid fa-circle ${on ? 'magi-on' : 'magi-off'}"></i>`;
    return `
      <details open><summary>MAGI integration</summary>
        <ul class="magi-state">
          <li>${dot(s.bridge)} Bridge GM: ${s.bridge ? esc(s.bridgeUser || 'logged in') : 'nobody'}${isBridge ? ' (this browser)' : ''}</li>
          <li>${dot(s.sidecar)} Magi sidecar ${s.sidecar ? 'connected' : 'not connected'}</li>
          <li>${dot(s.advisor)} Magi Server advisor ${s.advisor ? 'listening' : 'not listening'}</li>
          <li>${dot(s.tableControl)} Director ${s.tableControl ? 'may run the table' : 'does not run the table'}</li>
        </ul>
        ${check('advisorEnabled', 'MAGI advisor', 'Let players and GMs ask MAGI from this tab, and let MAGI give live feedback here.')}
        ${check('directorRunsTable', 'Director runs the table', 'Let the Magi Director draw scenes, move tokens, narrate and whisper without asking each time.')}
        ${check('advisorToasts', 'Pop up new MAGI messages', 'Show a notification when MAGI says something while this tab is closed (this browser only).')}
        <div class="magi-buttons">
          <button type="button" data-action="sort-actors" data-tooltip="File every Magi Director actor under Player Characters, NPCs or Foes"><i class="fa-solid fa-folder-tree"></i> Sort Director actors</button>
          ${isBridge ? `<button type="button" data-action="record"><i class="fa-solid fa-video"></i> ${s.recording ? 'Stop' : 'Start'} recording</button>` : ''}
          <button type="button" data-action="refresh"><i class="fa-solid fa-rotate"></i> Refresh</button>
          <button type="button" data-action="settings"><i class="fa-solid fa-gears"></i> Settings</button>
        </div>
      </details>
      <details><summary>What MAGI does here</summary>
        <ul class="magi-help">
          <li><b>Advisor</b>: players and GMs ask questions here; MAGI answers, and gives live feedback on spotlight and pacing.</li>
          <li><b>Director runs the table</b>: scenes, maps, tokens, HP, attack lines, narration and whispers from Magi Server's Director.</li>
          <li><b>Statblocks and loot</b>: SRD 5E sheets, gear and conditions written onto Director actors; fallen foes become lootable.</li>
          <li><b>Speak / roll as an actor</b>: the Director asks you to approve each line or roll in a dialog.</li>
          <li><b>Sign-in from Magi</b>: the MAGI dashboard can open Foundry as a seated player.</li>
          <li><b>Video capture</b> (optional, off by default): recorded by the bridge GM for training data.</li>
        </ul>
      </details>
      ${this.dashboardLink()}`;
  }

  dashboardLink() {
    const url = game.settings.get(MODULE_ID, 'dashboardUrl');
    if (!url || !/^https?:\/\//.test(url)) return '';
    return `<a class="magi-dashboard" href="${esc(url)}" target="_blank" rel="noopener"><i class="fa-solid fa-up-right-from-square"></i> Open the MAGI dashboard</a>`;
  }
}

// ─── Sidebar tab (Foundry v13) and the popout window ─────

let MagiSidebarTab = null;
let MagiChatWindow = null;
let popout = null;

function defineApps() {
  const api = foundry.applications?.api;
  const Abstract = foundry.applications?.sidebar?.AbstractSidebarTab;
  if (Abstract) {
    MagiSidebarTab = class extends Abstract {
      static tabName = TAB;
      static DEFAULT_OPTIONS = { classes: ['magi-sidebar'], window: { title: 'MAGI' } };
      view = new PanelView();
      async _renderHTML() {
        return true;
      }
      _replaceHTML(_result, content) {
        if (this.view.root !== content) this.view.mount(content);
        else this.view.refresh();
      }
      _onActivate() {
        super._onActivate?.();
        unseen = 0;
        updateBadge();
        this.view.refresh();
      }
    };
  }
  if (api?.ApplicationV2) {
    MagiChatWindow = class extends api.ApplicationV2 {
      static DEFAULT_OPTIONS = {
        id: 'magi-chat-popout',
        classes: ['magi-window'],
        window: { title: 'MAGI', icon: ICON, resizable: true, minimizable: true },
        position: { width: 380, height: 560 },
      };
      constructor(options = {}) {
        super(options);
        this.view = new PanelView({ isPopout: options.full ? false : true });
      }
      async _renderHTML() {
        return true;
      }
      _replaceHTML(_result, content) {
        if (this.view.root !== content) this.view.mount(content);
        else this.view.refresh();
        unseen = 0;
        updateBadge();
      }
      _onClose(options) {
        this.view.unmount();
        super._onClose?.(options);
      }
    };
  }
}

/** The advisor chat in its own window. `full` shows the whole panel (the fallback when there's no sidebar tab). */
export function openPopout({ full = false } = {}) {
  if (!MagiChatWindow) return;
  if (popout?.rendered) {
    popout.bringToFront?.();
    return;
  }
  popout = new MagiChatWindow({ full });
  popout.render({ force: true });
}

function registerSidebarTab() {
  const Sidebar = foundry.applications?.sidebar?.Sidebar;
  if (!Sidebar?.TABS || !MagiSidebarTab) return false;
  if (Sidebar.TABS[TAB]) return true;
  // Just before Settings, so the core tabs keep their places.
  const tabs = {};
  for (const [name, config] of Object.entries(Sidebar.TABS)) {
    if (name === 'settings') tabs[TAB] = { icon: ICON, tooltip: 'MAGI' };
    tabs[name] = config;
  }
  if (!tabs[TAB]) tabs[TAB] = { icon: ICON, tooltip: 'MAGI' };
  Sidebar.TABS = tabs;
  CONFIG.ui[TAB] = MagiSidebarTab;
  return true;
}

/** No sidebar tab after all (an older or changed sidebar): a button in the tab bar that opens the whole panel. */
function ensureFallbackButton() {
  if (document.querySelector(`#sidebar-tabs [data-tab="${TAB}"]`)) return;
  const bar = document.querySelector('#sidebar-tabs menu, #sidebar-tabs');
  if (!bar || document.getElementById('magi-sidebar-fallback')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'magi-sidebar-fallback';
  button.className = `ui-control plain icon ${ICON}`;
  button.dataset.tooltip = 'MAGI';
  button.setAttribute('aria-label', 'MAGI');
  button.addEventListener('click', () => openPopout({ full: true }));
  const settings = bar.querySelector('[data-tab="settings"]');
  const item = bar.tagName === 'MENU' ? document.createElement('li') : null;
  const node = item ?? button;
  if (item) item.append(button);
  const anchor = settings?.closest('li') ?? settings;
  if (anchor?.parentElement === bar) bar.insertBefore(node, anchor);
  else bar.append(node);
}

// ─── Wiring ──────────────────────────────────────────────

/** At init: settings and the sidebar tab. */
export function initPanel(bridge) {
  bridgeRef = bridge;
  game.settings.register(MODULE_ID, 'advisorEnabled', {
    name: 'MAGI advisor',
    hint: 'Let players and GMs ask the MAGI advisor questions from the MAGI tab, and let MAGI give live feedback there.',
    scope: 'world', config: true, restricted: true, type: Boolean, default: true,
    onChange: () => { bridge.broadcastStatus?.(); refreshAll(); },
  });
  game.settings.register(MODULE_ID, 'dashboardUrl', {
    name: 'MAGI dashboard URL',
    hint: 'Where the MAGI dashboard is (e.g. https://52.9.223.25:8675/director). Shown as a link in the MAGI tab; leave empty to hide it.',
    scope: 'world', config: true, restricted: true, type: String, default: '',
    onChange: () => refreshAll(),
  });
  game.settings.register(MODULE_ID, 'showAdvisorInChat', {
    name: 'Show MAGI advisor messages in chat',
    hint: 'Also show questions to MAGI and its answers in the chat log (they are always in the MAGI tab).',
    scope: 'client', config: true, type: Boolean, default: false,
    onChange: () => ui.chat?.render?.(),
  });
  game.settings.register(MODULE_ID, 'advisorToasts', {
    name: 'Pop up new MAGI messages',
    hint: 'Show a notification when MAGI says something while the MAGI tab is closed.',
    scope: 'client', config: true, type: Boolean, default: true,
  });
  game.settings.register(MODULE_ID, 'advisorOnlyMine', {
    scope: 'client', config: false, type: Boolean, default: false,
  });

  defineApps();
  try {
    registerSidebarTab();
  } catch (err) {
    console.warn('Magi Bridge | could not add the MAGI sidebar tab; using a button instead:', err);
  }

  // Advisor traffic lives in the MAGI tab, not the chat log.
  const hide = (msg, html) => {
    if (!advisorFlag(msg) || game.settings.get(MODULE_ID, 'showAdvisorInChat')) return;
    const el = html instanceof HTMLElement ? html : html?.[0];
    if (el) el.style.display = 'none';
  };
  Hooks.on('renderChatMessageHTML', hide);
  Hooks.on('renderChatMessage', hide);

  Hooks.on('createChatMessage', (msg) => onChatMessage(msg, true));
  Hooks.on('updateChatMessage', (msg) => onChatMessage(msg, false));
  Hooks.on('deleteChatMessage', (msg) => onChatMessage(msg, false));
  Hooks.on('renderSidebar', () => setTimeout(() => {
    ensureFallbackButton();
    updateBadge();
  }, 0));
  Hooks.on('changeSidebarTab', (app) => {
    if ((app?.tabName ?? app?.options?.id) === TAB) {
      unseen = 0;
      updateBadge();
    }
  });
}

/** At ready: listen for the bridge's status and ask for it. */
export function readyPanel() {
  game.socket.on(SOCKET, onSocket);
  const tab = ui[TAB];
  if (tab && !tab.rendered) {
    try {
      tab.render({ force: true });
    } catch (err) {
      console.warn('Magi Bridge | MAGI tab did not render:', err);
    }
  }
  setTimeout(ensureFallbackButton, 500);
  requestStatus();
  setInterval(requestStatus, 60_000);
}
