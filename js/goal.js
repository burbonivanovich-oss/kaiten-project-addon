/* СВОДКА ПО ВЛОЖЕННЫМ — секция на карточке Цели или Направления.
 *
 * Один экран отвечает на вопрос «как дела у направления?»: светофоры всех
 * дочерних проектов, их готовность, план/факт и кто давно молчит.
 * Данные — из REST API от имени смотрящего (OAuth по клику, как в project.js).
 */

const iframe = Addon.iframe();
const api = iframe.getApiClient();
const root = document.getElementById('root');

const F = { status: 'Статус', plan: 'План', fact: 'Факт' };
const STATUS_CLASS = { 'В плане': 'ok', 'Отстаёт': 'warn', 'Критичные проблемы': 'bad' };
const ORDER = { bad: 0, warn: 1, ok: 2, '': 3 };
const SILENT_DAYS = 14;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => n == null ? '—' : Number(n).toLocaleString('ru');

/* Разрешение спрашиваем ТОЛЬКО по клику: авто-authorize режет блокировщик попапов. */
async function ensureAuth() {
  try { await api.getAccessToken(); return; } catch (e) { /* токена ещё нет */ }
  await new Promise((resolve) => {
    root.innerHTML = `
      <div class="gate">
        <div class="gate-icon">🔐</div>
        <div class="gate-title">Нужно разовое разрешение</div>
        <p class="gate-text">Сводка читает данные Kaiten от вашего имени —
        один раз подтвердите доступ, дальше без вопросов.</p>
        <button id="auth-btn" type="button" class="primary">Разрешить и показать</button>
        <div class="gate-msg" id="auth-msg"></div>
      </div>`;
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
  root.innerHTML = '<div class="muted">Загружаю…</div>';
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

const daysAgo = (iso) => iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : null;

async function render() {
  await ensureAuth();
  const card = await iframe.getCard();

  const [defs, children] = await Promise.all([
    api.get('/api/v1/company/custom-properties?limit=200'),
    api.get(`/api/v1/cards/${card.id}/children`),
  ]);

  const live = (children || []).filter((c) => c.condition === 1);
  if (!live.length) {
    root.innerHTML = '<div class="muted">Вложенных карточек пока нет. ' +
      'Кнопка «➕ Проект к этой цели» заведёт первую.</div>';
    iframe.fitSize('#root');
    return;
  }

  const rows = live.map((c) => {
    const status = readProp(defs, c, F.status);
    const cls = STATUS_CLASS[status] || '';
    const total = c.children_count || 0;
    const done = c.children_done || 0;
    const silent = daysAgo(c.comment_last_added_at || c.created);
    return {
      c, status, cls,
      pct: total ? Math.round((done / total) * 100) : 0,
      done, total,
      plan: Number(readProp(defs, c, F.plan)) || null,
      fact: Number(readProp(defs, c, F.fact)) || null,
      silent: (c.state !== 3 && silent != null && silent >= SILENT_DAYS) ? silent : null,
    };
  }).sort((a, b) =>
    (ORDER[a.cls] - ORDER[b.cls]) || ((b.plan || 0) - (a.plan || 0)));

  const n = { ok: 0, warn: 0, bad: 0, '': 0 };
  let planSum = 0, factSum = 0;
  rows.forEach((r) => { n[r.cls]++; planSum += r.plan || 0; factSum += r.fact || 0; });

  root.innerHTML = `
    <div class="head">
      <span class="status">${rows.length} шт.</span>
      <span class="chip">🟢 ${n.ok}</span>
      <span class="chip">🟡 ${n.warn}</span>
      <span class="chip">🔴 ${n.bad}</span>
      ${n[''] ? `<span class="chip muted">⚪ ${n['']} без статуса</span>` : ''}
      <span class="stale-num">План ${fmt(planSum)} · Факт ${fmt(factSum)}</span>
    </div>
    ${rows.map((r) => `
      <div class="g-row">
        <span class="dot ${r.cls}"></span>
        <span class="g-title">${esc(r.c.title)}</span>
        ${r.silent ? `<span class="g-silent">🔇 ${r.silent} дн</span>` : ''}
        <span class="g-bar"><span class="bar"><span class="bar-fill ${r.cls}"
          style="display:block;width:${Math.min(r.pct, 100)}%"></span></span></span>
        <span class="g-num">${r.total ? `${r.pct}%` : '—'}</span>
        <span class="g-money">${fmt(r.plan)}${r.fact != null ? ` / ${fmt(r.fact)}` : ''}</span>
      </div>`).join('')}
    <div class="muted g-foot">прогресс = закрытые задачи · деньги = План / Факт</div>
  `;
  iframe.fitSize('#root');
}

render().catch((e) => {
  root.innerHTML = `<div class="muted">Не удалось загрузить: ${esc(e && e.message)}</div>`;
  iframe.fitSize('#root');
});
