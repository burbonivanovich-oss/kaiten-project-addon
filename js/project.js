/* СТРАНИЦА ПРОЕКТА — один экран здоровья проекта.
 *
 * БАЗОВЫЙ слой (готовность · срок · «молчим») берётся из самой карточки через
 * SDK getCard() — postMessage, без OAuth. Работает всегда, хиро ведёт готовностью.
 *
 * РАСШИРЕННЫЙ слой (статус · метрика план/факт · задачи по командам · загрузка ·
 * история) требует чтения свойств/детей/комментариев — это REST API от имени
 * пользователя (OAuth). Best-effort: получилось — хиро «повышается» до статусного
 * и добавляются блоки; не получилось (напр. addon-OAuth аккаунта отдаёт токен,
 * который API отклоняет 401) — экран не пустует: базовый слой виден, блок помечен.
 *
 * Почему значения свойств нельзя взять без API: getCard() в секции отдаёт карточку
 * без .properties; getCardProperties() в контексте секции значений не даёт, а в
 * card_body_section вовсе бросает «Unknown subject»; мост через setData/getData
 * между бейджами и секцией данные не разделяет. Проверено — только API.
 */

const iframe = Addon.iframe();
const root = document.getElementById('root');

const F = { status: 'Статус', metric: 'Что меряем', plan: 'План', fact: 'Факт', estimate: 'Оценка, ч',
            leadName: 'Опережающий показатель', leadFact: 'Опережающий: факт' };
const STATUS_CLASS = { 'В плане': 'ok', 'Отстаёт': 'warn', 'Критичные проблемы': 'bad' };

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Готовой считается только завершённая карточка (state 3 — колонка типа «готово»).
// Archived (condition 2) раньше тоже шло в зачёт, и заброшенный проект, у которого
// задачи просто убрали в архив, показывал 100% готовности.
const isDone = (c) => c.state === 3;

/* Значения select-полей приходится догружать отдельно.
 *
 * GET /company/custom-properties отдаёт определения БЕЗ ключа values — ни один
 * параметр (with_values, include, expand) этого не меняет, проверено. Поэтому
 * любое чтение select через def.values молча возвращало null: статус проекта
 * не читался, влияние и стоимость гипотезы считались незаполненными, а форма
 * отчёта не находила id значения и не сохраняла статус вообще.
 *
 * Грузим только те поля, которые реально нужны экрану, и параллельно.
 */
async function loadSelectValues(api, defs, names) {
  const need = (defs || []).filter((d) =>
    names.indexOf(d.name) !== -1 &&
    (d.type === 'select' || d.type === 'multi_select') && !d.values);
  await Promise.all(need.map(async (d) => {
    try { d.values = await api.get(`/api/v1/company/custom-properties/${d.id}/select-values`); }
    catch (e) { d.values = []; }
  }));
  return defs;
}

function readProp(defs, card, name) {
  const def = (defs || []).find((p) => p.name === name);
  if (!def) return null;
  const raw = (card.properties || {})[`id_${def.id}`];
  if (raw == null) return null;
  if (Array.isArray(raw)) {
    const v = (def.values || []).find((x) => x.id === raw[0] || x.uid === raw[0]);
    return v ? (v.value || v.display_value) : null;
  }
  return raw;
}

const bar = (pct, cls) =>
  `<div class="bar"><div class="bar-fill ${cls || ''}" style="width:${Math.min(pct, 100)}%"></div></div>`;

const daysAgo = (iso) => iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : null;

const AVA_COLORS = ['#6c5cd4', '#2aa1c0', '#c0692a', '#2f9e6f', '#c0457a', '#5a76d4', '#b8902a'];
function avatar(name) {
  const s = String(name || '?');
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const initial = s.trim().charAt(0).toUpperCase() || '?';
  return `<span class="ava" style="background:${AVA_COLORS[h % AVA_COLORS.length]}">${esc(initial)}</span>`;
}

function heroHtml(cls, title, sub, pct) {
  return `
    <div class="hero ${cls}">
      <span class="hero-dot"></span>
      <div class="hero-main">
        <div class="hero-status">${esc(title)}</div>
        <div class="hero-sub">${sub}</div>
      </div>
      <div class="hero-pct"><b>${pct}%</b><span>готово</span></div>
    </div>`;
}

/* ── Доклад и факт — это два разных ответа, и раньше они были склеены ──────
 *
 * Хиро красился ручным статусом, а процент считался из задач. Получался
 * зелёный проект с нулевой готовностью: машинист доложил «в плане», система
 * видела, что не сделано ничего, и обе правды показывались как одна.
 *
 * Теперь цветом ведёт СИСТЕМА (её нельзя уговорить), доклад машиниста стоит
 * отдельным блоком, а если доклад оптимистичнее факта — это прямо сказано.
 */

const LEVEL = { ok: 0, warn: 1, bad: 2 };
const LEVEL_NAME = ['ok', 'warn', 'bad'];

// Считается из самой карточки — без API, поэтому виден всегда.
function systemSignals(card, pct, total) {
  const items = [];
  let level = LEVEL.ok;
  const raise = (l) => { if (l > level) level = l; };

  const now = Date.now();
  const due = card.due_date ? new Date(card.due_date) : null;

  if (!total) {
    items.push({ lvl: 'warn', text: 'К проекту не привязано ни одной задачи — прогресс считать не из чего' });
    raise(LEVEL.warn);
  }

  if (due && due.getTime() < now && pct < 100) {
    const late = Math.floor((now - due.getTime()) / 86400000);
    items.push({ lvl: 'bad', text: `Срок прошёл ${late} дн назад, сделано ${pct}%` });
    raise(LEVEL.bad);
  } else if (due && total) {
    // Темп: сколько срока прошло против того, сколько сделано.
    const start = new Date(card.created_at || card.created || 0).getTime();
    const span = due.getTime() - start;
    if (span > 0) {
      const timePct = Math.min(Math.round(((now - start) / span) * 100), 100);
      const gap = timePct - pct;
      if (gap >= 40) {
        items.push({ lvl: 'bad', text: `Прошло ${timePct}% срока, сделано ${pct}% — отставание от темпа` });
        raise(LEVEL.bad);
      } else if (gap >= 20) {
        items.push({ lvl: 'warn', text: `Прошло ${timePct}% срока, сделано ${pct}% — идём медленнее плана` });
        raise(LEVEL.warn);
      } else {
        items.push({ lvl: 'ok', text: `Прошло ${timePct}% срока, сделано ${pct}% — в темпе` });
      }
    }
  } else if (!due) {
    items.push({ lvl: 'warn', text: 'Срок не задан — темп не с чем сравнивать' });
    raise(LEVEL.warn);
  }

  /* Молчание. Считаем от последнего комментария; если комментариев не было
   * вовсе — говорим именно это, а не подставляем дату создания под видом
   * даты отчёта. Разница существенная: «без отчёта 20 дн» и «не отчитывались
   * ни разу» требуют разного разговора. */
  const age = daysAgo(card.created_at || card.created);
  const reported = daysAgo(card.comment_last_added_at);
  if (reported != null && reported > 14) {
    items.push({ lvl: 'warn', text: `Без отчёта ${reported} дн` });
    raise(LEVEL.warn);
  } else if (reported == null && age != null && age > 14) {
    items.push({ lvl: 'warn', text: `Отчётов не было ни разу, проект идёт ${age} дн` });
    raise(LEVEL.warn);
  }

  /* Ноль сделанного при живом проекте.
   *
   * Правило темпа в начале проекта всегда говорит «в темпе»: срока прошло
   * мало, разрыв маленький. Из-за этого проект с нулём закрытых задач висел
   * зелёным ровно в те недели, когда вмешаться дешевле всего. Этот сигнал от
   * темпа не зависит — он про то, что работа не тронулась. */
  if (total && !pct && age != null && age >= 7 && card.state !== 3) {
    items.push({ lvl: age >= 21 ? 'bad' : 'warn',
                 text: `Проект идёт ${age} дн, не закрыто ни одной из ${total} задач` });
    raise(age >= 21 ? LEVEL.bad : LEVEL.warn);
  }

  return { level, cls: LEVEL_NAME[level], items };
}

const signalsCard = (sys) => `
  <div class="card">
    <div class="card-title">📡 Что видит система</div>
    ${sys.items.map((s) => `
      <div class="task"><span class="dot ${s.lvl}"></span><span class="t-title">${esc(s.text)}</span></div>
    `).join('')}
  </div>`;

/* Ручной статус — это доклад, а не факт. Показываем как доклад, с датой.
 *
 * Дату берём ТОЛЬКО из последнего комментария. Раньше здесь работал общий
 * silent, у которого есть запасной вариант «дата создания карточки», и на
 * проекте без единого комментария блок писал «обновлено 3 дн назад» — про
 * доклад, которого никогда не было. Выдуманная свежесть хуже её отсутствия:
 * ровно на неё смотрит тот, кто решает, доверять ли светофору. */
function reportedCard(status, reportedDays) {
  const cls = STATUS_CLASS[status] || '';
  const when = reportedDays == null ? 'отчётов ещё не было'
    : reportedDays === 0 ? 'обновлено сегодня' : `обновлено ${reportedDays} дн назад`;
  return `
    <div class="card">
      <div class="card-title">📣 Докладывает машинист</div>
      <div class="task">
        <span class="dot ${cls}"></span>
        <span class="t-title"><b>${esc(status)}</b></span>
        <span class="due">${when}</span>
      </div>
    </div>`;
}

// Расхождение показываем только в одну сторону: когда доклад приятнее факта.
// Обратное («доложил хуже, чем есть») — не проблема, а осторожность.
function mismatchBox(status, sys) {
  const reported = { 'В плане': LEVEL.ok, 'Не начат': LEVEL.ok,
                     'Отстаёт': LEVEL.warn, 'Критичные проблемы': LEVEL.bad }[status];
  if (reported == null || reported >= sys.level) return '';
  const worst = sys.items.find((s) => s.lvl === LEVEL_NAME[sys.level]);
  return `
    <div class="card warn-box">
      <div class="card-title">⚠️ Доклад расходится с фактом</div>
      <div class="muted">Статус «${esc(status)}», но система видит: ${esc(worst ? worst.text : '—')}.
      Либо статус пора обновить, либо в комментарии объяснить, почему всё в порядке.</div>
    </div>`;
}

/* Расширенный слой через REST API. Возвращает { status, metricHtml, blocks } или
 * null, если API недоступен (нет токена / 401 / ошибка). */
async function extendedBlocks(card) {
  let api;
  try { api = iframe.getApiClient(); } catch (e) { return null; }
  try { await api.getAccessToken(); } catch (e) { return null; }

  let defs, full, children, comments;
  try {
    [defs, full, children, comments] = await Promise.all([
      api.get('/api/v1/company/custom-properties?limit=200'),
      api.get(`/api/v1/cards/${card.id}`),
      api.get(`/api/v1/cards/${card.id}/children`),
      api.get(`/api/v1/cards/${card.id}/comments`),
    ]);
  } catch (e) { return null; }

  await loadSelectValues(api, defs, [F.status, F.metric]);

  const status = readProp(defs, full, F.status);
  const metric = readProp(defs, full, F.metric);
  const plan = Number(readProp(defs, full, F.plan)) || 0;
  const fact = Number(readProp(defs, full, F.fact)) || 0;
  const factPct = plan ? Math.round((fact / plan) * 100) : 0;
  const statusCls = STATUS_CLASS[status] || '';

  const done = children.filter(isDone).length;
  const total = children.length;

  const byBoard = {};
  for (const c of children) {
    const key = (c.board && c.board.title) || `Доска ${c.board_id}`;
    (byBoard[key] = byBoard[key] || []).push(c);
  }

  const estDef = (defs || []).find((p) => p.name === F.estimate);
  const load = {};
  let totalPlan = 0;
  for (const t of children) {
    const est = estDef ? Number((t.properties || {})[`id_${estDef.id}`]) || 0 : 0;
    if (!est) continue;
    totalPlan += est;
    const assignees = (t.members || []).filter((m) => m.id !== t.owner_id);
    const targets = assignees.length ? assignees : (t.members || []).slice(0, 1);
    for (const m of targets) load[m.full_name] = (load[m.full_name] || 0) + est;
  }
  const loadRows = Object.entries(load).sort((a, b) => b[1] - a[1]);
  const maxLoad = loadRows.length ? loadRows[0][1] : 0;

  const history = comments.filter((c) => /Статус|Отчёт/i.test(c.text || '')).slice(-6).reverse();

  // Опережающий и отстающий показатели — в одном блоке, но разными строками
  // и с подписью, чем они отличаются. Смешивать их нельзя: первый показывает,
  // что команда делает сейчас, второй — что из этого вышло позже.
  const leadName = readProp(defs, full, F.leadName);
  const leadFact = readProp(defs, full, F.leadFact);

  const lagRow = metric ? `
      <div class="metric">
        <div class="metric-label">${esc(metric)}</div>
        <div class="grow">${bar(factPct, statusCls)}</div>
        <div class="metric-num"><b>${fact}</b> из ${plan}</div>
      </div>
      <div class="load-foot">итоговый — показывает результат, когда повлиять уже поздно</div>` : '';

  const leadRow = leadName ? `
      <div class="metric">
        <div class="metric-label">${esc(leadName)}</div>
        <div class="grow"></div>
        <div class="metric-num"><b>${leadFact != null ? esc(leadFact) : '—'}</b></div>
      </div>
      <div class="load-foot">опережающий — на него команда влияет на этой неделе</div>`
    : `<div class="muted">Опережающий показатель не задан. Он заполняется в форме
       «📝 Отчёт за 2 недели» — без него виден только результат задним числом.</div>`;

  // Блок показываем всегда: отсутствие опережающего показателя — это тоже
  // сообщение, и оно важнее пустоты на его месте.
  const metricHtml = `
    <div class="card">
      <div class="card-title">📈 Показатели</div>
      ${leadRow}
      ${lagRow}
    </div>`;

  const blocks = `
    <div class="card">
      <div class="card-title">✅ Задачи по командам <span class="cnt">${done} / ${total}</span></div>
      <div class="load-foot" style="margin:-2px 0 8px">Поле «Готовность, %» выше в
      карточке считает по-своему — это формула Kaiten, убрать её из карточки нельзя.
      Здесь — доля закрытых задач, то же число, что в шапке секции.</div>
      ${Object.keys(byBoard).length === 0
        ? '<div class="muted">Задач пока нет. Заведите их на досках команд и укажите этот проект родителем.</div>'
        : Object.entries(byBoard).map(([board, list]) => `
          <div class="team">
            <div class="team-name">${esc(board)}<span class="team-badge">${
              list.filter(isDone).length} / ${list.length}</span></div>
            ${list.map((c) => {
              const cdone = isDone(c);
              // Просроченная задача рисовалась тем же серым, что и остальные:
              // на живом проекте одна такая пролежала одиннадцать дней, и
              // ни на доске, ни здесь её ничто не выделяло.
              const late = !cdone && c.due_date && new Date(c.due_date) < new Date();
              const lateDays = late
                ? Math.floor((Date.now() - new Date(c.due_date).getTime()) / 86400000) : 0;
              return `
              <div class="task ${cdone ? 'done' : ''}">
                <span class="tick">${cdone ? '✓' : ''}</span>
                <span class="t-title">${esc(c.title)}</span>
                ${c.due_date ? `<span class="due${late ? ' late' : ''}">${
                  late ? `🚨 просрочена ${lateDays} дн`
                       : new Date(c.due_date).toLocaleDateString('ru')}</span>` : ''}
              </div>`; }).join('')}
          </div>`).join('')}
    </div>

    ${loadRows.length ? `
    <div class="card">
      <div class="card-title">👥 Загрузка команды (план) <span class="cnt">${totalPlan} ч</span></div>
      ${loadRows.map(([name, days]) => `
        <div class="load">
          ${avatar(name)}
          <span class="load-name">${esc(name)}</span>
          <span class="load-bar">${bar(maxLoad ? Math.round(days / maxLoad * 100) : 0)}</span>
          <span class="load-num">${days}</span>
        </div>`).join('')}
      <div class="load-foot">оценка задачи идёт на её исполнителей (поле «Оценка, ч»)</div>
    </div>` : ''}

    ${history.length ? `
    <div class="card">
      <div class="card-title">🕑 История статусов</div>
      ${history.map((c) => `
        <div class="hist">
          <span class="hist-date">${new Date(c.created).toLocaleDateString('ru')}</span>
          <span class="hist-text">${esc((c.text || '').replace(/[#*]/g, '').slice(0, 90))}</span>
        </div>`).join('')}
    </div>` : ''}`;

  return { status, metricHtml, blocks };
}

async function render() {
  const card = await iframe.getCard();

  const total = card.children_count || 0;
  const done = card.children_done || 0;
  const pct = total ? Math.round((done / total) * 100) : 0;

  // Только реальные комментарии: null здесь означает «отчётов не было»,
  // и блок доклада скажет именно это, а не подставит возраст карточки.
  const reportedDays = daysAgo(card.comment_last_added_at);
  const due = card.due_date ? `срок ${new Date(card.due_date).toLocaleDateString('ru')}` : 'срок не задан';

  // Хиро ведёт системным сигналом, а не ручным статусом: цвет должен отражать
  // то, что видно из данных, иначе он снова начнёт успокаивать без оснований.
  const sys = systemSignals(card, pct, total);
  const heroTitle = total ? `${done} из ${total} задач сделано` : 'Задач ещё нет';

  root.innerHTML =
    heroHtml(sys.cls, heroTitle, due, pct) +
    signalsCard(sys) +
    `<div id="reported"></div>` +
    `<div id="ext"><div class="muted" style="padding:4px 2px">Подгружаю задачи…</div></div>`;
  iframe.fitSize('#root');

  const ext = await extendedBlocks(card);
  if (ext) {
    // Доклад машиниста доступен только через API — ставим его отдельным блоком
    // рядом с системными сигналами, а не поверх них.
    if (ext.status) {
      document.getElementById('reported').innerHTML =
        reportedCard(ext.status, reportedDays) + mismatchBox(ext.status, sys);
    }
    document.getElementById('ext').innerHTML = ext.metricHtml + ext.blocks;
  } else {
    // API недоступен — не пустуем: показываем готовность, кнопку авторизации и честно про остальное
    document.getElementById('ext').innerHTML = `
      <div class="card">
        <div class="card-title">✅ Задачи по командам <span class="cnt">${done} / ${total}</span></div>
        <div class="metric">
          <div class="metric-label">Готовность</div>
          <div class="grow">${bar(pct)}</div>
          <div class="metric-num"><b>${done}</b> из ${total}</div>
        </div>
        <div class="row" style="margin-top:12px"><button id="authbtn" class="primary" type="button">🔓 Показать полностью</button></div>
        <div id="authmsg" class="load-foot"></div>
      </div>`;
    const btn = document.getElementById('authbtn');
    if (btn) btn.addEventListener('click', async () => {
      const msg = document.getElementById('authmsg');
      msg.textContent = 'Жду подтверждения доступа в окне Kaiten…';
      try {
        const api = iframe.getApiClient();
        await api.authorize();
        msg.textContent = 'Доступ выдан, загружаю…';
        await render();
      } catch (e) {
        msg.textContent = 'Не удалось получить доступ: ' + ((e && e.message) || e);
      }
    });
  }
  iframe.fitSize('#root');
}

render().catch((e) => {
  root.innerHTML = `<div class="muted">Не удалось загрузить: ${esc(e && e.message)}</div>`;
  iframe.fitSize('#root');
});
