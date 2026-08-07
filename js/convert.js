/* ОФОРМИТЬ ИДЕЮ — секция на карточке-гипотезе.
 *
 * Банк идей («💡 Гипотезы») — источник, из которого гипотеза превращается
 * в проект (уезжает в портфель) или в задачу. Конвертация = смена типа карточки
 * (+ переезд в портфель для проекта) через PATCH. Никаких копий-дублей —
 * та же карточка живёт дальше уже как проект/задача, с сохранённым описанием.
 */

const iframe = Addon.iframe();
const api = iframe.getApiClient();
const root = document.getElementById('root');

// Типы ищем ПО ИМЕНИ (как в new-task.js): id в каждой компании свои.
const PROJECT_TYPE = 'Проект';
const TASK_TYPE = 'Задача';
// Доска портфеля этой инсталляции; перебивается настройкой new_project_board_id.
const DEFAULT_PORTFOLIO_BOARD = 1853650; // «Обзор проектов» в «2 · Портфель проектов»

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function ensureAuth() {
  try { await api.getAccessToken(); return; } catch (e) { /* нет токена */ }
  await new Promise((resolve) => {
    root.innerHTML = `
      <div class="gate">
        <div class="gate-icon">🔐</div>
        <div class="gate-title">Нужно разовое разрешение</div>
        <p class="gate-text">Оформление идеи меняет карточку от вашего имени —
        один раз подтвердите доступ, дальше без вопросов.</p>
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

let card = null;

// Доска портфеля: настройка пространства важнее дефолта.
async function portfolioBoard() {
  try {
    const all = await iframe.getSettings();
    const s = (Array.isArray(all) ? all[0] : all) || {};
    if (s.new_project_board_id) return Number(s.new_project_board_id);
  } catch (e) { /* дефолт */ }
  return DEFAULT_PORTFOLIO_BOARD;
}

// Тип по имени. Не нашли — падаем внятно, а не молча меняем карточку не туда.
async function typeId(name) {
  const types = await api.get('/api/v1/card-types');
  const t = (types || []).find((x) => x.name === name);
  if (!t) throw new Error(`тип «${name}» в этой компании не найден`);
  return t.id;
}

/* Ссылка на карточку собирается на лету: хост и пространство зависят от компании,
   зашивать их нельзя. Хост берём из referrer (Kaiten грузит нас в iframe, браузер
   отдаёт его origin), пространство — у доски. Не вышло — текст без ссылки. */
async function cardLink(boardId, text) {
  let origin = null;
  try { if (document.referrer) origin = new URL(document.referrer).origin; } catch (e) { /* нет */ }
  if (origin) {
    try {
      const board = await api.get(`/api/v1/boards/${boardId}`);
      if (board && board.space_id) {
        return `<a href="${origin}/space/${board.space_id}/boards/card/${card.id}"
          target="_blank">${esc(text)}</a>`;
      }
    } catch (e) { /* без ссылки */ }
  }
  return esc(text);
}

function render() {
  root.innerHTML = `
    <p class="convert-lead">Идея прошла проверку? Оформите её — карточка станет
    проектом или задачей, описание сохранится.</p>
    <div class="convert-btns">
      <button class="primary" id="to-project">🚀 Оформить проектом</button>
      <button class="primary ghost" id="to-task">📋 Оформить задачей</button>
    </div>
    <div class="route-msg muted" id="msg"></div>
  `;
  document.getElementById('to-project').addEventListener('click', () => convert('project'));
  document.getElementById('to-task').addEventListener('click', () => convert('task'));
  iframe.fitSize('#root');
}

async function convert(kind) {
  const msg = document.getElementById('msg');
  [...document.querySelectorAll('.convert-btns .primary')].forEach((b) => (b.disabled = true));
  msg.textContent = kind === 'project' ? 'Оформляю проектом…' : 'Оформляю задачей…';
  try {
    if (kind === 'project') {
      // тип Проект + переезд в портфель (колонка «Идея»); автоматика доделает каркас
      const boardId = await portfolioBoard();
      const cols = await api.get(`/api/v1/boards/${boardId}/columns`);
      const idea = (cols || []).find((c) => c.type === 1) || cols[0];
      const lanes = await api.get(`/api/v1/boards/${boardId}/lanes`);
      const body = { type_id: await typeId(PROJECT_TYPE), board_id: boardId, column_id: idea.id };
      if (lanes && lanes[0]) body.lane_id = lanes[0].id;
      await api.patch(`/api/v1/cards/${card.id}`, body);
      iframe.showSnackbar('Идея оформлена проектом — она в портфеле «2 · Портфель проектов»', 'success');
      root.innerHTML = `<div class="convert-done">✅ Готово! Идея теперь
        ${await cardLink(boardId, 'проект в портфеле')}.
        Привяжите к цели и дозаполните поля.</div>`;
    } else {
      // тип Задача — карточка остаётся, дальше её маршрутизируют по функцзонам
      await api.patch(`/api/v1/cards/${card.id}`, { type_id: await typeId(TASK_TYPE) });
      iframe.showSnackbar('Идея оформлена задачей', 'success');
      root.innerHTML = `<div class="convert-done">✅ Готово! Идея теперь задача.
        Привяжите её к проекту и задайте маршрут функцзон.</div>`;
    }
    iframe.fitSize('#root');
  } catch (e) {
    msg.textContent = 'Не удалось: ' + ((e && e.message) || e);
    [...document.querySelectorAll('.convert-btns .primary')].forEach((b) => (b.disabled = false));
  }
}

(async () => {
  try {
    await ensureAuth();
    card = await iframe.getCard();
    render();
  } catch (e) {
    root.innerHTML = `<div class="muted">Не удалось загрузить: ${esc(e && e.message)}</div>`;
    iframe.fitSize('#root');
  }
})();
