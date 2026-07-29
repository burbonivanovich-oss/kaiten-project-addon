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

// Доски задач с привязкой к id карточки-проекта (Обзор проектов)
const TASK_BOARDS = {
  // Проектные доски
  1843480: { name: 'Больше оплат',          card_id: 67893925 },
  1843621: { name: 'Рост выручки Общепита', card_id: 67893920 },
  1843623: { name: 'Рост CR2',              card_id: 67893914 },
  1843625: { name: 'Квиз на сайте',         card_id: 67893931 },
  // Доски команд
  1841937: { name: 'ПМ',                   card_id: null },
  1841454: { name: 'Копирайт',             card_id: null },
  1841467: { name: 'Редактор',             card_id: null },
  1841941: { name: 'Техпис',               card_id: null },
  1841936: { name: 'Дизайн',              card_id: null },
  1841938: { name: 'Интернет-маркетинг',  card_id: null },
  1841939: { name: 'SEO',                  card_id: null },
  1841940: { name: 'Платное продвижение',  card_id: null },
};

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

async function fetchWorkload() {
  const people = new Map();
  for (const [boardId] of Object.entries(TASK_BOARDS)) {
    const cards = await api.get(`/api/v1/cards?board_id=${boardId}&limit=200`);
    for (const c of cards || []) {
      const members = c.members || [];
      const resp = members.filter(m => m.type === 1);
      const assignees = resp.length ? resp : members;
      for (const m of assignees) {
        const name = m.full_name || '—';
        if (!people.has(name)) people.set(name, { name, hours: 0 });
        people.get(name).hours += c.estimate_workload || 0;
      }
    }
  }
  return [...people.values()]
    .filter(p => p.name !== '—' && p.hours > 0)
    .sort((a, b) => b.hours - a.hours);
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

  const [projects, workload] = await Promise.all([fetchProjects(), fetchWorkload()]);

  setPanel('p-projects',  'Проекты',         renderProjects(projects));
  setPanel('p-deadlines', 'Дедлайны',         renderDeadlines(projects));
  setPanel('p-workload',  'Загруженность',    renderWorkload(workload));

  const now = new Date().toLocaleString('ru', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
  document.getElementById('updated').textContent = `обновлено ${now}`;

  iframe.fitSize('#shell');
}

init().catch(e => {
  document.getElementById('grid').innerHTML =
    `<div class="panel"><div class="empty">⚠️ ${esc(e?.message || String(e))}</div></div>`;
});
