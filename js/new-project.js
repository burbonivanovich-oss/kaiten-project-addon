/* ФОРМА «НОВЫЙ ПРОЕКТ» — одна отправка вместо ручного заведения.
 *
 * Создаёт карточку типа «Проект» на той же доске, где живёт карточка,
 * из которой открыли попап (колонка типа queue — «Идея»), проставляет
 * План и срок, привязывает к выбранной цели. Всё остальное — статус,
 * дата первого отчёта, паспорт — доделает автоматизация «🆕 Новый проект».
 *
 * Поля и типы ищем ПО ИМЕНИ — id в каждой компании свои.
 */

const F = { plan: 'План' };
const GOAL_TYPE = 'Цель';
const PROJECT_TYPE = 'Проект';

Addon.initialize({
  popup: async (ctx) => {
    const api = await ctx.getApiClient();
    const card = await ctx.getCard();

    // цели для селекта: все карточки типа «Цель» в аккаунте (их немного)
    const goalSel = document.getElementById('goal');
    try {
      const types = await api.get('/api/v1/card-types');
      const goalType = (types || []).find((t) => t.name === GOAL_TYPE);
      if (goalType) {
        const goals = await api.get(`/api/v1/cards?type_id=${goalType.id}&limit=100`);
        (goals || []).forEach((g) => {
          const o = document.createElement('option');
          o.value = g.id;
          o.textContent = g.title.length > 60 ? g.title.slice(0, 57) + '…' : g.title;
          goalSel.appendChild(o);
        });
      }
    } catch (e) { /* без целей форма всё равно работает */ }

    document.getElementById('f').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const msg = document.getElementById('msg');
      const btn = document.getElementById('go');
      btn.disabled = true;
      msg.textContent = 'Создаю…';
      try {
        const types = await api.get('/api/v1/card-types');
        const projType = (types || []).find((t) => t.name === PROJECT_TYPE);
        const cols = await api.get(`/api/v1/boards/${card.board_id}/columns`);
        const queue = (cols || []).find((c) => c.type === 1) || cols[0];
        const props = await api.get('/api/v1/company/custom-properties');
        const planDef = (props || []).find((p) => p.name === F.plan);

        const body = {
          board_id: card.board_id,
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

        msg.textContent = `✅ Проект #${created.id} создан. Каркас доедет автоматикой.`;
        ctx.showSnackbar(`Проект «${created.title}» создан`, 'success');
        setTimeout(() => ctx.closePopup(), 1200);
      } catch (e) {
        msg.textContent = '⚠️ Не получилось: ' + (e && e.message ? e.message : e);
        btn.disabled = false;
      }
    });

    ctx.iframe.fitSize && ctx.iframe.fitSize();
  },
});
