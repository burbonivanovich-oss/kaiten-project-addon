/* ФОРМА «ЗАДАЧА КОМАНДЕ» — главный приём против «забытой связи».
 *
 * Задача создаётся СРАЗУ на доске нужной команды и в тот же момент вешается
 * дочерней к проекту, из которого открыли форму. Отсюда:
 *   • команда видит задачу у себя на доске,
 *   • проект видит её в «Дочерних карточках»,
 *   • % готовности проекта и «задачи по командам» в аддоне считаются сами.
 * Это и есть «дубляж» без второй карточки: она одна, но видна в двух местах.
 *
 * Ещё здесь живёт правило «задача не длиннее проекта»: срок ограничен сроком
 * проекта, при попытке выйти за него форма предупреждает.
 */

const iframe = Addon.iframe();
const api = iframe.getApiClient();

const F = { estimate: 'Оценка, ч' };
const TASK_TYPE = 'Задача';
// пространство «3 · Работа команд»: доски команд ищем в нём и в его подпространствах
const DEFAULT_FUNCTIONS_SPACE_ID = 825695;

const msg = (t) => { document.getElementById('msg').textContent = t || ''; };

function closeSelf() {
  try { iframe.closeDialog(); } catch (e) { try { iframe.closePopup(); } catch (e2) {} }
}

async function ensureAuth() {
  try { await api.getAccessToken(); return; } catch (e) { /* токена ещё нет */ }
  const form = document.getElementById('f');
  form.style.display = 'none';
  await new Promise((resolve) => {
    const gate = document.createElement('div');
    gate.className = 'gate';
    gate.innerHTML = `
      <div class="gate-icon">🔐</div>
      <div class="gate-title">Нужно разовое разрешение</div>
      <p class="gate-text">Форма создаёт карточку от вашего имени — Kaiten один раз
      спросит, доверяете ли вы аддону. Дальше без вопросов.</p>
      <button id="auth-btn" type="button" class="primary">Разрешить доступ</button>
      <div class="gate-msg" id="auth-msg"></div>`;
    document.body.prepend(gate);
    iframe.fitSize('.gate');
    gate.querySelector('#auth-btn').addEventListener('click', async () => {
      gate.querySelector('#auth-msg').textContent = 'Жду подтверждения в окне Kaiten…';
      try { await api.authorize(); gate.remove(); resolve(); }
      catch (e) {
        gate.querySelector('#auth-msg').textContent = 'Доступ не выдан: ' + ((e && e.message) || e);
      }
    });
  });
  form.style.display = '';
}

/* Доски команд = доски пространства функцзон + доски всех его подпространств.
   Группируем по пространству, чтобы в списке было видно, чья это доска.

   Доски всех пространств спрашиваем ОДНИМ заходом. Последовательный обход стоил
   по запросу на каждое подпространство, и форма ждала их все подряд — на живом
   аккаунте это давало около двадцати секунд до появления списка команд. */
async function loadTeamBoards(spaceId) {
  const spaces = await api.get('/api/v1/spaces');
  const root = (spaces || []).find((s) => s.id === spaceId);
  const targets = [];
  if (root) {
    targets.push(root);
    for (const s of spaces) {
      if (s.parent_entity_uid && root.uid && s.parent_entity_uid === root.uid) targets.push(s);
    }
  }
  const groups = await Promise.all(targets.map(async (s) => {
    try {
      const boards = await api.get(`/api/v1/spaces/${s.id}/boards`);
      return (boards && boards.length) ? { space: s.title, spaceId: s.id, boards } : null;
    } catch (e) { return null; /* пространство без доступа — пропускаем */ }
  }));
  return groups.filter(Boolean);
}

async function init() {
  await ensureAuth();
  const card = await iframe.getCard();

  const sel = document.getElementById('board');
  const respSel = document.getElementById('responsible');
  const dueInput = document.getElementById('due');

  /* Показываем форму ДО загрузки справочников.
   *
   * Раньше fitSize стоял в самом конце init, после всех запросов. До него
   * модалка не получала высоту, и пользователь двадцать секунд смотрел на
   * пустой серый прямоугольник — без единого слова о том, что идёт загрузка.
   * Теперь форма на экране сразу, а незаполненные списки честно говорят,
   * что они грузятся. */
  sel.innerHTML = '<option value="">— загружаю команды… —</option>';
  sel.disabled = true;
  iframe.fitSize('#f');

  // Настройки, срок проекта и доски команд не зависят друг от друга —
  // спрашиваем разом, а не по цепочке.
  const cfgSpacePromise = (async () => {
    try {
      const all = await iframe.getSettings();
      const s = (Array.isArray(all) ? all[0] : all) || {};
      if (s.functions_space_id) return Number(s.functions_space_id);
    } catch (e) { /* дефолт */ }
    return DEFAULT_FUNCTIONS_SPACE_ID;
  })();

  const duePromise = (async () => {
    try {
      const full = await api.get(`/api/v1/cards/${card.id}`);
      return full && full.due_date ? full.due_date : null;
    } catch (e) { return null; /* без потолка — просто не ограничиваем */ }
  })();

  const [projectDue, groups] = await Promise.all([
    duePromise,
    cfgSpacePromise.then(loadTeamBoards),
  ]);

  // срок проекта — потолок для задачи (правило «задача не длиннее проекта»)
  if (projectDue) {
    const d = new Date(projectDue);
    dueInput.max = d.toISOString().slice(0, 10);
    document.getElementById('due-hint').textContent =
      `— не позже ${d.toLocaleDateString('ru')} (срок проекта)`;
  }

  // board_id → space_id для подгрузки участников команды
  const boardToSpace = {};

  sel.disabled = false;
  if (!groups.length) {
    sel.innerHTML = '<option value="">— досок команд не найдено —</option>';
  } else {
    /* Первым пунктом — пустой.
     *
     * Без него браузер выбирал первую доску по алфавиту, и обязательное поле
     * оказывалось молча заполнено произвольной командой: невнимательный
     * машинист отправлял задачу не туда. Заодно это чинит подсказку о
     * загрузке и список «Кому» — они заполняются по событию change, которого
     * при предвыбранном значении не происходило вовсе. */
    sel.innerHTML = '<option value="">— выберите команду —</option>';
    for (const g of groups) {
      const og = document.createElement('optgroup');
      og.label = g.space;
      for (const b of g.boards) {
        const o = document.createElement('option');
        o.value = b.id;
        o.textContent = b.title;
        og.appendChild(o);
        boardToSpace[b.id] = g.spaceId;
      }
      sel.appendChild(og);
    }
  }
  iframe.fitSize('#f');

  // При смене команды — загружаем участников и считаем загрузку параллельно
  sel.addEventListener('change', async () => {
    const spId    = boardToSpace[sel.value];
    const boardId = sel.value;
    const loadEl  = document.getElementById('team-load');
    respSel.innerHTML   = '<option value="">— загружаю… —</option>';
    loadEl.textContent  = '';
    if (!spId) { respSel.innerHTML = '<option value="">— не назначен —</option>'; return; }
    try {
      const [members, boardCards] = await Promise.all([
        api.get(`/api/v1/spaces/${spId}/members`),
        api.get(`/api/v1/cards?board_id=${boardId}&limit=200`),
      ]);

      // Список исполнителей
      respSel.innerHTML = '<option value="">— не назначен —</option>';
      (members || [])
        .filter(u => u.activated !== false)
        .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || '', 'ru'))
        .forEach(u => {
          const o = document.createElement('option');
          o.value = u.id;
          o.textContent = u.full_name || u.username;
          respSel.appendChild(o);
        });

      // Загрузка команды. Раньше здесь суммировались часы ВСЕХ карточек доски —
      // включая готовые и архивные — и делились на «участники × 160». Норма
      // выдуманная, готовое не нагружает, а без оценок выходил уверенный 0%.
      // Показываем то, что видно на доске: сколько задач команда тащит сейчас.
      const live = (boardCards || []).filter(c => !c.archived && c.state !== 3);
      const wip  = live.filter(c => c.state === 2).length;
      const perPerson = (members || []).length ? wip / members.length : wip;

      if (perPerson >= 4) {
        loadEl.innerHTML = `<span style="color:#E24B4A">⚠️ У команды ${wip} задач в работе — очередь длинная</span>`;
      } else if (perPerson >= 2.5) {
        loadEl.innerHTML = `<span style="color:#EF9F27">⚡ ${wip} задач в работе, ${live.length} активных</span>`;
      } else if (live.length) {
        loadEl.innerHTML = `<span style="color:#1D9E75">✅ ${wip} задач в работе, ${live.length} активных</span>`;
      }
    } catch (e) {
      respSel.innerHTML = '<option value="">— не удалось загрузить —</option>';
    }
  });

  document.getElementById('f').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = document.getElementById('go');
    const boardId = sel.value;
    if (!boardId) { msg('⚠️ Выберите команду'); return; }

    const due = dueInput.value;
    if (due && projectDue && new Date(due) > new Date(projectDue)) {
      msg('⚠️ Срок задачи позже срока проекта — так нельзя. Поправьте дату.');
      return;
    }

    btn.disabled = true;
    msg('Создаю…');
    try {
      const types = await api.get('/api/v1/card-types');
      const taskType = (types || []).find((t) => t.name === TASK_TYPE);
      const cols = await api.get(`/api/v1/boards/${boardId}/columns`);
      const queue = (cols || []).find((c) => c.type === 1) || cols[0];

      const body = {
        board_id: Number(boardId),
        column_id: queue.id,
        title: document.getElementById('title').value.trim(),
        type_id: taskType ? taskType.id : undefined,
      };
      if (due) body.due_date = `${due}T18:00:00.000Z`;
      const respId = respSel.value;
      if (respId) body.members = [{ user_id: Number(respId), role_type: 'responsible' }];

      const est = document.getElementById('est').value;
      if (est) {
        const props = await api.get('/api/v1/company/custom-properties?limit=200');
        const estDef = (props || []).find((p) => p.name === F.estimate);
        if (estDef) body.properties = { [`id_${estDef.id}`]: Number(est) };
      }

      const created = await api.post('/api/v1/cards', body);
      // связь с проектом — сразу, чтобы её нельзя было забыть
      await api.post(`/api/v1/cards/${card.id}/children`, { card_id: created.id });

      msg(`✅ Задача #${created.id} создана и привязана к проекту.`);
      iframe.showSnackbar(`Задача «${created.title}» ушла команде`, 'success');
      setTimeout(closeSelf, 1200);
    } catch (e) {
      msg('⚠️ Не получилось: ' + (e && e.message ? e.message : e));
      btn.disabled = false;
    }
  });

  requestAnimationFrame(() => iframe.fitSize('#f'));
}

init().catch((e) => msg('Не удалось открыть: ' + (e && e.message)));
