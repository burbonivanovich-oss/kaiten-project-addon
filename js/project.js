/* СТРАНИЦА ПРОЕКТА — то, чего в Kaiten нет: один экран, где видно всё.
 *
 * Светофор · готовность · метрика план/факт · задачи ПО КОМАНДАМ ·
 * история статусов · «молчим N дней».
 *
 * Данные берём из обычного REST API Kaiten — от имени того, кто смотрит.
 * getApiClient() сам держит OAuth-токен и обновляет его на 401.
 * Никаких паролей и ключей мы не храним.
 */

const iframe = Addon.iframe();
const api = iframe.getApiClient();
const root = document.getElementById('root');

const F = { status: 'Статус', metric: 'Что меряем', plan: 'План', fact: 'Факт', estimate: 'Оценка, чел-дн' };
const STATUS_CLASS = { 'В плане': 'ok', 'Отстаёт': 'warn', 'Критичные проблемы': 'bad' };

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* Разрешение спрашиваем ТОЛЬКО по клику: окно OAuth, открытое без действия
 * пользователя, режет блокировщик попапов — страница зависала на «Загружаю…». */
async function ensureAuth() {
  try { await api.getAccessToken(); return; } catch (e) { /* токена ещё нет */ }
  await new Promise((resolve) => {
    root.innerHTML = `
      <div class="gate">
        <div class="gate-icon">🔐</div>
        <div class="gate-title">Нужно разовое разрешение</div>
        <p class="gate-text">Ход проекта читает данные Kaiten от вашего имени —
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

const bar = (pct, cls) =>
  `<div class="bar"><div class="bar-fill ${cls || ''}" style="width:${Math.min(pct, 100)}%"></div></div>`;

const daysAgo = (iso) => iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : null;

async function render() {
  await ensureAuth();
  const card = await iframe.getCard();

  const [defs, children, comments] = await Promise.all([
    api.get('/api/v1/company/custom-properties?limit=200'),
    api.get(`/api/v1/cards/${card.id}/children`),
    api.get(`/api/v1/cards/${card.id}/comments`),
  ]);

  const status = readProp(defs, card, F.status);
  const metric = readProp(defs, card, F.metric);
  const plan = Number(readProp(defs, card, F.plan)) || 0;
  const fact = Number(readProp(defs, card, F.fact)) || 0;

  const total = children.length;
  const done = children.filter((c) => c.condition === 2 || c.state === 3).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const factPct = plan ? Math.round((fact / plan) * 100) : 0;

  // Группируем задачи ПО ДОСКАМ = по командам. Это ответ на «кто что делает».
  const byBoard = {};
  for (const c of children) {
    const key = (c.board && c.board.title) || `Доска ${c.board_id}`;
    (byBoard[key] = byBoard[key] || []).push(c);
  }

  // п.4 — плановая загрузка: оценка задачи (чел-дн) идёт на её исполнителей
  // (участников кроме создателя-owner). Kaiten считает загрузку только по явным
  // часам на Timeline; здесь — прогноз по проекту на этапе планирования.
  const estDef = defs.find((p) => p.name === F.estimate);
  const load = {};
  let totalPlan = 0;
  for (const t of children) {
    const est = estDef ? Number((t.properties || {})[`id_${estDef.id}`]) || 0 : 0;
    if (!est) continue;
    totalPlan += est;
    const assignees = (t.members || []).filter((m) => m.id !== t.owner_id);
    const targets = assignees.length ? assignees : (t.members || []).slice(0, 1);
    for (const m of targets) load[m.full_name] = (load[m.full_name] || 0) + est;
  }
  const loadRows = Object.entries(load).sort((a, b) => b[1] - a[1]);
  const maxLoad = loadRows.length ? loadRows[0][1] : 0;

  const history = comments.filter((c) => /Статус|Отчёт/i.test(c.text || '')).slice(-6).reverse();
  const last = comments.length ? comments[comments.length - 1] : null;
  const silent = daysAgo(last && last.created);

  root.innerHTML = `
    <div class="head">
      <span class="dot ${STATUS_CLASS[status] || ''}"></span>
      <span class="status">${esc(status || 'статус не задан')}</span>
      ${silent != null && silent > 14 ? `<span class="stale">молчим ${silent} дн.</span>` : ''}
    </div>

    <div class="row">
      <div class="label">Готовность</div>
      <div class="grow">${bar(pct)}</div>
      <div class="num">${pct}% · ${done}/${total}</div>
    </div>

    ${metric ? `
    <div class="row">
      <div class="label">${esc(metric)}</div>
      <div class="grow">${bar(factPct, STATUS_CLASS[status])}</div>
      <div class="num">${fact} из ${plan}</div>
    </div>` : ''}

    <div class="section">Задачи по командам</div>
    ${Object.keys(byBoard).length === 0
      ? '<div class="muted">Задач пока нет. Заведите их на досках команд и укажите этот проект родителем.</div>'
      : Object.entries(byBoard).map(([board, list]) => `
        <div class="board">
          <div class="board-name">${esc(board)} <span class="muted">${
            list.filter((c) => c.condition === 2 || c.state === 3).length}/${list.length}</span></div>
          ${list.map((c) => `
            <div class="task ${(c.condition === 2 || c.state === 3) ? 'done' : ''}">
              <span class="tick">${(c.condition === 2 || c.state === 3) ? '✓' : '·'}</span>
              <span class="t-title">${esc(c.title)}</span>
              ${c.due_date ? `<span class="due">${new Date(c.due_date).toLocaleDateString('ru')}</span>` : ''}
            </div>`).join('')}
        </div>`).join('')}

    ${loadRows.length ? `
    <div class="load-head">Загрузка команды (план) · ${totalPlan} чел-дн</div>
    ${loadRows.map(([name, days]) => `
      <div class="load-row">
        <span class="load-name">${esc(name)}</span>
        <span class="load-bar">${bar(maxLoad ? Math.round(days / maxLoad * 100) : 0)}</span>
        <span class="load-num">${days} чел-дн</span>
      </div>`).join('')}
    <div class="load-foot">оценка задачи идёт на её исполнителей; заполняется полем «Оценка, чел-дн»</div>
    ` : ''}

    <div class="section">История статусов</div>
    ${history.length === 0
      ? '<div class="muted">Пока пусто. Появится, когда статус изменится или выйдет отчёт.</div>'
      : history.map((c) => `
        <div class="hist">
          <span class="hist-date">${new Date(c.created).toLocaleDateString('ru')}</span>
          <span class="hist-text">${esc((c.text || '').replace(/[#*]/g, '').slice(0, 90))}</span>
        </div>`).join('')}
  `;

  iframe.fitSize('#root');   // подогнать высоту iframe под содержимое
}

render().catch((e) => {
  root.innerHTML = `<div class="muted">Не удалось загрузить: ${esc(e && e.message)}</div>`;
});
