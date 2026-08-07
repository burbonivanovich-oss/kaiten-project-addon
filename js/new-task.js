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
   Группируем по пространству, чтобы в списке было видно, чья это доска. */
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
  const groups = [];
  for (const s of targets) {
    try {
      const boards = await api.get(`/api/v1/spaces/${s.id}/boards`);
      if (boards && boards.length) groups.push({ space: s.title, spaceId: s.id, boards });
    } catch (e) { /* пространство без доступа — пропускаем */ }
  }
  return groups;
}

async function init() {
  await ensureAuth();
  const card = await iframe.getCard();

  // срок проекта — потолок для задачи (правило «задача не длиннее проекта»)
  let projectDue = null;
  try {
    const full = await api.get(`/api/v1/cards/${card.id}`);
    projectDue = full && full.due_date ? full.due_date : null;
  } catch (e) { /* без потолка — просто не ограничиваем */ }

  const dueInput = document.getElementById('due');
  if (projectDue) {
    const d = new Date(projectDue);
    const iso = d.toISOString().slice(0, 10);
    dueInput.max = iso;
    document.getElementById('due-hint').textContent =
      `— не позже ${d.toLocaleDateString('ru')} (срок проекта)`;
  }

  // список команд
  let cfgSpace = DEFAULT_FUNCTIONS_SPACE_ID;
  try {
    const all = await iframe.getSettings();
    const s = (Array.isArray(all) ? all[0] : all) || {};
    if (s.functions_space_id) cfgSpace = Number(s.functions_space_id);
  } catch (e) { /* дефолт */ }

  const sel = document.getElementById('board');
  const respSel = document.getElementById('responsible');
  const groups = await loadTeamBoards(cfgSpace);

  // board_id → space_id для подгрузки участников команды
  const boardToSpace = {};

  if (!groups.length) {
    sel.innerHTML = '<option value="">— досок команд не найдено —</option>';
  } else {
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

      // Загрузка команды
      const totalH = (boardCards || []).reduce((s, c) =>
        s + (c.estimate_workload || Number((c.properties || {})['id_615627']) || 0), 0);
      const norm = (members || []).length * 160 || 160;
      const pct  = Math.round((totalH / norm) * 100);
      if (pct >= 100) {
        loadEl.innerHTML = `<span style="color:#E24B4A">⚠️ Команда перегружена: ${pct}% нормы (${totalH} ч)</span>`;
      } else if (pct >= 80) {
        loadEl.innerHTML = `<span style="color:#EF9F27">⚡ Загружена на ${pct}% нормы (${totalH} ч)</span>`;
      } else if (totalH > 0) {
        loadEl.innerHTML = `<span style="color:#1D9E75">✅ ${pct}% нормы (${totalH} ч)</span>`;
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
