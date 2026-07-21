/* МАРШРУТ ФУНКЦЗОН — секция на карточке-задаче.
 *
 * Kaiten-автоматизации двигают карточку только по колонкам своей доски, НЕ на
 * другую доску. Поэтому эстафету между досками команд ведёт аддон: PATCH board_id.
 *
 * Маршрут (цепочка функцзон в нужном порядке) хранится НА КАРТОЧКЕ — в data-хранилище
 * аддона (setData/getData, scope=card, shared). Ведущий задаёт цепочку один раз,
 * дальше одна кнопка «передать дальше» гонит задачу по этапам. Порядок — на карточке.
 */

const iframe = Addon.iframe();
const api = iframe.getApiClient();
const root = document.getElementById('root');

const FUNC_SPACE = 814151;         // «3 · Работа команд» — доски-функцзоны
const ROUTE_KEY = 'route_boards';  // ключ хранилища маршрута на карточке

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function ensureAuth() {
  try { await api.getAccessToken(); return; } catch (e) { /* нет токена */ }
  await new Promise((resolve) => {
    root.innerHTML = `
      <div class="gate">
        <div class="gate-icon">🔐</div>
        <div class="gate-title">Нужно разовое разрешение</div>
        <p class="gate-text">Маршрут двигает задачу между досками команд от вашего
        имени — один раз подтвердите доступ, дальше без вопросов.</p>
        <button id="auth-btn" type="button" class="primary">Разрешить и показать</button>
        <div class="gate-msg" id="auth-msg"></div>
      </div>`;
    iframe.fitSize('#root');
    document.getElementById('auth-btn').addEventListener('click', async () => {
      document.getElementById('auth-msg').textContent = 'Жду подтверждения в окне Kaiten…';
      try { await api.authorize(); resolve(); }
      catch (e) { document.getElementById('auth-msg').textContent = 'Доступ не выдан: ' + ((e && e.message) || e); }
    });
  });
  root.innerHTML = '<div class="muted">Загружаю…</div>';
}

let card = null, boards = [], nameById = {};

async function loadRoute() {
  try {
    const d = await iframe.getData('card', 'shared', ROUTE_KEY);
    const arr = Array.isArray(d) ? d : (d && Array.isArray(d.value) ? d.value : null);
    return (arr || []).filter((id) => nameById[id]); // отбросим удалённые доски
  } catch (e) { return []; }
}
async function saveRoute(arr) {
  await iframe.setData('card', 'shared', ROUTE_KEY, arr);
}

async function moveTo(boardId) {
  const cols = await api.get(`/api/v1/boards/${boardId}/columns`);
  const queue = (cols || []).find((c) => c.type === 1) || cols[0];
  const lanes = await api.get(`/api/v1/boards/${boardId}/lanes`);
  const body = { board_id: boardId, column_id: queue.id };
  if (lanes && lanes[0]) body.lane_id = lanes[0].id;
  await api.patch(`/api/v1/cards/${card.id}`, body);
  card = await iframe.getCard();
}

/* ── ВИД: цепочка маршрута ── */
function renderChain(route) {
  const idx = route.indexOf(card.board_id);   // где задача сейчас в маршруте
  const steps = route.map((bid, i) => {
    const cls = i < idx ? 'done' : (i === idx ? 'now' : 'next');
    const mark = i < idx ? '✓' : (i === idx ? '●' : (i + 1));
    return `<span class="step ${cls}"><i>${mark}</i>${esc(nameById[bid])}</span>`;
  }).join('<span class="arrow">→</span>');

  let action = '';
  if (idx === -1) {
    action = `<button class="primary" data-go="${route[0]}">▶ Начать: ${esc(nameById[route[0]])}</button>`;
  } else if (idx < route.length - 1) {
    const nxt = route[idx + 1];
    action = `<button class="primary" data-go="${nxt}">✓ Передать: ${esc(nameById[nxt])}</button>`;
  } else {
    action = `<div class="route-fin">🏁 Последняя команда в маршруте</div>`;
  }

  root.innerHTML = `
    <div class="chain">${steps}</div>
    <div class="route-action" id="act">${action}</div>
    <div class="route-msg muted" id="msg"></div>
    <button class="linkbtn" id="edit">✎ изменить маршрут</button>
  `;
  const act = document.getElementById('act').querySelector('[data-go]');
  if (act) act.addEventListener('click', () => go(Number(act.dataset.go)));
  document.getElementById('edit').addEventListener('click', () => renderEditor(route));
  iframe.fitSize('#root');
}

async function go(boardId) {
  const msg = document.getElementById('msg');
  const btn = document.querySelector('#act .primary');
  if (btn) btn.disabled = true;
  msg.textContent = `Передаю команде «${nameById[boardId]}»…`;
  try {
    await moveTo(boardId);
    iframe.showSnackbar(`Задача у команды «${nameById[boardId]}»`, 'success');
    renderChain(await loadRoute());
  } catch (e) {
    msg.textContent = 'Не удалось: ' + ((e && e.message) || e);
    if (btn) btn.disabled = false;
  }
}

/* ── ВИД: редактор цепочки ── */
function renderEditor(route) {
  const draft = route.slice();
  const options = boards.filter((b) => draft.indexOf(b.id) === -1)
    .map((b) => `<option value="${b.id}">${esc(b.title)}</option>`).join('');

  root.innerHTML = `
    <div class="route-label">Цепочка функцзон (по порядку):</div>
    <div class="chain-edit" id="list">${chainEditRows(draft)}</div>
    <div class="route-add">
      <select id="pick"><option value="">+ добавить функцзону…</option>${options}</select>
    </div>
    <div class="actions">
      <button class="primary" id="save">Сохранить маршрут</button>
      ${route.length ? '<button class="linkbtn" id="cancel">отмена</button>' : ''}
    </div>
    <div class="route-msg muted" id="msg"></div>
  `;

  const relist = () => {
    document.getElementById('list').innerHTML = chainEditRows(draft);
    bindRows();
    document.getElementById('pick').innerHTML =
      `<option value="">+ добавить функцзону…</option>` +
      boards.filter((b) => draft.indexOf(b.id) === -1)
        .map((b) => `<option value="${b.id}">${esc(b.title)}</option>`).join('');
  };
  function bindRows() {
    [...document.querySelectorAll('.chain-edit .x')].forEach((el) =>
      el.addEventListener('click', () => { draft.splice(Number(el.dataset.i), 1); relist(); }));
  }
  bindRows();
  document.getElementById('pick').addEventListener('change', (e) => {
    const v = Number(e.target.value);
    if (v) { draft.push(v); relist(); }
  });
  document.getElementById('save').addEventListener('click', async () => {
    if (!draft.length) { document.getElementById('msg').textContent = 'Добавьте хотя бы одну функцзону'; return; }
    document.getElementById('save').disabled = true;
    await saveRoute(draft);
    iframe.showSnackbar('Маршрут сохранён', 'success');
    renderChain(draft);
  });
  const cancel = document.getElementById('cancel');
  if (cancel) cancel.addEventListener('click', () => renderChain(route));
  iframe.fitSize('#root');
}
function chainEditRows(draft) {
  if (!draft.length) return '<div class="muted">Пока пусто — добавьте функцзоны ниже.</div>';
  return draft.map((bid, i) =>
    `<span class="step now"><i>${i + 1}</i>${esc(nameById[bid])}<b class="x" data-i="${i}">✕</b></span>`
  ).join('<span class="arrow">→</span>');
}

(async () => {
  try {
    await ensureAuth();
    card = await iframe.getCard();
    boards = ((await api.get(`/api/v1/spaces/${FUNC_SPACE}/boards`)) || [])
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    boards.forEach((b) => (nameById[b.id] = b.title));
    const route = await loadRoute();
    if (route.length) renderChain(route); else renderEditor(route);
  } catch (e) {
    root.innerHTML = `<div class="muted">Не удалось загрузить: ${esc(e && e.message)}</div>`;
    iframe.fitSize('#root');
  }
})();
