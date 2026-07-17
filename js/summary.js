/* СВОДКА ДЛЯ РУКОВОДСТВА — попап, который превращает карточку в готовый
 * текст для Telegram или письма. Одна кнопка «Скопировать» вместо ручного
 * пересказа статусов.
 *
 * Проект → статус, готовность, деньги, срок, последний отчёт.
 * Цель/Направление → то же по каждому дочернему проекту + итоги.
 */

const iframe = Addon.iframe();
const api = iframe.getApiClient();
const root = document.getElementById('root');

const F = { status: 'Статус', plan: 'План', fact: 'Факт' };
const EMOJI = { 'В плане': '🟢', 'Отстаёт': '🟡', 'Критичные проблемы': '🔴' };
const SILENT_DAYS = 14;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => n == null ? '—' : Number(n).toLocaleString('ru');
const dstr = (iso) => iso ? new Date(iso).toLocaleDateString('ru') : null;
const daysAgo = (iso) => iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : null;

/* Разрешение спрашиваем ТОЛЬКО по клику: авто-authorize режет блокировщик попапов. */
async function ensureAuth() {
  try { await api.getAccessToken(); return; } catch (e) { /* токена ещё нет */ }
  await new Promise((resolve) => {
    root.innerHTML = `
      <div class="muted">Чтобы собрать сводку, аддону нужно разовое
      разрешение читать данные Kaiten от вашего имени.</div>
      <p><button id="auth-btn" type="button">🔓 Разрешить</button></p>
      <div class="muted" id="auth-msg"></div>`;
    iframe.fitSize('#root');
    document.getElementById('auth-btn').addEventListener('click', async () => {
      document.getElementById('auth-msg').textContent = 'Жду подтверждения в окне Kaiten…';
      try { await api.authorize(); resolve(); }
      catch (e) {
        document.getElementById('auth-msg').textContent =
          'Доступ не выдан: ' + ((e && e.message) || e);
      }
    });
  });
  root.innerHTML = '<div class="muted">Собираю сводку…</div>';
}

function readProp(defs, card, name) {
  const def = defs.find((p) => p.name === name);
  if (!def) return null;
  const raw = (card.properties || {})[`id_${def.id}`];
  if (raw == null) return null;
  if (Array.isArray(raw)) {
    const v = (def.values || []).find((x) => x.id === raw[0] || x.uid === raw[0]);
    return v ? (v.value || v.display_value) : null;
  }
  return raw;
}

function projectLine(defs, c) {
  const status = readProp(defs, c, F.status);
  const total = c.children_count || 0;
  const done = c.children_done || 0;
  const pct = total ? Math.round((done / total) * 100) : null;
  const plan = Number(readProp(defs, c, F.plan)) || null;
  const fact = Number(readProp(defs, c, F.fact)) || null;
  const silent = daysAgo(c.comment_last_added_at || c.created);

  let line = `${EMOJI[status] || '⚪'} ${c.title}`;
  const bits = [];
  if (pct != null) bits.push(`готовность ${pct}%`);
  if (plan != null) bits.push(`план ${fmt(plan)}${fact != null ? `, факт ${fmt(fact)}` : ''}`);
  if (c.due_date) bits.push(`срок ${dstr(c.due_date)}`);
  if (c.state !== 3 && silent != null && silent >= SILENT_DAYS) bits.push(`🔇 молчим ${silent} дн`);
  if (bits.length) line += ' — ' + bits.join(' · ');
  return line;
}

async function buildText() {
  const card = await iframe.getCard();
  const full = await api.get(`/api/v1/cards/${card.id}`);
  const defs = await api.get('/api/v1/company/custom-properties?limit=200');
  const today = new Date().toLocaleDateString('ru');
  const lines = [];

  const children = ((await api.get(`/api/v1/cards/${card.id}/children`)) || [])
    .filter((c) => c.condition === 1);

  if (children.length) {
    // цель или направление: сводка по вложенным
    lines.push(`📋 ${full.title} — сводка на ${today}`);
    const n = { '🟢': 0, '🟡': 0, '🔴': 0, '⚪': 0 };
    let planSum = 0, factSum = 0;
    for (const c of children) {
      n[EMOJI[readProp(defs, c, F.status)] || '⚪']++;
      planSum += Number(readProp(defs, c, F.plan)) || 0;
      factSum += Number(readProp(defs, c, F.fact)) || 0;
    }
    lines.push(`Всего ${children.length}: 🟢 ${n['🟢']} · 🟡 ${n['🟡']} · 🔴 ${n['🔴']}` +
      (n['⚪'] ? ` · ⚪ ${n['⚪']}` : ''));
    if (planSum) lines.push(`💰 План ${fmt(planSum)} · Факт ${fmt(factSum)}`);
    lines.push('');
    // проблемные сверху — их читают первыми
    const order = { '🔴': 0, '🟡': 1, '⚪': 2, '🟢': 3 };
    children
      .map((c) => ({ c, e: EMOJI[readProp(defs, c, F.status)] || '⚪' }))
      .sort((a, b) => order[a.e] - order[b.e])
      .forEach(({ c }) => lines.push(projectLine(defs, c)));
  } else {
    // одиночный проект
    lines.push(`📋 ${full.title} — сводка на ${today}`);
    lines.push(projectLine(defs, full));
    // последний отчёт из комментариев — цитата для контекста
    try {
      const comments = (await api.get(`/api/v1/cards/${full.id}/comments`)) || [];
      const report = comments.filter((c) => /Отчёт|Статус/i.test(c.text || '')).pop();
      if (report) {
        const excerpt = (report.text || '').replace(/[#*]/g, '').replace(/\s+/g, ' ').slice(0, 200);
        lines.push('');
        lines.push(`📝 Последний отчёт (${dstr(report.created)}): ${excerpt}`);
      }
    } catch (e) { /* сводка полезна и без цитаты */ }
  }

  return lines.join('\n');
}

async function render() {
  await ensureAuth();
  const text = await buildText();

  root.innerHTML = `
    <textarea id="out" rows="14" spellcheck="false"></textarea>
    <div class="actions">
      <button id="copy" class="primary" type="button">📋 Скопировать</button>
      <span id="msg" class="muted">и вставляйте в Telegram или письмо</span>
    </div>`;
  document.getElementById('out').value = text;

  document.getElementById('copy').addEventListener('click', async () => {
    const out = document.getElementById('out');
    const msg = document.getElementById('msg');
    out.select();
    try {
      await navigator.clipboard.writeText(out.value);
      msg.textContent = '✅ Скопировано';
    } catch (e) {
      // clipboard API в iframe может быть закрыт — старый добрый execCommand
      const ok = document.execCommand && document.execCommand('copy');
      msg.textContent = ok ? '✅ Скопировано' : 'Не вышло — выделите текст и ⌘C';
    }
  });
  iframe.fitSize('#root');
}

render().catch((e) => {
  root.innerHTML = `<div class="muted">Не удалось собрать: ${esc(e && e.message)}</div>`;
  iframe.fitSize('#root');
});
