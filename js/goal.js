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

const bar = (pct, cls) =>
  `<div class="bar"><div class="bar-fill ${cls || ''}" style="width:${Math.min(pct, 100)}%"></div></div>`;

async function render() {
  await ensureAuth();
  const card = await iframe.getCard();

  // getCard() в секции отдаёт карточку без .properties — саму цель тянем из API,
  // иначе не узнать её план по метрике (а без него не посчитать движение к цели).
  const [defs, children, self] = await Promise.all([
    api.get('/api/v1/company/custom-properties?limit=200'),
    api.get(`/api/v1/cards/${card.id}/children`),
    api.get(`/api/v1/cards/${card.id}`),
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
  let planSum = 0, factSum = 0, doneSum = 0, totalSum = 0;
  rows.forEach((r) => {
    n[r.cls]++; planSum += r.plan || 0; factSum += r.fact || 0;
    doneSum += r.done || 0; totalSum += r.total || 0;
  });

  // ДВИЖЕНИЕ К ЦЕЛИ — две РАЗНЫЕ вещи, которые старый процесс путал:
  //  • работы — сколько задач проектов закрыто (делаем ли мы дело);
  //  • метрика — сколько из плана цели уже набрано фактом (двигает ли это цель).
  const goalMetric = readProp(defs, self, F.metric);
  const goalPlan = Number(readProp(defs, self, F.plan)) || 0;
  const workPct = totalSum ? Math.round((doneSum / totalSum) * 100) : 0;
  const metricPct = goalPlan ? Math.round((factSum / goalPlan) * 100) : null;

  const heroCls = n.bad ? 'bad' : n.warn ? 'warn' : 'ok';
  root.innerHTML = `
    <div class="hero ${heroCls}">
      <span class="hero-dot"></span>
      <div class="hero-main">
        <div class="hero-status">${rows.length} ${rows.length === 1 ? 'проект' : 'проектов'} · работы ${workPct}%</div>
        <div class="hero-sub">🟢 ${n.ok} · 🟡 ${n.warn} · 🔴 ${n.bad}${n[''] ? ` · ⚪ ${n['']} без статуса` : ''}</div>
      </div>
      ${metricPct != null
        ? `<div class="hero-pct"><b>${metricPct}%</b><span>цели набрано</span></div>`
        : `<div class="hero-pct"><b>${workPct}%</b><span>работы</span></div>`}
    </div>

    <div class="card">
      <div class="card-title">🎯 Движение к цели</div>
      <div class="metric">
        <div class="metric-label">Работы</div>
        <div class="grow">${bar(workPct, heroCls)}</div>
        <div class="metric-num"><b>${doneSum}</b> из ${totalSum} задач</div>
      </div>
      ${goalPlan ? `
      <div class="metric">
        <div class="metric-label">${esc(goalMetric || 'Метрика')}</div>
        <div class="grow">${bar(metricPct || 0, metricPct >= 100 ? 'ok' : heroCls)}</div>
        <div class="metric-num"><b>${fmt(factSum)}</b> из ${fmt(goalPlan)}</div>
      </div>` : `
      <div class="load-foot">У цели не заполнен «План» по метрике — вклад проектов в цифрах не посчитать.</div>`}
      ${goalPlan ? `<div class="load-foot">работы = закрытые задачи проектов · метрика = факт проектов к плану цели</div>` : ''}
    </div>

    <div class="card">
      <div class="card-title">Проекты <span class="cnt">прогресс · деньги</span></div>
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
    </div>
  `;
  iframe.fitSize('#root');
}

render().catch((e) => {
  root.innerHTML = `<div class="muted">Не удалось загрузить: ${esc(e && e.message)}</div>`;
  iframe.fitSize('#root');
});
