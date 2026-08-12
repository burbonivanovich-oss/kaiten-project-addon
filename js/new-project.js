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

/* Раскладка досок в пространстве.
 *
 * У доски есть координаты top/left, и новая доска по умолчанию получает
 * left = 0 — то есть встаёт ПОД предыдущей, а не рядом. Пространство
 * открывалось «лесенкой», и вторая доска уезжала за первый экран.
 *
 * Ширина считается по колонкам: одноколоночная доска занимает 304 (сверено с
 * живыми пространствами, где раскладка правильная), значит N колонок — N×304.
 * Считаем, а не пишем магическое число: изменится состав колонок — сдвиг
 * поедет сам.
 */
const COLUMN_WIDTH = 304;

/* Путь для PATCH доски — ЧЕРЕЗ ПРОСТРАНСТВО.
 * /api/v1/boards/{id} отвечает 405 Method Not Allowed: этот адрес только для
 * чтения. Первый заход именно на нём и провалился — молча, потому что вызов
 * стоял в try/catch, и проект создавался с досками друг под другом. */
async function placeBoardsInRow(spaceId, first, second, firstColumns) {
  const move = (board, left) =>
    api.patch(`/api/v1/spaces/${spaceId}/boards/${board.id}`, { top: 0, left });
  try {
    await Promise.all([
      move(first, 0),
      move(second, COLUMN_WIDTH * firstColumns),
    ]);
    return true;
  } catch (e) {
    // Раскладка — не повод рушить создание проекта, но и молчать нельзя:
    // криво разложенные доски и есть та ловушка, ради которой всё это писалось.
    return false;
  }
}

/* Справочная доска — только чтение.
 *
 * Ставим ОГРАНИЧЕНИЕ Kaiten: на инфо-доске нельзя создавать карточки. Это
 * страховка от главной ловушки пространства проекта — нативный диалог
 * «Создать карточку» подставляет расположение сам, и задача уезжала в справку
 * молча. Теперь вместо тихой ошибки человек видит текст, который объясняет,
 * куда класть задачу.
 *
 * Ограничение живёт НА ПРОСТРАНСТВЕ, то есть новому проекту нужно своё. Руками
 * это делать нельзя — забудут на второй раз; поэтому его ставит форма, здесь.
 * Форма запроса снята с ограничения, собранного в интерфейсе: type on_action,
 * внутри restrictions[0] с type creation и путём до доски.
 *
 * Падение не критично: доски уже созданы, проект рабочий, ограничение можно
 * добавить позже руками.
 */
async function lockInfoBoard(spaceId, boardId) {
  // created обязателен И на самом правиле, И внутри data — без него API отвечает
  // 400 «should have required property 'created'». В интерфейсе поле проставляется
  // само, поэтому в скопированном из UI теле его не было видно, и первый заход
  // молча падал: проект создавался без защиты справочной доски.
  const created = new Date().toISOString();
  try {
    await api.post(`/api/v1/spaces/${spaceId}/restrictions`, {
      name: 'Справочная доска — только чтение',
      error_text: 'Это справка о проекте. Задачи создавайте на доске «Задачи проекта».',
      type: 'on_action',
      status: 'active',
      conditions: [],
      restrictions: [{
        type: 'creation',
        operator: 'eq',
        created,
        data: { path: { spaceId, boardId }, created },
      }],
    });
    return true;
  } catch (e) {
    return false;
  }
}

/* Включение аддона в новом пространстве.
 *
 * Kaiten не наследует дополнения в дочерние пространства: новый проект
 * создавался вообще без аддона, то есть без страницы проекта, без кнопки
 * «Задача команде» и без бейджей. Раньше это чинили руками через
 * 🌐 → Дополнения → ВКЛЮЧИТЬ, но на каждый новый проект так ходить нельзя.
 *
 * В документации значилось, что API этого не умеет (POST на /spaces/{id}/addons
 * отвечает 405). Это верно только для POST: включает PATCH на конкретный аддон —
 * /api/v1/spaces/{spaceId}/addons/{addonId}. Проверено на живом аккаунте
 * 12.08.2026, подтверждено в интерфейсе («Включенные дополнения (1)»).
 *
 * Свой addonId не хардкодим: берём список аддонов компании и находим тот, чей
 * URL коннектора совпадает с index.html рядом с этой страницей. При переезде на
 * другой хостинг совпадение поедет вместе с адресом само.
 */
const CONNECTOR_URL = location.origin + location.pathname.replace(/[^/]*$/, 'index.html');

/* Доступ команды к новому пространству.
 *
 * Без явной роли Kaiten даёт всем reader: люди видят проект, но не могут
 * создать в нём ни карточку, ни доску. Для рабочего пространства это мёртвый
 * доступ — задачу поставить нельзя.
 *
 * Роль ищем по имени, а не по uid: uid системных ролей совпадает между
 * аккаунтами Kaiten, но полагаться на это при переносе в другую компанию
 * не стоит. writer = читать, создавать, менять, двигать, удалять карточки
 * и доски; удалить само пространство и трогать вебхуки он не может.
 */
async function writerRoleId() {
  try {
    const roles = await api.get('/api/v1/tree-entity-roles');
    const w = (roles || []).find((r) => r && r.name === 'writer');
    return w ? (w.id || w.uid) : null;
  } catch (e) {
    return null;
  }
}

async function enableAddonInSpace(spaceId) {
  try {
    const addons = await api.get('/api/v1/company/addons');
    const mine = (addons || []).find(
      (a) => a && !a.archived && a.iframe_initial_url === CONNECTOR_URL);
    if (!mine) return false;
    await api.patch(`/api/v1/spaces/${spaceId}/addons/${mine.id}`, { archived: false });
    // Успешный PATCH без проверки уже однажды дал ложное «готово» — сверяем.
    const check = await api.get(`/api/v1/spaces/${spaceId}/addons`);
    return (check || []).some((a) => a && a.id === mine.id);
  } catch (e) {
    return false;
  }
}

// Состав рабочей доски. Вынесен наверх: по числу колонок считается сдвиг
// справочной доски, чтобы она встала вплотную справа.
const TASK_COLUMNS = [
  { title: 'Бэклог'      },
  { title: 'В работе',    wip_limit: 3 },
  { title: 'На проверке', wip_limit: 5 },
  { title: 'Готово'      },
];

// Переименовываем колонки доски задач под нужную структуру
async function setupTasksBoard(boardId) {
  const COLUMNS = TASK_COLUMNS;
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
  // Форма — до загрузки списка сотрудников: иначе окно стоит пустым, пока
  // не ответит /company/users.
  iframe.fitSize('#f');

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

    // Без срока система не может ничего сказать про темп — только процент.
    // Браузерная валидация required это уже ловит; проверяем и здесь, потому
    // что submit можно вызвать и не через кнопку.
    if (!due) {
      msg('⚠️ Поставьте срок — без него проект не с чем сравнивать.');
      btn.disabled = false;
      return;
    }

    try {
      msg('Создаю пространство…');
      const spaceBody = { title, parent_entity_uid: PORTFOLIO_UID };
      const writer = await writerRoleId();
      if (writer) spaceBody.for_everyone_access_role_id = writer;
      const space = await api.post('/api/v1/spaces', spaceBody);

      /* Порядок создания важен: РАБОЧАЯ доска первая.
       *
       * Нативный диалог «Создать карточку» подставляет в «Расположение» первую
       * доску пространства — первую по координатам, а не по времени создания.
       * Пока слева стояло «Ключевое о проекте», задача молча уезжала в справку:
       * поле уже заполнено, и его не читают.
       *
       * Поэтому «Задачи проекта» ставим в левый край, а справочную доску —
       * справа от неё. Обе на месте, обе в одну линию, но по умолчанию
       * карточка падает туда, где работают. */
      msg('Создаю доски…');
      const tasksBoard = await api.post(`/api/v1/spaces/${space.id}/boards`, { title: 'Задачи проекта' });
      await setupTasksBoard(tasksBoard.id);
      const infoBoard = await api.post(`/api/v1/spaces/${space.id}/boards`, { title: 'Ключевое о проекте' });
      const placed = await placeBoardsInRow(space.id, tasksBoard, infoBoard, TASK_COLUMNS.length);
      const locked = await lockInfoBoard(space.id, infoBoard.id);
      const addonOn = await enableAddonInSpace(space.id);

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

      // Раскладка и защита справочной доски не критичны для создания проекта,
      // но если они не встали — человек должен об этом знать, иначе задачи
      // начнут уезжать в справку, а он будет думать, что всё настроено.
      const broken = [];
      if (!placed) broken.push('доски встали друг под другом — поправьте перетаскиванием');
      if (!locked) broken.push('на «Ключевое о проекте» не встал запрет создавать карточки');
      if (!addonOn) broken.push('дополнение не включилось — включите вручную: 🌐 → Дополнения');
      if (!writer) broken.push('команде выдан доступ «только чтение» — поменяйте на «Редактор» в доступах пространства');

      if (broken.length) {
        msg(`✅ Проект «${card.title}» создан${suffix}, но: ${broken.join('; ')}.`);
        iframe.showSnackbar(`Проект создан, но настроен не полностью`, 'warning');
        return;   // не закрываем окно: предупреждение надо прочитать
      }

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
