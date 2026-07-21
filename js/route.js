/* МАРШРУТ ФУНКЦЗОН — секция на карточке-задаче.
 *
 * Kaiten-автоматизации умеют двигать карточку только по колонкам своей доски,
 * НЕ на другую доску (проверено: move_on_board требует direction, не board_id).
 * Поэтому эстафету между досками команд ведёт этот аддон: клик по функцзоне →
 * PATCH board_id → задача переезжает на доску нужной команды.
 * Порядок — на карточке, в руках ведущего: он сам жмёт «передать дальше».
 */

const iframe = Addon.iframe();
const api = iframe.getApiClient();
const root = document.getElementById('root');

const FUNC_SPACE = 814151; // «3 · Работа команд» — доски-функцзоны

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* Разрешение спрашиваем ТОЛЬКО по клику: авто-authorize режет блокировщик попапов. */
async function ensureAuth() {
  try { await api.getAccessToken(); return; } catch (e) { /* токена ещё нет */ }
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
      catch (e) {
        document.getElementById('auth-msg').textContent =
          'Доступ не выдан: ' + ((e && e.message) || e);
      }
    });
  });
  root.innerHTML = '<div class="muted">Загружаю…</div>';
}

let card = null, boards = [];

async function render() {
  card = await iframe.getCard();
  boards = (await api.get(`/api/v1/spaces/${FUNC_SPACE}/boards`)) || [];
  boards.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  const current = boards.find((b) => b.id === card.board_id);

  root.innerHTML = `
    <div class="route-now">
      ${current
        ? `Сейчас у команды: <b>${esc(current.title)}</b>`
        : '<span class="muted">Задача пока не на доске команды. Выберите функцзону, куда передать.</span>'}
    </div>
    <div class="route-label">Передать функцзоне:</div>
    <div class="route-grid" id="grid">
      ${boards.map((b) => `
        <button type="button" class="route-btn${b.id === card.board_id ? ' current' : ''}"
                data-board="${b.id}" ${b.id === card.board_id ? 'disabled' : ''}>
          ${esc(b.title)}
        </button>`).join('')}
    </div>
    <div class="route-msg muted" id="msg"></div>
  `;

  document.getElementById('grid').addEventListener('click', onPick);
  iframe.fitSize('#root');
}

async function onPick(e) {
  const btn = e.target.closest('.route-btn');
  if (!btn || btn.disabled) return;
  const boardId = Number(btn.dataset.board);
  const target = boards.find((b) => b.id === boardId);
  const msg = document.getElementById('msg');

  [...document.querySelectorAll('.route-btn')].forEach((b) => (b.disabled = true));
  msg.textContent = `Передаю задачу команде «${target.title}»…`;

  try {
    // первая колонка-очередь целевой доски
    const cols = await api.get(`/api/v1/boards/${boardId}/columns`);
    const queue = (cols || []).find((c) => c.type === 1) || cols[0];
    const lanes = await api.get(`/api/v1/boards/${boardId}/lanes`);
    const lane = (lanes || [])[0];

    const body = { board_id: boardId, column_id: queue.id };
    if (lane) body.lane_id = lane.id;
    await api.patch(`/api/v1/cards/${card.id}`, body);

    iframe.showSnackbar(`Задача передана команде «${target.title}»`, 'success');
    await render();  // перерисуем — новая текущая доска
  } catch (err) {
    msg.textContent = 'Не удалось передать: ' + ((err && err.message) || err);
    [...document.querySelectorAll('.route-btn')].forEach((b) => (b.disabled = false));
  }
}

(async () => {
  try {
    await ensureAuth();
    await render();
  } catch (e) {
    root.innerHTML = `<div class="muted">Не удалось загрузить: ${esc(e && e.message)}</div>`;
    iframe.fitSize('#root');
  }
})();
