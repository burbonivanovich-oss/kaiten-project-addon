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

const F = { status: 'Статус', metric: 'Метрика', fact: 'Факт', nextReport: 'Следующий отчёт' };

let chosen = null, card = null, defs = [];
const $ = (id) => document.getElementById(id);
const msg = (t) => { $('msg').textContent = t || ''; };
const def = (name) => defs.find((p) => p.name === name);

function selectValueId(name, value) {
  const d = def(name);
  const v = d && (d.values || []).find((x) => x.value === value);
  return v ? v.id : null;
}

async function ensureAuth() {
  try { await api.getAccessToken(); } catch { await api.authorize(); }
}

async function init() {
  await ensureAuth();
  card = await iframe.getCard();
  defs = await api.get('/api/v1/company/custom-properties?limit=200');

  // подсказать, какую метрику вообще просят
  const md = def(F.metric);
  if (md) {
    const raw = (card.properties || {})[`id_${md.id}`];
    const cur = Array.isArray(raw)
      ? (md.values || []).find((x) => x.id === raw[0] || x.uid === raw[0]) : null;
    if (cur) $('metric-hint').textContent = '· ' + (cur.value || cur.display_value || '');
  }

  $('statuses').addEventListener('click', (e) => {
    const b = e.target.closest('.st');
    if (!b) return;
    chosen = b.dataset.v;
    [...document.querySelectorAll('.st')].forEach((x) => x.classList.toggle('on', x === b));
  });

  $('submit').addEventListener('click', submit);
  iframe.fitSize('#report');
}

async function submit() {
  if (!chosen) return msg('Выберите статус');
  $('submit').disabled = true;
  msg('Публикую…');

  const text = [
    `**Отчёт за 2 недели — ${chosen}**`, '',
    `**Что сделали:** ${$('done').value.trim() || '—'}`,
    `**Что дальше:** ${$('next').value.trim() || '—'}`,
    `**Риски:** ${$('risks').value.trim() || '—'}`,
  ].join('\n');

  try {
    await api.post(`/api/v1/cards/${card.id}/comments`, { text });

    const props = {};
    const sid = selectValueId(F.status, chosen);
    if (sid) props[`id_${def(F.status).id}`] = [sid];

    const factVal = $('fact').value.trim();
    if (factVal !== '' && def(F.fact)) props[`id_${def(F.fact).id}`] = Number(factVal);

    if (def(F.nextReport)) {
      const d = new Date(Date.now() + 14 * 86400000);
      props[`id_${def(F.nextReport).id}`] =
        { date: d.toISOString().slice(0, 10), time: '10:00:00', tzOffset: 180 };
    }

    if (Object.keys(props).length) {
      await api.patch(`/api/v1/cards/${card.id}`, { properties: props });
    }

    msg('Готово');
    iframe.closePopup();
  } catch (e) {
    $('submit').disabled = false;
    msg('Ошибка: ' + (e && e.message ? e.message : 'не удалось опубликовать'));
  }
}

init().catch((e) => msg('Не удалось открыть: ' + (e && e.message)));
