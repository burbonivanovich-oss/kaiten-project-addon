/* ФОРМА «НОВАЯ ЦЕЛЬ»
 *
 * Создаёт карточку типа «Цель» (705577) в колонке «Активна» доски «Цели».
 * Поля: название, срок, ответственный, план, факт.
 */

const iframe = Addon.iframe();
const api = iframe.getApiClient();

const GOAL_BOARD_ID  = 1853658;
const GOAL_COL_AKTIV = 6407960;   // Активна
const GOAL_LANE_ID   = 2331823;   // Default Lane
const GOAL_TYPE_ID   = 705577;
const PROP_PLAN      = 615625;    // «План» (number)
const PROP_FACT      = 615624;    // «Факт» (number)

const msg = (t) => { document.getElementById('msg').textContent = t || ''; };

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
      <p class="gate-text">Форма создаёт цель от вашего имени.</p>
      <button id="auth-btn" type="button" class="primary">Разрешить доступ</button>
      <div class="gate-msg" id="auth-msg"></div>`;
    document.body.prepend(gate);
    iframe.fitSize('.gate');
    gate.querySelector('#auth-btn').addEventListener('click', async () => {
      gate.querySelector('#auth-msg').textContent = 'Жду подтверждения…';
      try { await api.authorize(); gate.remove(); resolve(); }
      catch (e) {
        gate.querySelector('#auth-msg').textContent = 'Доступ не выдан: ' + (e?.message || e);
      }
    });
  });
  form.style.display = '';
}

async function init() {
  await ensureAuth();

  // Список сотрудников
  const sel = document.getElementById('responsible');
  try {
    const users = await api.get('/api/v1/company/users?limit=300');
    (users || [])
      .filter(u => u.activated && !u.deactivated)
      .sort((a, b) => a.full_name.localeCompare(b.full_name, 'ru'))
      .forEach(u => {
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
    msg('Создаю…');

    const title  = document.getElementById('title').value.trim();
    const due    = document.getElementById('due').value;
    const respId = document.getElementById('responsible').value;
    const plan   = document.getElementById('plan').value;
    const fact   = document.getElementById('fact').value;

    try {
      const body = {
        board_id:  GOAL_BOARD_ID,
        column_id: GOAL_COL_AKTIV,
        lane_id:   GOAL_LANE_ID,
        title,
        type_id:   GOAL_TYPE_ID,
      };
      if (due)    body.due_date = `${due}T18:00:00.000Z`;
      if (respId) body.members  = [{ user_id: Number(respId), role_type: 'responsible' }];

      const props = {};
      if (plan !== '') props[`id_${PROP_PLAN}`] = Number(plan);
      if (fact !== '') props[`id_${PROP_FACT}`] = Number(fact);
      if (Object.keys(props).length) body.properties = props;

      const card = await api.post('/api/v1/cards', body);

      msg(`✅ Цель «${card.title}» создана.`);
      iframe.showSnackbar(`Цель «${card.title}» создана`, 'success');
      setTimeout(closeSelf, 1400);
    } catch (e) {
      msg('⚠️ Ошибка: ' + (e?.message || JSON.stringify(e)));
      btn.disabled = false;
    }
  });

  requestAnimationFrame(() => iframe.fitSize('#f'));
}

init().catch(e => msg('Не удалось открыть: ' + e?.message));
