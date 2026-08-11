/* ФОРМА ОТЧЁТА — аналог Asana Status Update.
 *
 * Смысл: сейчас отчёт — это ТРИ отдельных действия (написать комментарий,
 * поменять статус, обновить факт). Поэтому их и не делают.
 * Здесь одна кнопка делает всё сразу и двигает дату следующего отчёта на +14.
 *
 * Чего тут ЧЕСТНО нет по сравнению с Asana: снимок данных не замораживается,
 * и комментарий потом можно отредактировать. Это ограничение Kaiten, не моё:
 * объекта «статус-апдейт» в нём просто не существует.
 */

const iframe = Addon.iframe();
const api = iframe.getApiClient();

const F = { status: 'Статус', metric: 'Что меряем', fact: 'Факт', nextReport: 'Когда отчитаться',
            // 4DX: отстающий показатель («Факт») говорит о прошлом, опережающий —
            // это то, на что можно повлиять до того, как результат сложится.
            leadName: 'Опережающий показатель', leadFact: 'Опережающий: факт' };

let chosen = null, card = null, defs = [];
const $ = (id) => document.getElementById(id);
const msg = (t) => { $('msg').textContent = t || ''; };
const def = (name) => defs.find((p) => p.name === name);

/* Значения select-полей приходится догружать отдельно.
 *
 * GET /company/custom-properties отдаёт определения БЕЗ ключа values — ни один
 * параметр (with_values, include, expand) этого не меняет, проверено. Здесь это
 * было хуже всего: selectValueId не находил id значения статуса, props оставался
 * без него, и «Опубликовать» молча сохраняло отчёт БЕЗ статуса. Пользователь
 * видел «Готово», а светофор не двигался.
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

function selectValueId(name, value) {
  const d = def(name);
  const v = d && (d.values || []).find((x) => x.value === value);
  return v ? v.id : null;
}

// Модалка и попап закрываются разными командами — пробуем обе.
function closeSelf() {
  try { iframe.closeDialog(); } catch (e) { try { iframe.closePopup(); } catch (e2) {} }
}

/* Разрешение спрашиваем ТОЛЬКО по клику — авто-authorize режет блокировщик попапов.
   Пока токена нет, форма спрятана и виден только гейт. */
async function ensureAuth() {
  try { await api.getAccessToken(); return; } catch (e) { /* токена ещё нет */ }
  const form = document.getElementById('report');
  form.style.display = 'none';
  await new Promise((resolve) => {
    const gate = document.createElement('div');
    gate.className = 'gate';
    gate.innerHTML = `
      <div class="gate-icon">🔐</div>
      <div class="gate-title">Нужно разовое разрешение</div>
      <p class="gate-text">Отчёт публикуется от вашего имени, поэтому Kaiten
      один раз спросит, доверяете ли вы аддону. Дальше — без вопросов.</p>
      <button id="auth-btn" type="button" class="primary">Разрешить доступ</button>
      <div class="gate-msg" id="auth-msg"></div>`;
    document.body.prepend(gate);
    iframe.fitSize('.gate');   // без селектора модалка не растёт — меряем сам гейт
    gate.querySelector('#auth-btn').addEventListener('click', async () => {
      gate.querySelector('#auth-msg').textContent = 'Жду подтверждения в окне Kaiten…';
      try { await api.authorize(); gate.remove(); resolve(); }
      catch (e) {
        gate.querySelector('#auth-msg').textContent =
          'Доступ не выдан: ' + ((e && e.message) || e);
      }
    });
  });
  form.style.display = '';
}

async function init() {
  await ensureAuth();
  // Форму показываем ДО загрузки справочников. Пока fitSize стоял только в
  // конце init, модалка не получала высоту и всё это время была пустым серым
  // прямоугольником — без единого слова о том, что идёт загрузка.
  iframe.fitSize('#report');
  card = await iframe.getCard();
  defs = await api.get('/api/v1/company/custom-properties?limit=200');
  await loadSelectValues(api, defs, [F.status, F.metric]);

  // подсказать, какую метрику вообще просят
  const md = def(F.metric);
  if (md) {
    const raw = (card.properties || {})[`id_${md.id}`];
    const cur = Array.isArray(raw)
      ? (md.values || []).find((x) => x.id === raw[0] || x.uid === raw[0]) : null;
    if (cur) $('metric-hint').textContent = '· ' + (cur.value || cur.display_value || '');
  }

  // Опережающий показатель: если у проекта он уже назван — подписываем поле.
  // Если нет — просим назвать здесь же, чтобы это не требовало отдельного захода.
  const ld = def(F.leadName);
  const leadName = ld ? (card.properties || {})[`id_${ld.id}`] : null;
  if (leadName) {
    $('lead-hint').textContent = '· ' + leadName;
  } else {
    $('lead-empty').style.display = '';
    $('lead-name').style.display  = '';
  }

  $('statuses').addEventListener('click', (e) => {
    const b = e.target.closest('.st');
    if (!b) return;
    chosen = b.dataset.v;
    [...document.querySelectorAll('.st')].forEach((x) => x.classList.toggle('on', x === b));
  });

  $('submit').addEventListener('click', submit);
  requestAnimationFrame(() => iframe.fitSize('#report'));
}

async function submit() {
  if (!chosen) return msg('Выберите статус');
  $('submit').disabled = true;
  msg('Публикую…');

  // Опережающий показатель кладём и в комментарий: тогда его динамика видна
  // в истории отчётов, а не только последним значением в поле.
  const ldName = $('lead-name').value.trim()
    || ($('lead-hint').textContent || '').replace(/^·\s*/, '').trim();
  const ldVal  = $('lead-fact').value.trim();

  const text = [
    `**Отчёт за 2 недели — ${chosen}**`, '',
    `**Что сделали:** ${$('done').value.trim() || '—'}`,
    `**Что дальше:** ${$('next').value.trim() || '—'}`,
    `**Риски:** ${$('risks').value.trim() || '—'}`,
    ...(ldVal !== '' ? [`**${ldName || 'Опережающий показатель'}:** ${ldVal}`] : []),
  ].join('\n');

  try {
    await api.post(`/api/v1/cards/${card.id}/comments`, { text });

    const props = {};
    const sid = selectValueId(F.status, chosen);
    if (sid) props[`id_${def(F.status).id}`] = [sid];

    const factVal = $('fact').value.trim();
    if (factVal !== '' && def(F.fact)) props[`id_${def(F.fact).id}`] = Number(factVal);

    const leadVal = $('lead-fact').value.trim();
    if (leadVal !== '' && def(F.leadFact)) props[`id_${def(F.leadFact).id}`] = Number(leadVal);

    const leadNm = $('lead-name').value.trim();
    if (leadNm !== '' && def(F.leadName)) props[`id_${def(F.leadName).id}`] = leadNm;

    if (def(F.nextReport)) {
      const d = new Date(Date.now() + 14 * 86400000);
      props[`id_${def(F.nextReport).id}`] =
        { date: d.toISOString().slice(0, 10), time: '10:00:00', tzOffset: 180 };
    }

    if (Object.keys(props).length) {
      await api.patch(`/api/v1/cards/${card.id}`, { properties: props });
    }

    msg('Готово');
    iframe.showSnackbar('Отчёт опубликован', 'success');
    closeSelf();
  } catch (e) {
    $('submit').disabled = false;
    msg('Ошибка: ' + (e && e.message ? e.message : 'не удалось опубликовать'));
  }
}

init().catch((e) => msg('Не удалось открыть: ' + (e && e.message)));
