/* ДАШБОРД КОМАНДЫ — три ключевых разреза: статусы, дедлайны, загруженность */

const iframe = Addon.iframe();
const api    = iframe.getApiClient();

const KAITEN         = 'https://artempdirect1.kaiten.ru';
const OVERVIEW_BOARD = 1843681;
const OVERVIEW_SPACE = 820245;   // пространство «2 · Портфель проектов»
const MONTHLY_NORM   = 160;

const cardUrl = (cardId, boardId, spaceId) =>
  `${KAITEN}/space/${spaceId}/${boardId}/card/${cardId}`;

// Статус: id значения → метка + цвет
const STATUS = {
  18948771: { label: 'В плане',            color: '#1D9E75' },
  18948772: { label: 'Отстаёт',            color: '#EF9F27' },
  18948773: { label: 'Критичные проблемы', color: '#E24B4A' },
};

// Доски команд: id → { название, space_id } — для orphan-детекции и URL
const TEAM_BOARDS = {
  1841937: { name: 'ПМ',                  space: 819415 },
  1841454: { name: 'Копирайт',            space: 819416 },
  1841467: { name: 'Редактор',            space: 819416 },
  1841941: { name: 'Техпис',              space: 819416 },
  1841936: { name: 'Дизайн',             space: 819417 },
  1841938: { name: 'Интернет-маркетинг', space: 819418 },
  1841939: { name: 'SEO',                 space: 819418 },
  1841940: { name: 'Платное продвижение', space: 819418 },
};
const PROP_EST = 615627; // id кастомного свойства «Оценка, чел-дн»

const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

async function ensureAuth() {
  try { await api.getAccessToken(); return; } catch (e) {}
  document.getElementById('shell').innerHTML = `
    <div class="gate">
      <div class="gate-icon">🔐</div>
      <div class="gate-title">Нужно разовое разрешение</div>
      <p class="gate-text">Дашборд читает данные от вашего имени — Kaiten один раз спросит подтверждение.</p>
      <button class="btn-primary" id="auth-btn">Разрешить доступ</button>
      <div class="gate-msg" id="auth-msg"></div>
    </div>`;
  await new Promise((resolve) => {
    document.getElementById('auth-btn').addEventListener('click', async () => {
      document.getElementById('auth-msg').textContent = 'Жду подтверждения…';
      try { await api.authorize(); resolve(); location.reload(); }
      catch (e) { document.getElementById('auth-msg').textContent = 'Доступ не выдан: ' + (e?.message || e); }
    });
  });
}

// ── Данные ──

async function fetchProjects() {
  const cards = await api.get(`/api/v1/cards?board_id=${OVERVIEW_BOARD}&limit=100`);
  return (cards || [])
    .filter(c => !c.archived && c.type_id === 699509)
    .map(c => {
      const p  = c.properties || {};
      const sv = (p['id_615620'] || [])[0]; // Статус select-value id
      return {
        id:      c.id,
        title:   c.title,
        status:  STATUS[sv] || null,
        pct:     c.children_count ? Math.round((c.children_done / c.children_count) * 100) : 0,
        done:    c.children_done  || 0,
        total:   c.children_count || 0,
        due:     c.due_date || null,
      };
    })
    .sort((a, b) => {
      // Критичные → Отстаёт → В плане
      const order = { 'Критичные проблемы': 0, 'Отстаёт': 1, 'В плане': 2 };
      const oa = order[a.status?.label] ?? 3;
      const ob = order[b.status?.label] ?? 3;
      return oa - ob;
    });
}

function addToLoad(people, c) {
  const hrs = c.estimate_workload || Number((c.properties || {})[`id_${PROP_EST}`]) || 0;
  if (!hrs) return;
  const members  = c.members || [];
  const resp     = members.filter(m => m.type === 1);
  const assignees = resp.length ? resp : members;
  for (const m of assignees) {
    const name = m.full_name || '—';
    if (!people.has(name)) people.set(name, { name, hours: 0 });
    people.get(name).hours += hrs;
  }
}

// Загрузка: дети проектных карточек + влётные задачи на досках команд
async function fetchWorkload(projects) {
  const people = new Map();

  // 1. Задачи привязанные к проектам (children)
  for (const proj of projects) {
    const children = await api.get(`/api/v1/cards/${proj.id}/children?limit=200`);
    for (const c of children || []) addToLoad(people, c);
  }

  // 2. Влётные задачи на досках команд без parent_id
  for (const [boardId] of Object.entries(TEAM_BOARDS)) {
    const cards = await api.get(`/api/v1/cards?board_id=${boardId}&limit=200`);
    for (const c of (cards || []).filter(c => !c.parent_id && !c.archived)) {
      addToLoad(people, c);
    }
  }

  return [...people.values()]
    .filter(p => p.name !== '—' && p.hours > 0)
    .sort((a, b) => b.hours - a.hours);
}

// Влётные задачи — без привязки к проекту
async function fetchOrphans() {
  const orphans = [];
  for (const [boardId, info] of Object.entries(TEAM_BOARDS)) {
    const cards = await api.get(`/api/v1/cards?board_id=${boardId}&limit=200`);
    for (const c of (cards || []).filter(c => !c.parent_id && !c.archived && c.state !== 3)) {
      orphans.push({
        id:       c.id,
        title:    c.title,
        team:     info.name,
        boardId:  Number(boardId),
        spaceId:  info.space,
        estimate: c.estimate_workload || Number((c.properties || {})[`id_${PROP_EST}`]) || 0,
        assignee: (c.members || []).map(m => m.full_name).filter(Boolean).join(', ') || '—',
      });
    }
  }
  return orphans.sort((a, b) => a.team.localeCompare(b.team, 'ru'));
}

// ── Рендер ──

function normColor(pct) {
  if (pct >= 100) return '#ef4444';
  if (pct >= 80)  return '#f59e0b';
  return '#3b5bdb';
}

function renderProjects(projects) {
  if (!projects.length) return '<div class="empty">Нет проектов</div>';
  return projects.map(p => {
    const sc   = p.status?.color || '#8b92a5';
    const slbl = p.status?.label || '—';
    const bg   = sc + '1a'; // 10% opacity
    return `
      <div class="proj" onclick="window.open('${cardUrl(p.id, OVERVIEW_BOARD, OVERVIEW_SPACE)}','_blank')">
        <div class="proj-top">
          <div class="proj-dot" style="background:${sc}"></div>
          <div class="proj-name" title="${esc(p.title)}">${esc(p.title)}</div>
          <div class="proj-status" style="background:${bg};color:${sc}">${esc(slbl)}</div>
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
      const d    = new Date(p.due); d.setHours(0,0,0,0);
      const days = Math.round((d - today) / 86400000);
      return { ...p, days };
    })
    .sort((a, b) => a.days - b.days);

  if (!withDue.length) return '<div class="empty">Дедлайны не заданы</div>';

  return withDue.map(p => {
    let cls, badge;
    if (p.days < 0) {
      cls   = 'bad';
      badge = `−${Math.abs(p.days)} дн`;
    } else if (p.days <= 14) {
      cls   = 'warn';
      badge = `${p.days} дн`;
    } else {
      cls   = 'ok';
      badge = `${p.days} дн`;
    }
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
  return people.map(p => {
    const pct   = Math.min(Math.round((p.hours / MONTHLY_NORM) * 100), 100);
    const color = normColor(Math.round((p.hours / MONTHLY_NORM) * 100));
    return `
      <div class="wl-row">
        <div class="wl-top">
          <div class="wl-name">${esc(p.name)}</div>
          <div class="wl-pct" style="color:${color}">${p.hours} ч · ${Math.round((p.hours/MONTHLY_NORM)*100)}%</div>
        </div>
        <div class="wl-bar-wrap"><div class="wl-bar" style="width:${pct}%;background:${color}"></div></div>
      </div>`;
  }).join('');
}

function setPanel(id, title, html) {
  document.getElementById(id).innerHTML = `<div class="panel-title">${title}</div>${html}`;
}

async function init() {
  await ensureAuth();

  const projects = await fetchProjects();
  const [workload, orphans] = await Promise.all([fetchWorkload(projects), fetchOrphans()]);

  setPanel('p-projects',  'Проекты',                  renderProjects(projects));
  setPanel('p-deadlines', 'Дедлайны',                  renderDeadlines(projects));
  setPanel('p-workload',  'Загруженность',              renderWorkload(workload));
  setPanel('p-orphans',   'Влётные задачи (без проекта)', renderOrphans(orphans));

  const now = new Date().toLocaleString('ru', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
  document.getElementById('updated').textContent = `обновлено ${now}`;

  iframe.fitSize('#shell');
}

init().catch(e => {
  document.getElementById('grid').innerHTML =
    `<div class="panel"><div class="empty">⚠️ ${esc(e?.message || String(e))}</div></div>`;
});
