/* СВОДКА ПО ВЛОЖЕННЫМ — секция на карточке Цели или Направления.
 *
 * Один экран отвечает на вопрос «как дела у направления?»: светофоры всех
 * дочерних проектов, их готовность, план/факт и кто давно молчит.
 * Данные — из REST API от имени смотрящего (OAuth по клику, как в project.js).
 */

const iframe = Addon.iframe();
const api = iframe.getApiClient();
const root = document.getElementById('root');

// metric — имя метрики цели: без него подпись строки всегда была бы «Метрика».
const F = { status: 'Статус', plan: 'План', fact: 'Факт', metric: 'Что меряем' };
const STATUS_CLASS = { 'В плане': 'ok', 'Отстаёт': 'warn', 'Критичные проблемы': 'bad' };

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => n == null ? '—' : Number(n).toLocaleString('ru');

/* Разрешение спрашиваем ТОЛЬКО по клику: авто-authorize режет блокировщик попапов. */
async function ensureAuth() {
  try { await api.getAccessToken(); return; } catch (e) { /* токена ещё нет */ }
  await new Promise((resolve) => {
    root.innerHTML = `
      <div class="gate">
        <div class="gate-icon">🔐</div>
        <div class="gate-title">Нужно разовое разрешение</div>
        <p class="gate-text">Сводка читает данные Kaiten от вашего имени —
        один раз подтвердите доступ, дальше без вопросов.</p>
        <button id="auth-btn" type="button" class="primary">Разрешить и показать</button>
        <div class="gate-msg" id="auth-msg"></div>
      </div>`;
    iframe.fitSize('#root');
    document.getElementById('auth-btn').addEventListener('click', async () => {
      document.getElementById('auth-msg').textContent = 'Жду подтверждения в окне Kaiten…';
      try { await api.authorize(); resolve(); }
      catch (e) {
        document.getElementById('auth-msg').textContent =
          'Доступ не выдан: ' + ((e && e.message) || e);
      }
    });
  });
  root.innerHTML = '<div class="muted">Загружаю…</div>';
}

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
  const def = defs.find((p) => p.name === name);
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

async function render() {
  await ensureAuth();
  const card = await iframe.getCard();

  // getCard() в секции отдаёт карточку без .properties — саму цель тянем из API,
  // иначе не узнать её план по метрике (а без него не посчитать движение к цели).
  const [defs, children, self] = await Promise.all([
    api.get('/api/v1/company/custom-properties?limit=200'),
    api.get(`/api/v1/cards/${card.id}/children`),
    api.get(`/api/v1/cards/${card.id}`),
  ]);
  await loadSelectValues(api, defs, Object.values(F));

  const live = (children || []).filter((c) => c.condition === 1);
  if (!live.length) {
    root.innerHTML = '<div class="muted">Вложенных карточек пока нет. ' +
      'Кнопка «➕ Проект к этой цели» заведёт первую.</div>';
    iframe.fitSize('#root');
    return;
  }

  const n = { ok: 0, warn: 0, bad: 0, '': 0 };
  let factSum = 0, doneSum = 0, totalSum = 0;
  live.forEach((c) => {
    const cls = STATUS_CLASS[readProp(defs, c, F.status)] || '';
    n[cls]++;
    factSum  += Number(readProp(defs, c, F.fact)) || 0;
    doneSum  += c.children_done  || 0;
    totalSum += c.children_count || 0;
  });

  // ДВИЖЕНИЕ К ЦЕЛИ — две РАЗНЫЕ вещи, которые старый процесс путал:
  //  • работы — сколько задач проектов закрыто (делаем ли мы дело);
  //  • метрика — сколько из плана цели уже набрано (двигает ли это цель).
  const goalMetric = readProp(defs, self, F.metric);
  const goalPlan = Number(readProp(defs, self, F.plan)) || 0;

  // Факт берём с САМОЙ цели. Раньше суммировался факт дочерних проектов — но
  // поля «Факт» у типа «Проект» нет вовсе, поэтому сумма всегда выходила нулём,
  // и цель с заполненным Факт 30 из План 30 показывала «0 из 30».
  // Сумма по проектам остаётся запасным вариантом, если у цели факт не заполнен.
  const goalFact = readProp(defs, self, F.fact);
  const fact = goalFact != null && goalFact !== '' ? Number(goalFact) || 0 : factSum;

  const workPct = totalSum ? Math.round((doneSum / totalSum) * 100) : 0;
  const metricPct = goalPlan ? Math.round((fact / goalPlan) * 100) : null;

  const heroCls = n.bad ? 'bad' : n.warn ? 'warn' : 'ok';

  /* Ведущее число ровно одно.
   *
   * Раньше на экране цели одновременно жили три процента — «работы», «цели
   * набрано» и формульная «Готовность, %» в полях. Куратор не мог понять,
   * какому верить. Цель измеряется метрикой, а не количеством закрытых задач,
   * поэтому наверх выносится метрика; работы уходят вторым планом и прямо
   * подписаны как «делаем», а не «достигли». */
  const leadPct   = metricPct != null ? metricPct : workPct;
  const leadLabel = metricPct != null ? 'цель набрана' : 'задач закрыто';

  root.innerHTML = `
    <div class="hero ${heroCls}">
      <span class="hero-dot"></span>
      <div class="hero-main">
        <div class="hero-status">${live.length} ${live.length === 1 ? 'проект' : 'проектов'} двигают цель</div>
        <div class="hero-sub">🟢 ${n.ok} · 🟡 ${n.warn} · 🔴 ${n.bad}${n[''] ? ` · ⚪ ${n['']} без статуса` : ''}</div>
      </div>
      <div class="hero-pct"><b>${leadPct}%</b><span>${leadLabel}</span></div>
    </div>

    <div class="card">
      <div class="card-title">🎯 Движение к цели</div>
      ${goalPlan ? `
      <div class="metric">
        <div class="metric-label">${esc(goalMetric || 'Метрика')}</div>
        <div class="grow">${bar(metricPct || 0, metricPct >= 100 ? 'ok' : heroCls)}</div>
        <div class="metric-num"><b>${fmt(fact)}</b> из ${fmt(goalPlan)}</div>
      </div>
      <div class="load-foot">результат — ради него цель и ставилась</div>` : `
      <div class="load-foot">У цели не заполнен «План» по метрике — результат в цифрах не посчитать,
      виден только объём работ.</div>`}
      <div class="metric">
        <div class="metric-label">Работы по проектам</div>
        <div class="grow">${bar(workPct, heroCls)}</div>
        <div class="metric-num"><b>${doneSum}</b> из ${totalSum} задач</div>
      </div>
      <div class="load-foot">усилия — показывают, что делаем, но не что получилось</div>
      <div class="load-foot" style="margin-top:10px">
        Поле «Готовность, %» выше в карточке — третье, служебное число: доля
        <b>полностью закрытых</b> проектов. Проект, сделанный наполовину, в нём не
        виден вовсе, поэтому судить по нему о цели нельзя. Убрать его из карточки
        Kaiten не даёт: формула считается сама.
      </div>
    </div>
  `;
  iframe.fitSize('#root');
}

render().catch((e) => {
  root.innerHTML = `<div class="muted">Не удалось загрузить: ${esc(e && e.message)}</div>`;
  iframe.fitSize('#root');
});
