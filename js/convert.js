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

const bar = (pct, cls) =>
  `<div class="bar"><div class="bar-fill ${cls || ''}" style="width:${Math.min(pct, 100)}%"></div></div>`;

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
            impact: 'Влияние', impactVote: 'Влияние — голос команды',
            cost: 'Стоимость проверки', direction: 'Направление',
            score: 'Приоритет' };

/* ПРИОРИТЕТ ЧИСЛОМ — 1…9.
 *
 * Пара «влияние × стоимость проверки» читается человеком, но не сортируется
 * машиной: доску нельзя выстроить по важности, а значит при двух десятках
 * идей порядок приходится держать в голове. Число это чинит — Kaiten умеет
 * сортировать колонку по числовому полю.
 *
 * Формула намеренно примитивная: влияние × дешевизна проверки. Это ICE,
 * ужатый до двух осей, и никакой точности тут не изображается — важен
 * порядок, а не абсолютное значение. 9 = высокое влияние, дешёвая проверка.
 */
const IMPACT_WEIGHT = { hi: 3, mid: 2, lo: 1 };

function costWeight(cost) {
  if (!cost) return null;
  if (/Дёшево/.test(cost)) return 3;
  if (/Средне/.test(cost)) return 2;
  if (/Дорого/.test(cost)) return 1;
  return null;
}

function priorityScore(impact, cost) {
  const i = impact && IMPACT_WEIGHT[impact.level];
  const c = costWeight(cost);
  return i && c ? i * c : null;
}

// Словами — чтобы число не пришлось расшифровывать каждый раз.
function scoreVerdict(score) {
  if (score >= 9) return { cls: 'ok',   text: 'верхняя полка банка — берут первыми' };
  if (score >= 6) return { cls: 'ok',   text: 'хорошая ставка' };
  if (score >= 3) return { cls: 'warn', text: 'средняя полка — подождёт' };
  return { cls: 'bad', text: 'нижняя полка — дорого проверять при слабом эффекте' };
}

/* Значения select-полей приходится догружать отдельно.
 *
 * GET /company/custom-properties отдаёт определения БЕЗ ключа values — ни один
 * параметр (with_values, include, expand) этого не меняет, проверено. Поэтому
 * любое чтение select через def.values молча возвращало null: статус проекта
 * не читался, влияние и стоимость гипотезы считались незаполненными, а форма
 * отчёта не находила id значения и не сохраняла статус вообще.
 *
 * Грузим только те поля, которые реально нужны экрану, и параллельно.
 */
async function loadSelectValues(api, defs, names) {
  const need = (defs || []).filter((d) =>
    names.indexOf(d.name) !== -1 &&
    (d.type === 'select' || d.type === 'multi_select') && !d.values);
  await Promise.all(need.map(async (d) => {
    try { d.values = await api.get(`/api/v1/company/custom-properties/${d.id}/select-values`); }
    catch (e) { d.values = []; }
  }));
  return defs;
}

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

const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  return b === 1 ? one : many;
};

/* Влияние читается двумя способами — и это не временный костыль, а условие
 * безопасного перехода.
 *
 * Исторически «Влияние» — select, который заполняет один человек: тот, кто
 * завёл карточку. Несогласие команды при этом нигде не живёт. Если в компании
 * заведено поле-голосование «Влияние — голос команды», берём его.
 *
 * Голоса лежат НЕ в card.properties: каждый голос — отдельная запись со своим
 * author_id, и достать их можно только отдельным запросом. Именно поэтому
 * чтение через readProp() для такого поля всегда вернёт null — ровно та
 * ошибка, что уже была со значениями select, когда чек-лист считал
 * заполненные поля пустыми.
 *
 * Средний балл переводим в те же три уровня, чтобы подсказка приоритета
 * работала одинаково в обоих случаях. Порядок «сначала голосование, потом
 * старый select» позволяет не удалять старое поле в день перехода: экран
 * читается и до, и после, и в промежутке, когда живут оба.
 */
async function readImpact(api, defs, c) {
  const voteDef = (defs || []).find((p) => p.name === H.impactVote);
  if (voteDef) {
    try {
      const votes = (await api.get(
        `/api/v1/cards/${c.id}/custom-properties/${voteDef.id}/collective-vote-values`)) || [];
      const nums = votes.map((v) => Number(v.number_vote)).filter((n) => !Number.isNaN(n));
      if (nums.length) {
        const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
        // Потолок шкалы лежит в разных ключах: у варианта «рейтинг» это
        // data.count (сколько звёзд), у «шкалы» — data.max. Сверено с живым
        // полем: {type: collective_vote, vote_variant: rating, data:{count:5}}.
        const d = voteDef.data || {};
        const max = Number(d.count) || Number(d.max) || 10;
        return {
          text: `${avg.toFixed(1).replace('.', ',')} из ${max} · ${nums.length} ` +
                plural(nums.length, 'голос', 'голоса', 'голосов'),
          // Пороги уровней — доли шкалы, а не абсолютные баллы: иначе смена
          // размерности (5 → 10) молча переехала бы смысл «высокого влияния».
          level: avg >= max * 0.8 ? 'hi' : avg >= max * 0.5 ? 'mid' : 'lo',
          spread: Math.max(...nums) - Math.min(...nums),
          max,
        };
      }
      return null;   // поле заведено, но никто не голосовал — считаем незаполненным
    } catch (e) { /* не прочиталось — читаем старый select */ }
  }
  const sel = readProp(defs, c, H.impact);
  if (!sel) return null;
  return { text: sel, level: /Высокое/.test(sel) ? 'hi' : /Низкое/.test(sel) ? 'lo' : 'mid', spread: 0 };
}

// Высокое влияние при дешёвой проверке — то, что берут первым.
// Дорогая проверка низкого влияния — то, что не берут никогда.
function priorityHint(impact, cost) {
  if (!impact || !cost) return '';
  const hi = impact.level === 'hi', cheap = /Дёшево/.test(cost), dear = /Дорого/.test(cost);
  if (hi && cheap) return { cls: 'ok',   text: 'Высокое влияние и дешёвая проверка — такие берут первыми.' };
  if (hi && dear)  return { cls: 'warn', text: 'Влияние высокое, но проверка дорогая — подумайте, как проверить дешевле.' };
  if (!hi && dear) return { cls: 'bad',  text: 'Дорогая проверка при невысоком влиянии — стоит ли вообще?' };
  return { cls: 'ok', text: '' };
}

/* Разброс голосов важнее среднего.
 *
 * Если половина команды поставила максимум, а половина минимум, среднее выйдет
 * ровно посередине и будет выглядеть как согласованное «среднее влияние». Это
 * худший из возможных выводов: спорную идею нельзя ни брать молча, ни молча
 * отбрасывать — про неё надо поговорить.
 *
 * Порог — ДОЛЯ шкалы, а не число баллов. На пятибалльной разброс в 3 балла это
 * почти полярные мнения, на десятибалльной — обычное несовпадение оттенков.
 * Зашитое число молча меняло бы чувствительность при смене размерности.
 *
 * Половина шкалы: на пяти баллах срабатывает от 3 (5 против 2 — спор), на
 * десяти от 5. Доля поменьше сделала бы блок болтливым: на пятибалльной
 * порог упал бы до 2, а «4 и 2» — это ещё не разногласие. */
const SPREAD_SHARE = 0.5;

function spreadHint(impact) {
  if (!impact || !impact.spread) return '';
  if (impact.spread < (impact.max || 10) * SPREAD_SHARE) return '';
  return `<div class="card warn-box"><div class="muted">Голоса разошлись сильно
    (разброс ${impact.spread} ${plural(impact.spread, 'балл', 'балла', 'баллов')}
    из ${impact.max}). Среднее тут мало что значит — стоит обсудить, почему
    видят по-разному.</div></div>`;
}

function render(defs, full, impact) {
  // impact уже прочитан (он может требовать отдельного запроса за голосами) —
  // в таблицу кладём только его текст.
  const vals = {
    effect: readProp(defs, full, H.effect),
    check:  readProp(defs, full, H.check),
    impact: impact ? impact.text : null,
    cost:   readProp(defs, full, H.cost),
    direction: readProp(defs, full, H.direction),
  };
  const voting = !!(defs || []).find((p) => p.name === H.impactVote);
  /* Направление — пятый пункт, и это не формальность.
   *
   * Без него идея живёт в вакууме: её нельзя ни сопоставить со стратегией, ни
   * увидеть в разрезе направлений на дашборде. Идея, не двигающая ни одного
   * направления, — сама по себе повод для разговора, а не строка в списке. */
  const rows = [
    ['effect',    'Ожидаемый эффект',   'что изменится и на сколько'],
    ['check',     'Как проверим',       'эксперимент или метрика'],
    ['impact',    'Влияние',            voting ? 'команда ещё не голосовала' : 'насколько это важно'],
    ['cost',      'Стоимость проверки', 'во что обойдётся проверить'],
    ['direction', 'Направление',        'какое направление это двигает'],
  ];
  const filled = rows.filter(([k]) => vals[k]).length;
  const total = rows.length;

  const checklist = rows.map(([k, label, hintText]) => `
    <div class="task ${vals[k] ? 'done' : ''}">
      <span class="tick">${vals[k] ? '✓' : ''}</span>
      <span class="t-title">${esc(label)}${vals[k]
        ? `: <b>${esc(vals[k])}</b>`
        : ` <span class="muted">— ${esc(hintText)}</span>`}</span>
    </div>`).join('');

  const hint = priorityHint(impact, vals.cost);
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

  // Приоритет числом — над чек-листом: это то, ради чего его заполняют.
  const score = priorityScore(impact, vals.cost);
  const sv = score != null ? scoreVerdict(score) : null;
  const scoreHtml = score != null ? `
    <div class="card">
      <div class="card-title">⚖️ Приоритет <span class="cnt">${score} из 9</span></div>
      <div class="metric">
        <div class="grow">${bar(Math.round(score / 9 * 100), sv.cls === 'ok' ? 'ok' : sv.cls)}</div>
      </div>
      <div class="load-foot">${esc(sv.text)} · влияние × дешевизна проверки, по этому полю
      сортируется доска</div>
    </div>` : `
    <div class="card">
      <div class="card-title">⚖️ Приоритет <span class="cnt">не посчитан</span></div>
      <div class="load-foot">Нужны влияние и стоимость проверки — без них идею не с чем
      сравнить, и она не встанет в очередь.</div>
    </div>`;

  root.innerHTML = `
    <div class="card">
      <div class="card-title">💡 Идея <span class="cnt">${filled} из ${total} заполнено</span></div>
      ${checklist}
    </div>
    ${scoreHtml}
    ${hintHtml}
    ${spreadHint(impact)}
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

/* Приоритет записывается в поле карточки, а не только рисуется.
 *
 * Нарисованное число живёт внутри секции и доске недоступно: сортировать по
 * нему нельзя, в фильтр не положить, в отчёт не вытащить. Поэтому считаем при
 * открытии идеи и кладём в числовое поле — дальше это обычные данные Kaiten.
 *
 * Пишем только при расхождении: лишний PATCH на каждое открытие карточки
 * засоряет историю изменений и делает «обновлено» бессмысленным.
 */
async function syncScore(api, defs, full, impact) {
  const def = (defs || []).find((p) => p.name === H.score);
  if (!def) return;                       // поле не заведено — молча выходим
  const score = priorityScore(impact, readProp(defs, full, H.cost));
  if (score == null) return;              // нечего считать
  const current = Number((full.properties || {})[`id_${def.id}`]);
  if (current === score) return;          // уже актуально
  try {
    await api.patch(`/api/v1/cards/${full.id}`, { properties: { [`id_${def.id}`]: score } });
  } catch (e) { /* не записалось — экран уже показал число, это не критично */ }
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
    // При уже выданном токене ensureAuth выходит молча — без этой строки
    // секция стояла пустой всё время загрузки полей и голосов.
    root.innerHTML = '<div class="muted">Читаю поля идеи…</div>';
    iframe.fitSize('#root');
    card = await iframe.getCard();
    // getCard() в секции не отдаёт .properties — значения полей читаем через API.
    const [defs, full] = await Promise.all([
      api.get('/api/v1/company/custom-properties?limit=200'),
      api.get(`/api/v1/cards/${card.id}`),
    ]);
    await loadSelectValues(api, defs, [H.impact, H.cost]);
    // Голоса — отдельный запрос, но только если поле-голосование заведено:
    // на старой схеме readImpact лишних обращений не делает.
    const impact = await readImpact(api, defs, full);
    render(defs, full, impact);
    await syncScore(api, defs, full, impact);
  } catch (e) {
    root.innerHTML = `<div class="muted">Не удалось загрузить: ${esc(e && e.message)}</div>`;
    iframe.fitSize('#root');
  }
})();
