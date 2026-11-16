/**
 * Magi Bridge — the MAGI advisor's messages in Foundry.
 *
 * Everyone (players and GMs) can ask the MAGI advisor something from the MAGI
 * sidebar tab, and the advisor answers or gives live feedback there. Both go
 * through Foundry's own chat, as whispered ChatMessages flagged
 * `flags.magi-bridge.advisor`, because Foundry already settles the two things
 * that matter:
 *
 * - who asked: Foundry's server only lets a user create a message as
 *   themselves, so a question's author is who really asked;
 * - who sees what: a whisper reaches only its recipients and the GMs. A
 *   player's question is whispered to the GMs (the bridge GM relays it), and
 *   the answer to that player and the GMs. A GM's question, and advice meant
 *   for GMs, is whispered to GMs only.
 *
 * These messages are hidden from the chat log (unless a user turns on "Show
 * MAGI advisor messages in chat"), are never reported to the Director as table
 * talk, and the MAGI tab shows them instead. An advisor answer counts only if a
 * GM wrote it, so a player can't make something look like it came from MAGI.
 *
 * The bridge (the GM browser connected to the sidecar) relays each question to
 * the sidecar as `advisorAsk`, and posts the advisor's `advisorSay` replies.
 * Status (is the bridge up, is Magi Server's advisor listening) goes to every
 * browser over the module socket.
 */

export const MODULE_ID = 'magi-bridge';
export const SOCKET = `module.${MODULE_ID}`;
/** How old an unanswered question may be and still be relayed when the bridge reconnects. */
const RESEND_MS = 10 * 60_000;

/** The advisor flag on a message, or null. */
export function advisorFlag(msg) {
  return msg?.getFlag?.(MODULE_ID, 'advisor') ?? msg?.flags?.[MODULE_ID]?.advisor ?? null;
}

export const isAdvisorMessage = (msg) => !!advisorFlag(msg);

/** The ids of every GM and assistant GM. */
export function gmIds() {
  return game.users.filter((u) => u.isGM).map((u) => u.id);
}

export function roleOf(user) {
  if (!user) return 'player';
  if (user.role >= CONST.USER_ROLES.GAMEMASTER) return 'gm';
  if (user.isGM) return 'assistant';
  return 'player';
}

/** A message is a genuine advisor reply only if a GM wrote it. */
export function isGenuineReply(msg) {
  const flag = advisorFlag(msg);
  return !!flag && flag.kind === 'say' && !!(msg.author ?? msg.user)?.isGM;
}

export const plainText = (html) => {
  const div = document.createElement('div');
  div.innerHTML = html ?? '';
  return (div.textContent ?? '').trim();
};

const esc = (s) => foundry.utils.escapeHTML(String(s ?? ''));

/**
 * Ask the advisor, as the current user. A GM's question is GM-only; a player's
 * is for them alone (and the GMs, who see every whisper).
 */
export async function ask(text, topic = '') {
  const clean = String(text ?? '').trim().slice(0, 4000);
  if (!clean) return null;
  const audience = game.user.isGM ? 'gm' : 'me';
  return ChatMessage.create({
    content: esc(clean).replace(/\n/g, '<br>'),
    speaker: { alias: game.user.name },
    whisper: [...new Set([...gmIds(), game.user.id])],
    flags: { [MODULE_ID]: { advisor: { kind: 'ask', audience, topic: topic || null } } },
  });
}

/** Bridge side: the AdvisorAsk the sidecar gets for a question message, or null if it isn't one. */
export function askPayload(msg) {
  const flag = advisorFlag(msg);
  if (!flag || flag.kind !== 'ask') return null;
  const user = msg.author ?? msg.user;
  if (!user) return null;
  const role = roleOf(user);
  return {
    id: msg.id,
    user: user.name,
    userId: user.id,
    role,
    character: user.character?.name ?? null,
    text: plainText(msg.content).slice(0, 4000),
    // A player can't ask for GM-only advice, whatever the flag says.
    audience: role === 'player' ? 'me' : (flag.audience === 'me' ? 'me' : 'gm'),
    topic: typeof flag.topic === 'string' ? flag.topic.slice(0, 40) : undefined,
  };
}

/** Bridge side: post what the advisor says. Returns a short result for `actionResult`. */
export async function say(msg) {
  if (!game.settings.get(MODULE_ID, 'advisorEnabled')) return { ok: false, detail: 'advisor-off' };
  const gms = gmIds();
  let whisper;
  let to = null;
  if (msg.audience === 'table') {
    whisper = [];
  } else if (msg.audience === 'gm') {
    whisper = gms;
  } else if (msg.audience === 'asker') {
    const asked = game.messages.get(msg.replyTo);
    const asker = asked?.author ?? asked?.user;
    if (!asker) return { ok: false, detail: 'no-question' };
    to = asker.name;
    // A GM-only question gets a GM-only answer.
    whisper = advisorFlag(asked)?.audience === 'gm' && asker.isGM ? gms : [...new Set([asker.id, ...gms])];
  } else {
    const users = (msg.users ?? []).map((n) => game.users.getName(n)).filter(Boolean);
    if (!users.length) return { ok: false, detail: 'nobody to tell' };
    to = users.map((u) => u.name).join(', ');
    whisper = [...new Set([...users.map((u) => u.id), ...gms])];
  }
  const title = msg.title ? `<h4>${esc(msg.title)}</h4>` : '';
  await ChatMessage.create({
    content: title + esc(msg.text).replace(/\n/g, '<br>'),
    speaker: { alias: 'MAGI' },
    whisper,
    flags: { [MODULE_ID]: { advisor: { kind: 'say', audience: msg.audience, replyTo: msg.replyTo ?? null, to } } },
  });
  return { ok: true, detail: 'posted' };
}

/** Bridge side: questions from the last few minutes nobody answered, e.g. asked while the bridge was down. */
export function unanswered() {
  const since = Date.now() - RESEND_MS;
  const answered = new Set(game.messages.filter(isGenuineReply).map((m) => advisorFlag(m).replyTo).filter(Boolean));
  return game.messages.filter((m) => advisorFlag(m)?.kind === 'ask' && (m.timestamp ?? 0) >= since && !answered.has(m.id));
}
