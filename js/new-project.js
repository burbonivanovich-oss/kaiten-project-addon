/* ФОРМА «НОВЫЙ ПРОЕКТ» — одна отправка вместо ручного заведения.
 *
 * Создаёт карточку типа «Проект» на той же доске, где живёт карточка,
 * из которой открыли попап (колонка типа queue — «Идея»), проставляет
 * План и срок, привязывает к выбранной цели. Всё остальное — статус,
 * дата первого отчёта, паспорт — доделает автоматизация «🆕 Новый проект».
 *
 * Страница живёт в попапе, поэтому Addon.iframe(), а не Addon.initialize.
 * Поля и типы ищем ПО ИМЕНИ — id в каждой компании свои.
 */

const iframe = Addon.iframe();
const api = iframe.getApiClient();

const F = { plan: 'План' };
const GOAL_TYPE = 'Цель';
const PROJECT_TYPE = 'Проект';

const msg = (t) => { document.getElementById('msg').textContent = t || ''; };

/* Разрешение спрашиваем ТОЛЬКО по клику — авто-authorize режет блокировщик попапов. */
async function ensureAuth() {
  try { await api.getAccessToken(); return; } catch (e) { /* токена ещё нет */ }
  await new Promise((resolve) => {
    const gate = document.createElement('div');
    gate.innerHTML = `
      <p class="hint">Нужно разовое разрешение на доступ к Kaiten от вашего имени —
      без него форма не сможет создать карточку.</p>
      <p><button id="auth-btn" type="button">🔓 Разрешить</button></p>
      <p class="hint" id="auth-msg"></p>`;
    document.body.prepend(gate);
    iframe.fitSize && iframe.fitSize();
    gate.querySelector('#auth-btn').addEventListener('click', async () => {
      gate.querySelector('#auth-msg').textContent = 'Жду подтверждения в окне Kaiten…';
      try { await api.authorize(); gate.remove(); resolve(); }
      catch (e) {
        gate.querySelector('#auth-msg').textContent =
          'Доступ не выдан: ' + ((e && e.message) || e);
      }
    });
  });
}

async function init() {
  await ensureAuth();
  const card = await iframe.getCard();

  // кнопка «➕ Проект к этой цели» передаёт цель в query (?goal=id)
  const presetGoal = new URLSearchParams(location.search).get('goal');

  // цели для селекта: живые карточки типа «Цель» (их немного)
  const goalSel = document.getElementById('goal');
  try {
    const types = await api.get('/api/v1/card-types');
    const goalType = (types || []).find((t) => t.name === GOAL_TYPE);
    if (goalType) {
      const goals = await api.get(
        `/api/v1/cards?type_id=${goalType.id}&condition=1&archived=false&limit=100`);
      (goals || []).forEach((g) => {
        const o = document.createElement('option');
        o.value = g.id;
        o.textContent = g.title.length > 60 ? g.title.slice(0, 57) + '…' : g.title;
        goalSel.appendChild(o);
      });
    }
  } catch (e) { /* без целей форма всё равно работает */ }
  if (presetGoal) {
    goalSel.value = presetGoal;
    if (goalSel.value !== presetGoal) {  // цели нет в списке — добавим болванку
      const o = document.createElement('option');
      o.value = presetGoal;
      o.textContent = `Карточка #${presetGoal}`;
      goalSel.appendChild(o);
      goalSel.value = presetGoal;
    }
  }

  document.getElementById('f').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = document.getElementById('go');
    btn.disabled = true;
    msg('Создаю…');
    try {
      const types = await api.get('/api/v1/card-types');
      const projType = (types || []).find((t) => t.name === PROJECT_TYPE);
      // доска: из настроек аддона, если задана; иначе — откуда открыли форму.
      // С карточки Цели без настройки проект уехал бы на доску целей.
      let boardId = card.board_id;
      try {
        const all = await iframe.getSettings();
        const s = (Array.isArray(all) ? all[0] : all) || {};
        if (s.new_project_board_id) boardId = s.new_project_board_id;
      } catch (e) { /* настроек нет — ок */ }
      const cols = await api.get(`/api/v1/boards/${boardId}/columns`);
      const queue = (cols || []).find((c) => c.type === 1) || cols[0];
      const props = await api.get('/api/v1/company/custom-properties?limit=200');
      const planDef = (props || []).find((p) => p.name === F.plan);

      const body = {
        board_id: boardId,
        column_id: queue.id,
        title: document.getElementById('title').value.trim(),
        type_id: projType ? projType.id : undefined,
      };
      const due = document.getElementById('due').value;
      if (due) body.due_date = `${due}T18:00:00.000Z`;
      const plan = document.getElementById('plan').value;
      if (plan && planDef) body.properties = { [`id_${planDef.id}`]: Number(plan) };

      const created = await api.post('/api/v1/cards', body);

      const goalId = goalSel.value;
      if (goalId) await api.post(`/api/v1/cards/${goalId}/children`, { card_id: created.id });

      msg(`✅ Проект #${created.id} создан. Каркас доедет автоматикой.`);
      iframe.showSnackbar(`Проект «${created.title}» создан`, 'success');
      setTimeout(() => iframe.closePopup(), 1200);
    } catch (e) {
      msg('⚠️ Не получилось: ' + (e && e.message ? e.message : e));
      btn.disabled = false;
    }
  });

  iframe.fitSize('#f');
}

init().catch((e) => msg('Не удалось открыть: ' + (e && e.message)));
