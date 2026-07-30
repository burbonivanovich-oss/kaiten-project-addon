/* СТРАНИЦА ПРОЕКТА — один экран здоровья проекта.
 *
 * БАЗОВЫЙ слой (готовность · срок · «молчим») берётся из самой карточки через
 * SDK getCard() — postMessage, без OAuth. Работает всегда, хиро ведёт готовностью.
 *
 * РАСШИРЕННЫЙ слой (статус · метрика план/факт · задачи по командам · загрузка ·
 * история) требует чтения свойств/детей/комментариев — это REST API от имени
 * пользователя (OAuth). Best-effort: получилось — хиро «повышается» до статусного
 * и добавляются блоки; не получилось (напр. addon-OAuth аккаунта отдаёт токен,
 * который API отклоняет 401) — экран не пустует: базовый слой виден, блок помечен.
 *
 * Почему значения свойств нельзя взять без API: getCard() в секции отдаёт карточку
 * без .properties; getCardProperties() в контексте секции значений не даёт, а в
 * card_body_section вовсе бросает «Unknown subject»; мост через setData/getData
 * между бейджами и секцией данные не разделяет. Проверено — только API.
 */

const iframe = Addon.iframe();
const root = document.getElementById('root');

const F = { status: 'Статус', metric: 'Что меряем', plan: 'План', fact: 'Факт', estimate: 'Оценка, ч' };
const STATUS_CLASS = { 'В плане': 'ok', 'Отстаёт': 'warn', 'Критичные проблемы': 'bad' };

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function readProp(defs, card, name) {
  const def = (defs || []).find((p) => p.name === name);
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

const AVA_COLORS = ['#6c5cd4', '#2aa1c0', '#c0692a', '#2f9e6f', '#c0457a', '#5a76d4', '#b8902a'];
function avatar(name) {
  const s = String(name || '?');
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const initial = s.trim().charAt(0).toUpperCase() || '?';
  return `<span class="ava" style="background:${AVA_COLORS[h % AVA_COLORS.length]}">${esc(initial)}</span>`;
}

function heroHtml(cls, title, sub, pct) {
  return `
    <div class="hero ${cls}">
      <span class="hero-dot"></span>
      <div class="hero-main">
        <div class="hero-status">${esc(title)}</div>
        <div class="hero-sub">${sub}</div>
      </div>
      <div class="hero-pct"><b>${pct}%</b><span>готово</span></div>
    </div>`;
}

/* Расширенный слой через REST API. Возвращает { status, metricHtml, blocks } или
 * null, если API недоступен (нет токена / 401 / ошибка). */
async function extendedBlocks(card) {
  let api;
  try { api = iframe.getApiClient(); } catch (e) { return null; }
  try { await api.getAccessToken(); } catch (e) { return null; }

  let defs, full, children, comments;
  try {
    [defs, full, children, comments] = await Promise.all([
      api.get('/api/v1/company/custom-properties?limit=200'),
      api.get(`/api/v1/cards/${card.id}`),
      api.get(`/api/v1/cards/${card.id}/children`),
      api.get(`/api/v1/cards/${card.id}/comments`),
    ]);
  } catch (e) { return null; }

  const status = readProp(defs, full, F.status);
  const metric = readProp(defs, full, F.metric);
  const plan = Number(readProp(defs, full, F.plan)) || 0;
  const fact = Number(readProp(defs, full, F.fact)) || 0;
  const factPct = plan ? Math.round((fact / plan) * 100) : 0;
  const statusCls = STATUS_CLASS[status] || '';

  const done = children.filter((c) => c.condition === 2 || c.state === 3).length;
  const total = children.length;

  const byBoard = {};
  for (const c of children) {
    const key = (c.board && c.board.title) || `Доска ${c.board_id}`;
    (byBoard[key] = byBoard[key] || []).push(c);
  }

  const estDef = (defs || []).find((p) => p.name === F.estimate);
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

  const metricHtml = metric ? `
    <div class="card">
      <div class="card-title">💰 Метрика · план / факт</div>
      <div class="metric">
        <div class="metric-label">${esc(metric)}</div>
        <div class="grow">${bar(factPct, statusCls)}</div>
        <div class="metric-num"><b>${fact}</b> из ${plan}</div>
      </div>
    </div>` : '';

  const blocks = `
    <div class="card">
      <div class="card-title">✅ Задачи по командам <span class="cnt">${done} / ${total}</span></div>
      ${Object.keys(byBoard).length === 0
        ? '<div class="muted">Задач пока нет. Заведите их на досках команд и укажите этот проект родителем.</div>'
        : Object.entries(byBoard).map(([board, list]) => `
          <div class="team">
            <div class="team-name">${esc(board)}<span class="team-badge">${
              list.filter((c) => c.condition === 2 || c.state === 3).length} / ${list.length}</span></div>
            ${list.map((c) => {
              const cdone = c.condition === 2 || c.state === 3;
              return `
              <div class="task ${cdone ? 'done' : ''}">
                <span class="tick">${cdone ? '✓' : ''}</span>
                <span class="t-title">${esc(c.title)}</span>
                ${c.due_date ? `<span class="due">${new Date(c.due_date).toLocaleDateString('ru')}</span>` : ''}
              </div>`; }).join('')}
          </div>`).join('')}
    </div>

    ${loadRows.length ? `
    <div class="card">
      <div class="card-title">👥 Загрузка команды (план) <span class="cnt">${totalPlan} ч</span></div>
      ${loadRows.map(([name, days]) => `
        <div class="load">
          ${avatar(name)}
          <span class="load-name">${esc(name)}</span>
          <span class="load-bar">${bar(maxLoad ? Math.round(days / maxLoad * 100) : 0)}</span>
          <span class="load-num">${days}</span>
        </div>`).join('')}
      <div class="load-foot">оценка задачи идёт на её исполнителей (поле «Оценка, ч»)</div>
    </div>` : ''}

    ${history.length ? `
    <div class="card">
      <div class="card-title">🕑 История статусов</div>
      ${history.map((c) => `
        <div class="hist">
          <span class="hist-date">${new Date(c.created).toLocaleDateString('ru')}</span>
          <span class="hist-text">${esc((c.text || '').replace(/[#*]/g, '').slice(0, 90))}</span>
        </div>`).join('')}
    </div>` : ''}`;

  return { status, metricHtml, blocks };
}

async function render() {
  const card = await iframe.getCard();

  const total = card.children_count || 0;
  const done = card.children_done || 0;
  const pct = total ? Math.round((done / total) * 100) : 0;

  const silent = daysAgo(card.comment_last_added_at || card.created);
  const stale = (silent != null && silent > 14) ? `🔇 без отчёта ${silent} дн · ` : '';
  const due = card.due_date ? `срок ${new Date(card.due_date).toLocaleDateString('ru')}` : 'срок не задан';

  // Базовый хиро: ведёт готовностью (статус пока недоступен без API).
  const baseTitle = total ? `${done} из ${total} задач сделано` : 'Проект';
  root.innerHTML =
    `<div id="hero">${heroHtml('ok', baseTitle, `${stale}${due}`, pct)}</div>` +
    `<div id="ext"><div class="muted" style="padding:4px 2px">Подгружаю задачи…</div></div>`;
  iframe.fitSize('#root');

  const ext = await extendedBlocks(card);
  if (ext) {
    // API доступен — повышаем хиро до статусного и показываем блоки
    if (ext.status) {
      const cls = STATUS_CLASS[ext.status] || 'ok';
      document.getElementById('hero').innerHTML = heroHtml(cls, ext.status, `${stale}${due}`, pct);
    }
    document.getElementById('ext').innerHTML = ext.metricHtml + ext.blocks;
  } else {
    // API недоступен — не пустуем: показываем готовность, кнопку авторизации и честно про остальное
    document.getElementById('ext').innerHTML = `
      <div class="card">
        <div class="card-title">✅ Задачи по командам <span class="cnt">${done} / ${total}</span></div>
        <div class="metric">
          <div class="metric-label">Готовность</div>
          <div class="grow">${bar(pct)}</div>
          <div class="metric-num"><b>${done}</b> из ${total}</div>
        </div>
        <div class="row" style="margin-top:12px"><button id="authbtn" class="primary" type="button">🔓 Показать полностью</button></div>
        <div id="authmsg" class="load-foot"></div>
      </div>`;
    const btn = document.getElementById('authbtn');
    if (btn) btn.addEventListener('click', async () => {
      const msg = document.getElementById('authmsg');
      msg.textContent = 'Жду подтверждения доступа в окне Kaiten…';
      try {
        const api = iframe.getApiClient();
        await api.authorize();
        msg.textContent = 'Доступ выдан, загружаю…';
        await render();
      } catch (e) {
        msg.textContent = 'Не удалось получить доступ: ' + ((e && e.message) || e);
      }
    });
  }
  iframe.fitSize('#root');
}

render().catch((e) => {
  root.innerHTML = `<div class="muted">Не удалось загрузить: ${esc(e && e.message)}</div>`;
  iframe.fitSize('#root');
});
