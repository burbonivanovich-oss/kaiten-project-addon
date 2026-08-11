/* ДАШБОРД КОМАНДЫ — три ключевых разреза: статусы, дедлайны, загруженность */

const iframe = Addon.iframe();
const api    = iframe.getApiClient();

const KAITEN         = 'https://artempdirect3.kaiten.ru';
const OVERVIEW_BOARD = 1853650;
const OVERVIEW_SPACE = 825694;   // пространство «2 · Портфель проектов»

const cardUrl = (cardId, boardId, spaceId) =>
  `${KAITEN}/space/${spaceId}/${boardId}/card/${cardId}`;

// Статус: id значения → метка + цвет
const STATUS = {
  18963880: { label: 'В плане',            color: '#1D9E75' },
  18963881: { label: 'Отстаёт',            color: '#EF9F27' },
  18963882: { label: 'Критичные проблемы', color: '#E24B4A' },
};

// Доски команд: id → { название, space_id } — для orphan-детекции и URL
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
const PROP_EST = 620084; // id кастомного свойства «Оценка, чел-дн»

const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

/* ── НАПРАВЛЕНИЯ ──────────────────────────────────────────────────────────
 *
 * Стратегический разрез. Портфель, отсортированный по статусу, отвечает
 * «где горит»; разрез по направлениям отвечает «куда мы вообще вкладываемся»
 * — а это разные вопросы, и второй раньше не задавался нигде.
 *
 * Поле ищем ПО ИМЕНИ и догружаем его значения отдельным запросом: список
 * свойств отдаёт определения без ключа values, это уже ломало чтение статуса
 * во всех остальных экранах.
 */
const DIRECTION_FIELD = 'Направление';
const NO_DIRECTION = 'Без направления';

let dirDefId = null;
let dirValues = {};   // select-value id → подпись

async function loadDirections() {
  try {
    const props = await api.get('/api/v1/company/custom-properties?limit=200');
    const def = (props || []).find(p => p.name === DIRECTION_FIELD);
    if (!def) return;
    dirDefId = def.id;
    const vals = await api.get(`/api/v1/company/custom-properties/${def.id}/select-values`);
    for (const v of vals || []) dirValues[v.id] = v.value || v.display_value;
  } catch (e) { /* без направлений дашборд остаётся прежним */ }
}

function readDirection(card) {
  if (!dirDefId) return NO_DIRECTION;
  const raw = (card.properties || {})[`id_${dirDefId}`];
  const id = Array.isArray(raw) ? raw[0] : raw;
  return (id != null && dirValues[id]) || NO_DIRECTION;
}

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
    .filter(c => !c.archived && c.type_id === 705580)
    .map(c => {
      const p  = c.properties || {};
      const sv = (p['id_620078'] || [])[0]; // Статус select-value id
      return {
        id:      c.id,
        title:   c.title,
        status:  STATUS[sv] || null,
        pct:     c.children_count ? Math.round((c.children_done / c.children_count) * 100) : 0,
        done:    c.children_done  || 0,
        total:   c.children_count || 0,
        due:     c.due_date || null,
        direction: readDirection(c),
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

// Задачи без оценки раньше отбрасывались целиком — человек с пятью задачами
// в работе и пустым полем «Оценка, ч» выглядел незагруженным. Теперь задача
// считается всегда, а часы — отдельный, опциональный сигнал.
function addToLoad(people, c) {
  if (c.archived || c.state === 3) return;          // готовое не нагружает
  const hrs = c.estimate_workload || Number((c.properties || {})[`id_${PROP_EST}`]) || 0;
  const members  = c.members || [];
  const resp     = members.filter(m => m.type === 1);
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

// Загрузка: дети проектных карточек + влётные задачи на досках команд
async function fetchWorkload(projects) {
  const people = new Map();

  // 1. Задачи привязанные к проектам (children)
  for (const proj of projects) {
    const children = await api.get(`/api/v1/cards/${proj.id}/children?limit=200`);
    for (const c of children || []) addToLoad(people, c);
  }

  // 2. Влётные задачи на досках команд. Признак — parents_count: parent_id Kaiten
  //    не заполняет, поэтому привязанные задачи считались здесь повторно.
  for (const [boardId] of Object.entries(TEAM_BOARDS)) {
    const cards = await api.get(`/api/v1/cards?board_id=${boardId}&limit=200`);
    for (const c of (cards || []).filter(c => !c.parents_count && !c.archived)) {
      addToLoad(people, c);
    }
  }

  return [...people.values()]
    .filter(p => p.name !== '—' && p.active > 0)
    .sort((a, b) => b.wip - a.wip || b.active - a.active);
}

// Влётные задачи — без привязки к проекту
async function fetchOrphans() {
  const orphans = [];
  for (const [boardId, info] of Object.entries(TEAM_BOARDS)) {
    const cards = await api.get(`/api/v1/cards?board_id=${boardId}&limit=200`);
    for (const c of (cards || []).filter(c => !c.parents_count && !c.archived && c.state !== 3)) {
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

// Пороги по числу задач в работе, а не по проценту выдуманной нормы.
function normColor(wip) {
  if (wip >= 5) return '#ef4444';
  if (wip >= 3) return '#f59e0b';
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

/* Портфель в разрезе направлений.
 *
 * Отвечает на вопрос, которого не было ни на одном экране: во что мы
 * вкладываемся и что из этого едет. Считаем по каждому направлению долю
 * закрытых задач его проектов и худший статус — направление не может быть
 * «в плане», если внутри горит проект.
 *
 * Строки без направления не прячем: пустое направление — это тоже сообщение,
 * причём срочное, иначе проект не попадает в стратегическую картину вообще.
 */
function renderDirections(projects) {
  if (!projects.length) return '<div class="empty">Нет проектов</div>';

  const byDir = new Map();
  for (const p of projects) {
    if (!byDir.has(p.direction)) {
      byDir.set(p.direction, { name: p.direction, projects: [], done: 0, total: 0 });
    }
    const g = byDir.get(p.direction);
    g.projects.push(p);
    g.done += p.done;
    g.total += p.total;
  }

  const RANK = { 'Критичные проблемы': 0, 'Отстаёт': 1, 'В плане': 2 };
  const groups = [...byDir.values()].map(g => {
    const worst = g.projects
      .map(p => p.status)
      .filter(Boolean)
      .sort((a, b) => (RANK[a.label] ?? 3) - (RANK[b.label] ?? 3))[0] || null;
    return {
      ...g,
      worst,
      pct: g.total ? Math.round((g.done / g.total) * 100) : 0,
      counts: {
        bad:  g.projects.filter(p => p.status?.label === 'Критичные проблемы').length,
        warn: g.projects.filter(p => p.status?.label === 'Отстаёт').length,
        ok:   g.projects.filter(p => p.status?.label === 'В плане').length,
        none: g.projects.filter(p => !p.status).length,
      },
    };
  });

  // «Без направления» всегда последним — это хвост, а не направление.
  groups.sort((a, b) => {
    if (a.name === NO_DIRECTION) return 1;
    if (b.name === NO_DIRECTION) return -1;
    return (RANK[a.worst?.label] ?? 3) - (RANK[b.worst?.label] ?? 3)
        || b.projects.length - a.projects.length;
  });

  return groups.map(g => {
    const color = g.name === NO_DIRECTION ? '#8b92a5' : (g.worst?.color || '#8b92a5');
    const chips = [
      g.counts.bad  ? `<span style="color:#E24B4A">🔴 ${g.counts.bad}</span>`  : '',
      g.counts.warn ? `<span style="color:#EF9F27">🟡 ${g.counts.warn}</span>` : '',
      g.counts.ok   ? `<span style="color:#1D9E75">🟢 ${g.counts.ok}</span>`   : '',
      g.counts.none ? `<span class="muted">⚪ ${g.counts.none}</span>`          : '',
    ].filter(Boolean).join(' · ');

    const rows = g.projects.map(p => `
      <div class="dl-row" onclick="window.open('${cardUrl(p.id, OVERVIEW_BOARD, OVERVIEW_SPACE)}','_blank')">
        <div class="dl-badge ${p.status?.label === 'Критичные проблемы' ? 'bad'
                              : p.status?.label === 'Отстаёт' ? 'warn' : 'ok'}">${p.pct}%</div>
        <div class="dl-name" title="${esc(p.title)}">${esc(p.title)}</div>
        <div class="dl-date">${p.done}/${p.total}</div>
      </div>`).join('');

    const hint = g.name === NO_DIRECTION
      ? '<div class="wl-sub muted" style="margin:2px 0 6px">Эти проекты не попадают в стратегическую картину — проставьте им направление.</div>'
      : '';

    return `
      <div class="wl-row" style="border-left:3px solid ${color};padding-left:10px;margin-bottom:14px">
        <div class="wl-top">
          <div class="wl-name">${esc(g.name)}</div>
          <div class="wl-pct">${chips}</div>
        </div>
        <div class="wl-bar-wrap"><div class="wl-bar" style="width:${g.pct}%;background:${color}"></div></div>
        <div class="wl-sub muted">${g.projects.length} ${
          g.projects.length === 1 ? 'проект' : 'проектов'} · ${g.done} из ${g.total} задач закрыто</div>
        ${hint}
        ${rows}
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

/* Влётное: список сам по себе ничего не решает — решает доля.
 *
 * Пока видно только перечень, разговор остаётся про отдельные задачи («а эту
 * зачем взяли?»). Как только видно, что влётное съедает половину активной
 * работы, разговор становится про ёмкость и приоритеты.
 *
 * Знаменатель берём из самих проектов: children_count − children_done это и
 * есть активная плановая работа. Дополнительных запросов не нужно.
 */
function renderOrphans(orphans, projects) {
  const plannedActive = projects.reduce((s, p) => s + Math.max(p.total - p.done, 0), 0);
  const unplanned = orphans.length;
  const all = plannedActive + unplanned;
  const pct = all ? Math.round((unplanned / all) * 100) : 0;

  // Порог условный, но он должен быть: без него цифра не превращается в решение.
  const cls = pct >= 40 ? 'bad' : pct >= 25 ? 'warn' : 'ok';
  const verdict = pct >= 40 ? 'влётное вытесняет проекты'
                : pct >= 25 ? 'заметная доля — стоит следить'
                : 'в пределах нормального';

  const share = `
    <div class="share ${cls}">
      <div class="share-num">${pct}%</div>
      <div class="share-txt">
        <b>${unplanned}</b> влётных против <b>${plannedActive}</b> плановых активных задач
        <div class="muted">${verdict}</div>
      </div>
    </div>`;

  if (!orphans.length) {
    return share + '<div class="empty">Все задачи привязаны к проектам ✅</div>';
  }
  return share + orphans.map(o => {
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
    // Часы — только если оценки есть, и с пометкой о неполноте.
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

async function init() {
  await ensureAuth();

  // Направления нужны до проектов: readDirection вызывается при их разборе.
  await loadDirections();

  const projects = await fetchProjects();
  setPanel('p-directions', 'Портфель по направлениям', renderDirections(projects));

  const [workload, orphans] = await Promise.all([fetchWorkload(projects), fetchOrphans()]);

  setPanel('p-projects',  'Проекты',                  renderProjects(projects));
  setPanel('p-deadlines', 'Дедлайны',                  renderDeadlines(projects));
  setPanel('p-workload',  'Загруженность',              renderWorkload(workload));
  setPanel('p-orphans',   'Влётные задачи (без проекта)', renderOrphans(orphans, projects));

  const now = new Date().toLocaleString('ru', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
  document.getElementById('updated').textContent = `обновлено ${now}`;

  // rAF: к следующему кадру разметка уже применена, иначе меряем старую высоту.
  requestAnimationFrame(() => { try { iframe.fitSize('#shell'); } catch (e) {} });
}

init().catch(e => {
  document.getElementById('grid').innerHTML =
    `<div class="panel"><div class="empty">⚠️ ${esc(e?.message || String(e))}</div></div>`;
});
