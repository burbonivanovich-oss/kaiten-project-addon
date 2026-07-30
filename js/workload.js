/* Дашборд загруженности команды — живые данные из Kaiten API */

const iframe = Addon.iframe();
const api = iframe.getApiClient();

const KAITEN         = 'https://artempdirect1.kaiten.ru';
const OVERVIEW_BOARD = 1843681;
const OVERVIEW_SPACE = 820245;
const MONTHLY_NORM   = 160;

// Доски команд для влётных задач
const TEAM_BOARDS = {
  1841937: 'ПМ',
  1841454: 'Копирайт',
  1841467: 'Редактор',
  1841941: 'Техпис',
  1841936: 'Дизайн',
  1841938: 'Интернет-маркетинг',
  1841939: 'SEO',
  1841940: 'Платное продвижение',
};
const PROP_EST = 615627; // «Оценка, чел-дн»

const STATUS_DOT = {
  'Бэклог':       'dot-backlog',
  'В работе':     'dot-wip',
  'На проверке':  'dot-review',
  'Готово':       'dot-done',
};

async function ensureAuth() {
  try { await api.getAccessToken(); return; } catch (e) {}
  document.querySelector('.shell').innerHTML = `
    <div class="gate">
      <div class="gate-icon">🔐</div>
      <div class="gate-title">Нужно разовое разрешение</div>
      <p class="gate-text">Дашборд читает задачи от вашего имени — Kaiten один раз
      спросит, доверяете ли вы аддону.</p>
      <button class="btn-primary" id="auth-btn">Разрешить доступ</button>
      <div class="gate-msg" id="auth-msg"></div>
    </div>`;
  await new Promise((resolve) => {
    document.getElementById('auth-btn').addEventListener('click', async () => {
      document.getElementById('auth-msg').textContent = 'Жду подтверждения в окне Kaiten…';
      try { await api.authorize(); resolve(); location.reload(); }
      catch (e) {
        document.getElementById('auth-msg').textContent = 'Доступ не выдан: ' + (e?.message || e);
      }
    });
  });
}

async function fetchTasks() {
  const tasks = [];

  function addCard(c, projName, projCardId) {
    const col   = typeof c.column === 'object' ? (c.column?.title ?? '') : '';
    const hours = c.estimate_workload || Number((c.properties || {})[`id_${PROP_EST}`]) || 0;
    const members    = c.members || [];
    const responsible = members.filter(m => m.type === 1);
    const assignees  = responsible.length ? responsible : members;
    if (assignees.length) {
      for (const m of assignees) {
        tasks.push({ title: c.title, project: projName, project_card_id: projCardId,
          hours, person: m.full_name || '—', person_id: m.user_id, status: col });
      }
    } else {
      tasks.push({ title: c.title, project: projName, project_card_id: projCardId,
        hours, person: '—', person_id: null, status: col });
    }
  }

  // 1. Задачи привязанные к проектам (дети каждой проектной карточки)
  const projCards = await api.get(`/api/v1/cards?board_id=${OVERVIEW_BOARD}&limit=100`);
  for (const proj of (projCards || []).filter(c => !c.archived && c.type_id === 699509)) {
    const children = await api.get(`/api/v1/cards/${proj.id}/children?limit=200`);
    for (const c of children || []) addCard(c, proj.title, proj.id);
  }

  // 2. Влётные задачи на досках команд (без parent_id)
  for (const [boardId, teamName] of Object.entries(TEAM_BOARDS)) {
    const cards = await api.get(`/api/v1/cards?board_id=${boardId}&limit=200`);
    for (const c of (cards || []).filter(c => !c.parent_id)) {
      addCard(c, `Влётная · ${teamName}`, null);
    }
  }

  return tasks;
}

function aggregate(tasks, groupKey) {
  const map = new Map();
  for (const t of tasks) {
    const key = t[groupKey];
    if (!map.has(key)) map.set(key, { name: key, hours: 0, tasks: [], card_id: t.project_card_id });
    const entry = map.get(key);
    entry.hours += t.hours;
    entry.tasks.push(t);
    if (t.project_card_id && !entry.card_id) entry.card_id = t.project_card_id;
  }
  return [...map.values()].sort((a, b) => b.hours - a.hours);
}

function dotClass(status) {
  return STATUS_DOT[status] || 'dot-backlog';
}

function normColor(pct) {
  if (pct >= 100) return '#ef4444';
  if (pct >= 80)  return '#f59e0b';
  return 'var(--bar-fill)';
}

function renderPeople(groups) {
  return groups.map(g => {
    const normPct  = Math.min(Math.round((g.hours / MONTHLY_NORM) * 100), 100);
    const overload = g.hours > MONTHLY_NORM;
    const color    = normColor(Math.round((g.hours / MONTHLY_NORM) * 100));
    const normLabel = g.name === '—'
      ? `<span class="norm-label muted">${g.hours} ч</span>`
      : `<span class="norm-label" style="color:${color}">${Math.round((g.hours/MONTHLY_NORM)*100)}% нормы</span>`;

    const taskRows = g.tasks.sort((a, b) => b.hours - a.hours).map(t => `
      <div class="task-item">
        <span class="dot ${dotClass(t.status)}"></span>
        <span class="task-title" title="${esc(t.title)}">${esc(t.title)}</span>
        <span class="task-proj link" onclick="goToProject(${t.project_card_id})">${esc(t.project)}</span>
        <span class="task-hours">${t.hours > 0 ? t.hours + ' ч' : '—'}</span>
      </div>`).join('');

    return `
      <div class="row-card">
        <div class="row-head" onclick="toggle(this)">
          <div class="row-name">${esc(g.name)}</div>
          <div class="bar-wrap"><div class="bar-fill" style="width:${normPct}%;background:${color}"></div></div>
          <div class="row-meta">${normLabel} · <strong>${g.hours}</strong> ч · ${g.tasks.length} зад.</div>
        </div>
        <div class="task-list">${taskRows || '<div class="empty">Нет задач с оценкой</div>'}</div>
      </div>`;
  }).join('');
}

function renderProjects(groups) {
  const maxH = Math.max(...groups.map(g => g.hours), 1);
  return groups.map(g => {
    const barPct = Math.round((g.hours / maxH) * 100);
    const taskRows = g.tasks.sort((a, b) => b.hours - a.hours).map(t => `
      <div class="task-item">
        <span class="dot ${dotClass(t.status)}"></span>
        <span class="task-title" title="${esc(t.title)}">${esc(t.title)}</span>
        <span class="task-proj">${esc(t.person)}</span>
        <span class="task-hours">${t.hours > 0 ? t.hours + ' ч' : '—'}</span>
      </div>`).join('');

    const nameHtml = g.card_id
      ? `<div class="row-name link" onclick="goToProject(${g.card_id})">${esc(g.name)} ↗</div>`
      : `<div class="row-name">${esc(g.name)}</div>`;

    return `
      <div class="row-card">
        <div class="row-head" onclick="toggle(this)">
          ${nameHtml}
          <div class="bar-wrap"><div class="bar-fill" style="width:${barPct}%"></div></div>
          <div class="row-meta"><strong>${g.hours}</strong> ч · ${g.tasks.length} зад.</div>
        </div>
        <div class="task-list">${taskRows || '<div class="empty">Нет задач с оценкой</div>'}</div>
      </div>`;
  }).join('');
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

window.toggle = function(head) {
  head.nextElementSibling.classList.toggle('open');
};

window.goToProject = function(cardId) {
  if (!cardId) return;
  window.open(`${KAITEN}/space/${OVERVIEW_SPACE}/${OVERVIEW_BOARD}/card/${cardId}`, '_blank');
};

async function init() {
  await ensureAuth();

  const tasks = await fetchTasks();
  const byPerson  = aggregate(tasks, 'person');
  const byProject = aggregate(tasks, 'project');

  const totalH = tasks.reduce((s, t) => s + t.hours, 0);
  const people  = new Set(tasks.map(t => t.person).filter(p => p !== '—')).size;

  document.getElementById('totals').innerHTML = `
    <div class="stat"><div class="stat-val">${totalH}</div><div class="stat-lbl">часов оценки</div></div>
    <div class="stat"><div class="stat-val">${tasks.length}</div><div class="stat-lbl">задач всего</div></div>
    <div class="stat"><div class="stat-val">${people}</div><div class="stat-lbl">сотрудников</div></div>
    <div class="stat"><div class="stat-val">${byProject.length}</div><div class="stat-lbl">проектов</div></div>`;

  document.getElementById('panel-people').innerHTML   = renderPeople(byPerson);
  document.getElementById('panel-projects').innerHTML = renderProjects(byProject);

  const now = new Date().toLocaleString('ru', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
  document.getElementById('updated').textContent = `обновлено ${now}`;

  // Tabs
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('panel-' + btn.dataset.tab).classList.add('active');
    });
  });

  iframe.fitSize('.shell');
}

init().catch(e => {
  document.getElementById('panel-people').innerHTML =
    `<div class="empty">⚠️ Не удалось загрузить: ${e?.message || e}</div>`;
});
