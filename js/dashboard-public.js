/* АВТОНОМНЫЙ ДАШБОРД — работает без Kaiten SDK.
 * Токен хранится в localStorage; страница доступна по прямому URL / Embed-блоку.
 */

const KAITEN         = 'https://artempdirect3.kaiten.ru';
const TOKEN_KEY      = 'kaiten_api_token';
const OVERVIEW_BOARD = 1853650;
const OVERVIEW_SPACE = 825694;

const cardUrl = (cardId, boardId, spaceId) =>
  `${KAITEN}/space/${spaceId}/${boardId}/card/${cardId}`;

const STATUS = {
  18963880: { label: 'В плане',            color: '#1D9E75' },
  18963881: { label: 'Отстаёт',            color: '#EF9F27' },
  18963882: { label: 'Критичные проблемы', color: '#E24B4A' },
};

const TEAM_BOARDS = {
  1853651: { name: 'ПМ',                  space: 825700 },
  1853654: { name: 'Копирайт',            space: 825702 },
  1853655: { name: 'Редактор',            space: 825702 },
  1853656: { name: 'Техпис',              space: 825702 },
  1853657: { name: 'Дизайн',             space: 825703 },
  1853659: { name: 'Интернет-маркетинг', space: 825704 },
  1853660: { name: 'SEO',                 space: 825704 },
  1853661: { name: 'Платное продвижение', space: 825704 },
};
const PROP_EST = 620084;

let token = localStorage.getItem(TOKEN_KEY);

const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

async function apiFetch(path) {
  const res = await fetch(KAITEN + path, {
    headers: { 'Authorization': 'Bearer ' + token },
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

// ── Данные ──

async function fetchProjects() {
  const cards = await apiFetch(`/api/v1/cards?board_id=${OVERVIEW_BOARD}&limit=100`);
  return (cards || [])
    .filter(c => !c.archived && c.type_id === 705580)
    .map(c => {
      const sv = (c.properties?.['id_620078'] || [])[0];
      return {
        id:    c.id,
        title: c.title,
        status: STATUS[sv] || null,
        pct:   c.children_count ? Math.round((c.children_done / c.children_count) * 100) : 0,
        done:  c.children_done  || 0,
        total: c.children_count || 0,
        due:   c.due_date || null,
      };
    })
    .sort((a, b) => {
      const order = { 'Критичные проблемы': 0, 'Отстаёт': 1, 'В плане': 2 };
      return (order[a.status?.label] ?? 3) - (order[b.status?.label] ?? 3);
    });
}

// Задача без оценки — всё равно задача. Раньше она отбрасывалась, и человек
// с пятью незаоценёнными задачами показывался как незагруженный.
function addToLoad(people, c) {
  if (c.archived || c.state === 3) return;          // готовое не нагружает
  const hrs = c.estimate_workload || Number((c.properties || {})[`id_${PROP_EST}`]) || 0;
  const members   = c.members || [];
  const resp      = members.filter(m => m.type === 1);
  const assignees = resp.length ? resp : members;
  for (const m of assignees) {
    const name = m.full_name || '—';
    if (!people.has(name)) people.set(name, { name, hours: 0, active: 0, wip: 0, estimated: 0 });
    const p = people.get(name);
    p.active += 1;
    if (c.state === 2) p.wip += 1;                  // 2 — «в работе»
    if (hrs) { p.hours += hrs; p.estimated += 1; }
  }
}

async function fetchWorkload(projects) {
  const people = new Map();
  for (const proj of projects) {
    const children = await apiFetch(`/api/v1/cards/${proj.id}/children?limit=200`);
    for (const c of children || []) addToLoad(people, c);
  }
  for (const [boardId] of Object.entries(TEAM_BOARDS)) {
    const cards = await apiFetch(`/api/v1/cards?board_id=${boardId}&limit=200`);
    // parents_count, а не parent_id: последний всегда null и давал двойной учёт.
    for (const c of (cards || []).filter(c => !c.parents_count && !c.archived)) addToLoad(people, c);
  }
  return [...people.values()].filter(p => p.name !== '—' && p.active > 0)
    .sort((a, b) => b.wip - a.wip || b.active - a.active);
}

async function fetchOrphans() {
  const orphans = [];
  for (const [boardId, info] of Object.entries(TEAM_BOARDS)) {
    const cards = await apiFetch(`/api/v1/cards?board_id=${boardId}&limit=200`);
    for (const c of (cards || []).filter(c => !c.parents_count && !c.archived && c.state !== 3)) {
      orphans.push({
        id: c.id, title: c.title, team: info.name,
        boardId: Number(boardId), spaceId: info.space,
        estimate: c.estimate_workload || Number((c.properties || {})[`id_${PROP_EST}`]) || 0,
        assignee: (c.members || []).map(m => m.full_name).filter(Boolean).join(', ') || '—',
      });
    }
  }
  return orphans.sort((a, b) => a.team.localeCompare(b.team, 'ru'));
}

// ── Рендер ──

// Пороги по числу задач в работе, а не по проценту выдуманной нормы.
function normColor(wip) {
  if (wip >= 5) return '#ef4444';
  if (wip >= 3) return '#f59e0b';
  return '#3b5bdb';
}

function renderProjects(projects) {
  if (!projects.length) return '<div class="empty">Нет проектов</div>';
  return projects.map(p => {
    const sc  = p.status?.color || '#8b92a5';
    const sl  = p.status?.label || '—';
    return `
      <div class="proj" onclick="window.open('${cardUrl(p.id, OVERVIEW_BOARD, OVERVIEW_SPACE)}','_blank')">
        <div class="proj-top">
          <div class="proj-dot" style="background:${sc}"></div>
          <div class="proj-name" title="${esc(p.title)}">${esc(p.title)}</div>
          <div class="proj-status" style="background:${sc}1a;color:${sc}">${esc(sl)}</div>
        </div>
        <div class="proj-bar-wrap">
          <div class="proj-bar"><div class="proj-bar-fill" style="width:${p.pct}%;background:${sc}"></div></div>
          <div class="proj-pct">${p.pct}%</div>
        </div>
      </div>`;
  }).join('');
}

function renderDeadlines(projects) {
  const today = new Date(); today.setHours(0,0,0,0);
  const withDue = projects
    .filter(p => p.due)
    .map(p => {
      const d = new Date(p.due); d.setHours(0,0,0,0);
      return { ...p, days: Math.round((d - today) / 86400000) };
    })
    .sort((a, b) => a.days - b.days);

  if (!withDue.length) return '<div class="empty">Дедлайны не заданы</div>';

  return withDue.map(p => {
    let cls, badge;
    if (p.days < 0)       { cls = 'bad';  badge = `−${Math.abs(p.days)} дн`; }
    else if (p.days <= 14){ cls = 'warn'; badge = `${p.days} дн`; }
    else                  { cls = 'ok';   badge = `${p.days} дн`; }
    const dateStr = new Date(p.due).toLocaleDateString('ru', { day:'numeric', month:'short' });
    return `
      <div class="dl-row" onclick="window.open('${cardUrl(p.id, OVERVIEW_BOARD, OVERVIEW_SPACE)}','_blank')">
        <div class="dl-badge ${cls}">${badge}</div>
        <div class="dl-name" title="${esc(p.title)}">${esc(p.title)}</div>
        <div class="dl-date">${dateStr}</div>
      </div>`;
  }).join('');
}

function renderOrphans(orphans) {
  if (!orphans.length) return '<div class="empty">Все задачи привязаны к проектам ✅</div>';
  return orphans.map(o => {
    const url = cardUrl(o.id, o.boardId, o.spaceId);
    return `
      <div class="dl-row" onclick="window.open('${url}','_blank')">
        <div class="dl-badge warn">${esc(o.team)}</div>
        <div class="dl-name" title="${esc(o.title)}">${esc(o.title)}</div>
        <div class="dl-date">${esc(o.assignee)}${o.estimate ? ' · ' + o.estimate + ' ч' : ''}</div>
      </div>`;
  }).join('');
}

function renderWorkload(people) {
  if (!people.length) return '<div class="empty">Нет данных</div>';
  const maxWip = Math.max(...people.map(p => p.wip), 1);
  return people.map(p => {
    const pct   = Math.round((p.wip / maxWip) * 100);
    const color = normColor(p.wip);
    const hours = p.estimated
      ? `${p.hours} ч${p.estimated < p.active ? ` (оценка у ${p.estimated} из ${p.active})` : ''}`
      : 'без оценок';
    return `
      <div class="wl-row">
        <div class="wl-top">
          <div class="wl-name">${esc(p.name)}</div>
          <div class="wl-pct" style="color:${color}">${p.wip} в работе · ${p.active} активных</div>
        </div>
        <div class="wl-bar-wrap"><div class="wl-bar" style="width:${pct}%;background:${color}"></div></div>
        <div class="wl-sub muted">${hours}</div>
      </div>`;
  }).join('');
}

function setPanel(id, title, html) {
  document.getElementById(id).innerHTML = `<div class="panel-title">${title}</div>${html}`;
}

// ── Токен-гейт ──

function showGate(errorText) {
  document.getElementById('gate').style.display = '';
  document.getElementById('shell').style.display = 'none';
  if (errorText) document.getElementById('gate-msg').textContent = errorText;
}

function showShell() {
  document.getElementById('gate').style.display = 'none';
  document.getElementById('shell').style.display = '';
}

async function loadDashboard() {
  showShell();
  try {
    const projects = await fetchProjects();
    const [workload, orphans] = await Promise.all([fetchWorkload(projects), fetchOrphans()]);
    setPanel('p-projects',  'Проекты',                     renderProjects(projects));
    setPanel('p-deadlines', 'Дедлайны',                    renderDeadlines(projects));
    setPanel('p-workload',  'Загруженность',                renderWorkload(workload));
    setPanel('p-orphans',   'Влётные задачи (без проекта)', renderOrphans(orphans));
    const now = new Date().toLocaleString('ru', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
    document.getElementById('updated').textContent = `обновлено ${now}`;
  } catch (e) {
    if (e.message.includes('401') || e.message.includes('403')) {
      localStorage.removeItem(TOKEN_KEY);
      token = null;
      showGate('Токен недействителен — введите новый');
    } else {
      document.getElementById('grid').innerHTML =
        `<div class="panel"><div class="empty">⚠️ ${esc(e?.message || String(e))}</div></div>`;
    }
  }
}

// ── Init ──

document.addEventListener('DOMContentLoaded', () => {
  // Кнопка «Войти»
  document.getElementById('token-submit').addEventListener('click', async () => {
    const val = document.getElementById('token-input').value.trim();
    if (!val) return;
    document.getElementById('gate-msg').textContent = 'Проверяю…';
    document.getElementById('token-submit').disabled = true;

    token = val;
    try {
      await apiFetch('/api/v1/users/current');  // проверочный вызов
      localStorage.setItem(TOKEN_KEY, token);
      loadDashboard();
    } catch (e) {
      token = null;
      document.getElementById('gate-msg').textContent = 'Ошибка: ' + (e?.message || e);
      document.getElementById('token-submit').disabled = false;
    }
  });

  // Enter в поле токена
  document.getElementById('token-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('token-submit').click();
  });

  // Кнопка «Сменить токен»
  document.getElementById('reset-token').addEventListener('click', () => {
    localStorage.removeItem(TOKEN_KEY);
    token = null;
    document.getElementById('token-input').value = '';
    document.getElementById('gate-msg').textContent = '';
    showGate();
  });

  // Старт
  if (token) {
    loadDashboard();
  } else {
    showGate();
  }
});
