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

/* Насколько идея вообще сформулирована.
 *
 * Раньше секция сразу предлагала оформить гипотезу проектом — не спрашивая,
 * есть ли у неё ожидаемый эффект и способ проверки. Так в портфель уезжает
 * заголовок без критерия успеха, и дальше его уже никто не допишет.
 * Не блокируем (запреты обходят), но показываем, чего не хватает.
 */
const H = { effect: 'Ожидаемый эффект', check: 'Как проверим',
            impact: 'Влияние', cost: 'Стоимость проверки' };

function readProp(defs, c, name) {
  const d = (defs || []).find((p) => p.name === name);
  if (!d) return null;
  const raw = (c.properties || {})[`id_${d.id}`];
  if (raw == null) return null;
  if (Array.isArray(raw)) {
    const v = (d.values || []).find((x) => x.id === raw[0] || x.uid === raw[0]);
    return v ? (v.value || v.display_value) : null;
  }
  return raw;
}

// Высокое влияние при дешёвой проверке — то, что берут первым.
// Дорогая проверка низкого влияния — то, что не берут никогда.
function priorityHint(impact, cost) {
  if (!impact || !cost) return '';
  const hi = /Высокое/.test(impact), cheap = /Дёшево/.test(cost), dear = /Дорого/.test(cost);
  if (hi && cheap) return { cls: 'ok',   text: 'Высокое влияние и дешёвая проверка — такие берут первыми.' };
  if (hi && dear)  return { cls: 'warn', text: 'Влияние высокое, но проверка дорогая — подумайте, как проверить дешевле.' };
  if (!hi && dear) return { cls: 'bad',  text: 'Дорогая проверка при невысоком влиянии — стоит ли вообще?' };
  return { cls: 'ok', text: '' };
}

function render(defs, full) {
  const vals = {
    effect: readProp(defs, full, H.effect),
    check:  readProp(defs, full, H.check),
    impact: readProp(defs, full, H.impact),
    cost:   readProp(defs, full, H.cost),
  };
  const rows = [
    ['effect', 'Ожидаемый эффект',   'что изменится и на сколько'],
    ['check',  'Как проверим',       'эксперимент или метрика'],
    ['impact', 'Влияние',            'насколько это важно'],
    ['cost',   'Стоимость проверки', 'во что обойдётся проверить'],
  ];
  const filled = rows.filter(([k]) => vals[k]).length;

  const checklist = rows.map(([k, label, hintText]) => `
    <div class="task">
      <span class="tick">${vals[k] ? '✓' : ''}</span>
      <span class="t-title">${esc(label)}${vals[k]
        ? `: <b>${esc(vals[k])}</b>`
        : ` <span class="muted">— ${esc(hintText)}</span>`}</span>
    </div>`).join('');

  const hint = priorityHint(vals.impact, vals.cost);
  const hintHtml = hint && hint.text
    ? `<div class="card ${hint.cls === 'ok' ? '' : 'warn-box'}"><div class="muted">${esc(hint.text)}</div></div>`
    : '';

  // Проектом оформляем только то, что описано: у проекта должен быть критерий.
  const notReady = !vals.effect || !vals.check;
  const warn = notReady ? `
    <div class="card warn-box">
      <div class="muted">Не хватает ${!vals.effect ? '«ожидаемого эффекта»' : ''}${
        !vals.effect && !vals.check ? ' и ' : ''}${!vals.check ? '«как проверим»' : ''}.
      Без этого проект уедет в портфель без критерия успеха — и там останется.</div>
    </div>` : '';

  root.innerHTML = `
    <div class="card">
      <div class="card-title">💡 Идея <span class="cnt">${filled} из 4 заполнено</span></div>
      ${checklist}
    </div>
    ${hintHtml}
    ${warn}
    <p class="convert-lead">Идея прошла проверку? Оформите её — карточка станет
    проектом или задачей, описание и поля сохранятся.</p>
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
    // getCard() в секции не отдаёт .properties — значения полей читаем через API.
    const [defs, full] = await Promise.all([
      api.get('/api/v1/company/custom-properties?limit=200'),
      api.get(`/api/v1/cards/${card.id}`),
    ]);
    render(defs, full);
  } catch (e) {
    root.innerHTML = `<div class="muted">Не удалось загрузить: ${esc(e && e.message)}</div>`;
    iframe.fitSize('#root');
  }
})();
