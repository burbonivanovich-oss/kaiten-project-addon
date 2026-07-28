/* Дашборд загруженности команды — живые данные из Kaiten API */

const iframe = Addon.iframe();
const api = iframe.getApiClient();

// Доски задач по проектам (id → название проекта)
const TASK_BOARDS = {
  1843480: 'Больше оплат',
  1843621: 'Рост выручки Общепита',
  1843623: 'Рост CR2',
  1843625: 'Квиз на сайте',
};

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
  for (const [boardId, project] of Object.entries(TASK_BOARDS)) {
    const cards = await api.get(`/api/v1/cards?board_id=${boardId}&limit=200`);
    for (const c of cards || []) {
      const members = c.members || [];
      const col = typeof c.column === 'object' ? c.column?.title ?? '' : '';
      const responsible = members.filter(m => m.type === 1);
      const assignees = responsible.length ? responsible : members;
      if (assignees.length) {
        for (const m of assignees) {
          tasks.push({
            title: c.title,
            project,
            hours: c.estimate_workload || 0,
            person: m.full_name || '—',
            person_id: m.user_id,
            status: col,
          });
        }
      } else {
        tasks.push({ title: c.title, project, hours: c.estimate_workload || 0, person: '—', person_id: null, status: col });
      }
    }
  }
  return tasks;
}

function aggregate(tasks, groupKey) {
  const map = new Map();
  for (const t of tasks) {
    const key = t[groupKey];
    if (!map.has(key)) map.set(key, { name: key, hours: 0, tasks: [] });
    const entry = map.get(key);
    entry.hours += t.hours;
    entry.tasks.push(t);
  }
  return [...map.values()].sort((a, b) => b.hours - a.hours);
}

function dotClass(status) {
  return STATUS_DOT[status] || 'dot-backlog';
}

function renderRows(groups, labelKey, subLabelKey) {
  const maxH = Math.max(...groups.map(g => g.hours), 1);
  return groups.map((g, i) => {
    const pct = Math.round((g.hours / maxH) * 100);
    const taskRows = g.tasks
      .sort((a, b) => b.hours - a.hours)
      .map(t => `
        <div class="task-item">
          <span class="dot ${dotClass(t.status)}"></span>
          <span class="task-title" title="${esc(t.title)}">${esc(t.title)}</span>
          <span class="task-proj">${esc(t[subLabelKey])}</span>
          <span class="task-hours">${t.hours > 0 ? t.hours + ' ч' : '—'}</span>
        </div>`).join('');

    return `
      <div class="row-card">
        <div class="row-head" onclick="toggle(this)">
          <div class="row-name" title="${esc(g.name)}">${esc(g.name)}</div>
          <div class="bar-wrap"><div class="bar-fill" style="width:${pct}%"></div></div>
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

  document.getElementById('panel-people').innerHTML   = renderRows(byPerson,  'person',  'project');
  document.getElementById('panel-projects').innerHTML = renderRows(byProject, 'project', 'person');

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
