/* ФОРМА «НОВЫЙ ПРОЕКТ»
 *
 * Создаёт: пространство (дочернее к портфелю) → 2 доски → карточку-проект
 * в «Обзор проектов». Поля формы: название, срок, ответственный.
 */

const iframe = Addon.iframe();
const api = iframe.getApiClient();

const OVERVIEW_BOARD = 1853650;
const OVERVIEW_COL   = 6407923;
const OVERVIEW_LANE  = 2331815;
const PORTFOLIO_UID  = '788760c7-b29e-450b-bb4a-3f2d067c2f04';
const PROJECT_TYPE   = 705580;

// Кнопка «Новый проект» на карточке цели зовёт эту страницу с ?goal=<id>
// (client.js, pageUrl). Без чтения параметра проект создавался несвязанным,
// хотя пользователь нажимал действие с явной семантикой «проект к этой цели».
const GOAL_ID = (() => {
  const raw = new URLSearchParams(location.search).get('goal');
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
})();

const msg = (t) => { document.getElementById('msg').textContent = t || ''; };

// Привязка проекта к цели. Возвращает true только если связь реально видна
// в API — успешный POST без проверки уже однажды дал ложное «готово».
async function linkToGoal(goalId, cardId) {
  await api.post(`/api/v1/cards/${goalId}/children`, { card_id: cardId });
  const children = await api.get(`/api/v1/cards/${goalId}/children`);
  return (children || []).some((c) => c.id === cardId);
}

// Проект создан, связь — нет. Повторять создание нельзя: получится дубль.
// Поэтому прячем форму и предлагаем ровно один недостающий шаг.
function offerRelinkOnly(card, err) {
  const form = document.getElementById('f');
  form.style.display = 'none';

  const box = document.createElement('div');
  box.className = 'gate';
  box.innerHTML = `
    <div class="gate-icon">⚠️</div>
    <div class="gate-title">Проект создан, связь с целью — нет</div>
    <p class="gate-text">Карточка «${card.title}» уже в портфеле, создавать её заново не нужно.
    Не удалось только привязать её к цели: ${(err && err.message) || err}</p>
    <button id="relink-btn" type="button" class="primary">Повторить привязку</button>
    <div class="gate-msg" id="relink-msg"></div>`;
  document.body.prepend(box);
  iframe.fitSize('.gate');

  const out = box.querySelector('#relink-msg');
  box.querySelector('#relink-btn').addEventListener('click', async (ev) => {
    ev.target.disabled = true;
    out.textContent = 'Привязываю…';
    try {
      if (!await linkToGoal(GOAL_ID, card.id)) throw new Error('связь не подтвердилась');
      out.textContent = '✅ Привязано.';
      iframe.showSnackbar(`Проект «${card.title}» привязан к цели`, 'success');
      setTimeout(closeSelf, 1200);
    } catch (e) {
      out.textContent = 'Снова не вышло: ' + ((e && e.message) || e);
      ev.target.disabled = false;
    }
  });
}

function closeSelf() {
  try { iframe.closeDialog(); } catch (e) { try { iframe.closePopup(); } catch (_) {} }
}

async function ensureAuth() {
  try { await api.getAccessToken(); return; } catch (e) {}
  const form = document.getElementById('f');
  form.style.display = 'none';
  await new Promise((resolve) => {
    const gate = document.createElement('div');
    gate.className = 'gate';
    gate.innerHTML = `
      <div class="gate-icon">🔐</div>
      <div class="gate-title">Нужно разовое разрешение</div>
      <p class="gate-text">Форма создаёт проект от вашего имени — Kaiten
      один раз спросит, доверяете ли вы аддону. Дальше без вопросов.</p>
      <button id="auth-btn" type="button" class="primary">Разрешить доступ</button>
      <div class="gate-msg" id="auth-msg"></div>`;
    document.body.prepend(gate);
    iframe.fitSize('.gate');
    gate.querySelector('#auth-btn').addEventListener('click', async () => {
      gate.querySelector('#auth-msg').textContent = 'Жду подтверждения в окне Kaiten…';
      try { await api.authorize(); gate.remove(); resolve(); }
      catch (e) {
        gate.querySelector('#auth-msg').textContent =
          'Доступ не выдан: ' + ((e && e.message) || e);
      }
    });
  });
  form.style.display = '';
}

// Переименовываем колонки доски задач под нужную структуру
async function setupTasksBoard(boardId) {
  const COLUMNS = [
    { title: 'Бэклог'      },
    { title: 'В работе',    wip_limit: 3 },
    { title: 'На проверке', wip_limit: 5 },
    { title: 'Готово'      },
  ];
  const existing = await api.get(`/api/v1/boards/${boardId}/columns`);
  for (let i = 0; i < COLUMNS.length; i++) {
    const col = COLUMNS[i];
    const body = col.wip_limit ? { title: col.title, wip_limit: col.wip_limit } : { title: col.title };
    if (i < existing.length) {
      try {
        await api.patch(`/api/v1/boards/${boardId}/columns/${existing[i].id}`, body);
      } catch (_) {
        await api.put(`/api/v1/boards/${boardId}/columns/${existing[i].id}`, body);
      }
    } else {
      await api.post(`/api/v1/boards/${boardId}/columns`, body);
    }
  }
}

async function init() {
  await ensureAuth();

  // Заполняем список сотрудников
  const sel = document.getElementById('responsible');
  try {
    const users = await api.get('/api/v1/company/users?limit=300');
    (users || [])
      .filter((u) => u.activated && !u.deactivated)
      .sort((a, b) => a.full_name.localeCompare(b.full_name, 'ru'))
      .forEach((u) => {
        const o = document.createElement('option');
        o.value = u.id;
        o.textContent = u.full_name;
        sel.appendChild(o);
      });
  } catch (_) {}

  document.getElementById('f').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = document.getElementById('go');
    btn.disabled = true;

    const title  = document.getElementById('title').value.trim();
    const due    = document.getElementById('due').value;
    const respId = document.getElementById('responsible').value;

    try {
      msg('Создаю пространство…');
      const space = await api.post('/api/v1/spaces', {
        title,
        parent_entity_uid: PORTFOLIO_UID,
      });

      msg('Создаю доски…');
      await api.post(`/api/v1/spaces/${space.id}/boards`, { title: 'Ключевое о проекте' });
      const tasksBoard = await api.post(`/api/v1/spaces/${space.id}/boards`, { title: 'Задачи проекта' });
      await setupTasksBoard(tasksBoard.id);

      msg('Добавляю в портфель…');
      const cardBody = {
        board_id:  OVERVIEW_BOARD,
        column_id: OVERVIEW_COL,
        lane_id:   OVERVIEW_LANE,
        title,
        type_id:   PROJECT_TYPE,
      };
      if (due)    cardBody.due_date = `${due}T18:00:00.000Z`;
      if (respId) cardBody.members = [{ user_id: Number(respId), role_type: 'responsible' }];
      const card = await api.post('/api/v1/cards', cardBody);

      // Связь с целью — отдельный шаг. Если он упадёт, проект уже создан,
      // поэтому повторять надо только привязку, а не всю форму.
      if (GOAL_ID) {
        msg('Привязываю к цели…');
        try {
          const linked = await linkToGoal(GOAL_ID, card.id);
          if (!linked) throw new Error('связь не подтвердилась');
        } catch (le) {
          offerRelinkOnly(card, le);
          return;
        }
      }

      const suffix = GOAL_ID ? ' и привязан к цели' : '';
      msg(`✅ Проект «${card.title}» создан${suffix}.`);
      iframe.showSnackbar(`Проект «${card.title}» создан${suffix}`, 'success');
      setTimeout(closeSelf, 1400);
    } catch (e) {
      msg('⚠️ Ошибка: ' + (e && e.message ? e.message : JSON.stringify(e)));
      btn.disabled = false;
    }
  });

  requestAnimationFrame(() => iframe.fitSize('#f'));
}

init().catch((e) => msg('Не удалось открыть: ' + (e && e.message)));
