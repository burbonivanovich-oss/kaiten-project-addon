/* СТРАНИЦА ПРОЕКТА — один экран, где видно здоровье проекта.
 *
 * Базовый слой (хиро-статус · готовность · метрика план/факт) берётся из САМОЙ
 * карточки через SDK-методы getCard() и getCardProperties() — они идут по
 * postMessage от имени родителя и OAuth НЕ требуют. Работает всегда.
 *
 * Расширенный слой (задачи по командам · загрузка · история) требует чтения
 * ДОЧЕРНИХ карточек и комментариев — это уже REST API от имени пользователя
 * (getApiClient/OAuth). Делаем его best-effort: получилось — показываем; не
 * получилось (напр. addon-OAuth аккаунта отдаёт токен, который API не
 * принимает) — не роняем экран, а честно помечаем блок.
 */

const iframe = Addon.iframe();
const root = document.getElementById('root');

const F = { status: 'Статус', metric: 'Что меряем', plan: 'План', fact: 'Факт', estimate: 'Оценка, чел-дн' };
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

/* Расширенный слой через REST API. Возвращает готовый HTML или null, если API
 * недоступен (нет токена / 401 / любая ошибка) — тогда экран живёт без него. */
async function extendedBlocks(card) {
  let api;
  try { api = iframe.getApiClient(); } catch (e) { return null; }
  // молча пробуем взять токен; нет — уходим в деградацию без гейта
  try { await api.getAccessToken(); } catch (e) { return null; }

  let defs, children, comments;
  try {
    [defs, children, comments] = await Promise.all([
      api.get('/api/v1/company/custom-properties?limit=200'),
      api.get(`/api/v1/cards/${card.id}/children`),
      api.get(`/api/v1/cards/${card.id}/comments`),
    ]);
  } catch (e) { return null; }

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

  return `
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
      <div class="card-title">👥 Загрузка команды (план) <span class="cnt">${totalPlan} чел-дн</span></div>
      ${loadRows.map(([name, days]) => `
        <div class="load">
          ${avatar(name)}
          <span class="load-name">${esc(name)}</span>
          <span class="load-bar">${bar(maxLoad ? Math.round(days / maxLoad * 100) : 0)}</span>
          <span class="load-num">${days}</span>
        </div>`).join('')}
      <div class="load-foot">оценка задачи идёт на её исполнителей (поле «Оценка, чел-дн»)</div>
    </div>` : ''}

    ${history.length ? `
    <div class="card">
      <div class="card-title">🕑 История статусов</div>
      ${history.map((c) => `
        <div class="hist">
          <span class="hist-date">${new Date(c.created).toLocaleDateString('ru')}</span>
          <span class="hist-text">${esc((c.text || '').replace(/[#*]/g, '').slice(0, 90))}</span>
        </div>`).join('')}
    </div>` : ''}
  `;
}

async function render() {
  // Базовый слой — без OAuth.
  // getCard() в секции отдаёт карточку БЕЗ .properties, поэтому статус/метрику/
  // план/факт коннектор (где свойства доступны) передаёт нам параметрами в URL.
  // Если их нет — пробуем всё же прочитать из getCard()/getCardProperties().
  const card = await iframe.getCard();
  const q = new URLSearchParams(location.search);
  let defs = [];
  let defsErr = null;
  if (!q.has('st') && !q.has('mt')) {
    try { defs = await iframe.getCardProperties(); } catch (e) { defsErr = (e && e.message) || String(e); }
  }
  // диагностика в родителя (ловим слушателем на странице Kaiten)
  try {
    window.parent.postMessage({ type: 'ADDON_DEBUG', step: 'section-dbg', extra: {
      hasCardProps: !!card.properties,
      cardPropKeys: Object.keys(card.properties || {}).slice(0, 8),
      defsLen: (defs || []).length, defsErr,
      cardKeys: Object.keys(card || {}).slice(0, 20),
    } }, '*');
  } catch (e) {}
  const fromQ = (k, fb) => (q.has(k) ? q.get(k) : fb);

  const status = fromQ('st', null) || readProp(defs, card, F.status);
  const metric = fromQ('mt', null) || readProp(defs, card, F.metric);
  const plan = Number(fromQ('pl', null) != null ? fromQ('pl', null) : readProp(defs, card, F.plan)) || 0;
  const fact = Number(fromQ('fc', null) != null ? fromQ('fc', null) : readProp(defs, card, F.fact)) || 0;

  const total = card.children_count || 0;
  const done = card.children_done || 0;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const factPct = plan ? Math.round((fact / plan) * 100) : 0;

  const silent = q.has('sd') ? Number(q.get('sd')) : daysAgo(card.comment_last_added_at || card.created);
  const statusCls = STATUS_CLASS[status] || '';
  const heroCls = statusCls || 'ok';
  const stale = (silent != null && silent > 14) ? `🔇 без отчёта ${silent} дн · ` : '';
  const due = card.due_date ? `срок ${new Date(card.due_date).toLocaleDateString('ru')}` : 'срок не задан';

  const heroHtml = `
    <div class="hero ${heroCls}">
      <span class="hero-dot"></span>
      <div class="hero-main">
        <div class="hero-status">${esc(status || 'статус не задан')}</div>
        <div class="hero-sub">${stale}${due}</div>
      </div>
      <div class="hero-pct"><b>${pct}%</b><span>готово</span></div>
    </div>

    ${metric ? `
    <div class="card">
      <div class="card-title">💰 Метрика · план / факт</div>
      <div class="metric">
        <div class="metric-label">${esc(metric)}</div>
        <div class="grow">${bar(factPct, statusCls)}</div>
        <div class="metric-num"><b>${fact}</b> из ${plan}</div>
      </div>
    </div>` : ''}`;

  // сразу рисуем базовый слой + место под расширенный
  root.innerHTML = heroHtml + '<div id="ext"><div class="muted" style="padding:4px 2px">Подгружаю задачи…</div></div>';
  iframe.fitSize('#root');

  const ext = await extendedBlocks(card);
  const extEl = document.getElementById('ext');
  if (ext != null) {
    extEl.innerHTML = ext;
  } else {
    // API недоступен — не пустуем, показываем что есть, и честно про остальное
    extEl.innerHTML = `
      <div class="card">
        <div class="card-title">✅ Задачи по командам <span class="cnt">${done} / ${total}</span></div>
        <div class="metric">
          <div class="metric-label">Готовность</div>
          <div class="grow">${bar(pct, statusCls)}</div>
          <div class="metric-num"><b>${done}</b> из ${total}</div>
        </div>
        <div class="load-foot">Разбивка по командам, загрузка и история статусов появятся,
        когда у аддона заработает доступ к API (сейчас Kaiten отдаёт токен, который API не принимает).</div>
      </div>`;
  }
  iframe.fitSize('#root');
}

render().catch((e) => {
  root.innerHTML = `<div class="muted">Не удалось загрузить: ${esc(e && e.message)}</div>`;
  iframe.fitSize('#root');
});
