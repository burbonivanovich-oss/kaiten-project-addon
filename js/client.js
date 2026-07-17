/* ТОЧКА ВХОДА АДДОНА.
 *
 * Kaiten грузит index.html в скрытый iframe и вызывает Addon.initialize.
 * Здесь мы говорим: «я умею рисовать вот это в вот этих местах».
 *
 *   card_facade_badges — плашки на лицевой стороне карточки НА ДОСКЕ
 *   card_body_section  — свой экран внутри открытой карточки
 *   card_buttons       — своя кнопка в карточке
 *
 * Всё это включается ТОЛЬКО на карточках типа «Проект». На задачах аддон
 * молчит — иначе он замусорит доски команд.
 */

// Временная отладка: шлём вехи в родительское окно, чтобы их было видно
// из консоли хоста (удалить после стабилизации).
var DBG = [];
function dbg(step, extra) {
  DBG.push(step + (extra ? ' ' + JSON.stringify(extra) : ''));
  try { window.parent.postMessage({ type: 'ADDON_DEBUG', step, extra: extra || null }, '*'); } catch (e) {}
}
// переотправляем буфер 30 секунд, чтобы поймать вехи чистой загрузки
var _n = 0;
var _t = setInterval(function () {
  if (++_n > 15) return clearInterval(_t);
  try { window.parent.postMessage({ type: 'ADDON_DEBUG_BULK', log: DBG.slice() }, '*'); } catch (e) {}
}, 2000);
dbg('client.js loaded', { hasAddon: typeof Addon !== 'undefined' });
window.addEventListener('message', function (e) {
  try {
    if (e.data && e.data.type === 'ADDON_DEBUG') return;
    var d = typeof e.data === 'object' ? JSON.stringify(e.data) : String(e.data);
    dbg('incoming: ' + String(d).slice(0, 160));
  } catch (err) {}
});

const PROJECT_TYPE = 'Проект';
// id типа «Проект» в этой инсталляции Kaiten (SDK отдаёт карточку без объекта type).
// При переносе аддона в другую компанию поменяйте на её id (GET /card-types).
const PROJECT_TYPE_IDS = [696186];
// База страниц аддона: signUrl/openPopup резолвят пути не от /views/, поэтому абсолютно.
const BASE = 'https://burbonivanovich-oss.github.io/kaiten-project-addon/views/';

// Поля ищем ПО ИМЕНИ, а не по id: id в каждой компании свои.
const F = { status: 'Статус', metric: 'Метрика', plan: 'План', fact: 'Факт' };

// Цвета для плашек. Тут hex, а не индексы палитры Kaiten — это наша отрисовка.
const STATUS_COLOR = {
  'В плане': '#1D9E75',
  'Отстаёт': '#EF9F27',
  'Критичные проблемы': '#E24B4A',
};

async function isProject(ctx, card) {
  if (!card) return false;
  const t = card.type;
  if (t && (t.name === PROJECT_TYPE || t.letter === 'П')) return true;
  const id = card.type_id || card.card_type_id || (t && t.id);
  return !!id && PROJECT_TYPE_IDS.indexOf(id) !== -1;
}

function progress(card) {
  const total = card.children_count || 0;
  const done = card.children_done || 0;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

async function propValue(ctx, card, name) {
  const props = await ctx.getCardProperties();
  const def = (props || []).find((p) => p.name === name);
  if (!def) return null;
  const raw = (card.properties || {})[`id_${def.id}`];
  if (raw == null) return null;
  if (Array.isArray(raw)) {
    const v = (def.values || []).find((x) => x.id === raw[0] || x.uid === raw[0]);
    return v ? (v.value || v.display_value) : null;
  }
  return raw;
}

dbg('before Addon.initialize');
var initResult = Addon.initialize({
  /* 1. БЕЙДЖИ НА ДОСКЕ — светофор и процент, не открывая карточку. */
  card_facade_badges: async (ctx) => {
    dbg('card_facade_badges called');
    try {
    const card = await ctx.getCard();
    if (!(await isProject(ctx, card))) return [];

    const { done, total, pct } = progress(card);
    const status = await propValue(ctx, card, F.status);
    const badges = [];

    if (status) badges.push({ text: status, color: STATUS_COLOR[status] || '#888780' });
    if (total) badges.push({ text: `${pct}% · ${done}/${total}` });
    dbg('badges result ' + badges.length);
    return badges;
    } catch (e) { dbg('badges ERROR ' + (e && e.message)); return []; }
  },

  /* 2. СТРАНИЦА ПРОЕКТА внутри карточки.
     signUrl обязателен: он подписывает адрес, иначе страница не получит контекст. */
  card_body_section: async (ctx) => {
    dbg('card_body_section called');
    try {
      const card = await ctx.getCard();
      if (!(await isProject(ctx, card))) { dbg('body: not a project'); return []; }
      const url = ctx.signUrl(BASE + 'project.html');
      dbg('body signUrl ok: ' + String(url).slice(0, 60));
      return [{
        title: 'Ход проекта',
        content: { type: 'iframe', url: url, height: 460 },
      }];
    } catch (e) { dbg('body ERROR ' + (e && e.message)); return []; }
  },

  /* 3. КНОПКИ — отчёт и быстрое заведение нового проекта. */
  card_buttons: async (ctx) => {
    dbg('card_buttons called');
    try {
    const card = await ctx.getCard();

    let perms = null;
    try { perms = ctx.getPermissions(); } catch (pe) { dbg('perms error ' + (pe && pe.message)); }
    if (perms && perms.card && perms.card.update === false) return [];

    const buttons = [];

    if (await isProject(ctx, card)) {
      buttons.push({
        text: '📝 Отчёт за 2 недели',
        callback: (btnCtx) => btnCtx.openPopup({
          title: 'Отчёт по проекту',
          url: BASE + 'report.html',
          width: 460,
          height: 560,
        }),
      });
    }

    // «Создать проект» видна на проектах и на карточке-шаблоне «⚡ ШАБЛОН…»
    if ((await isProject(ctx, card)) || /ШАБЛОН/.test(card.title || '')) {
      buttons.push({
        text: '🆕 Создать проект',
        callback: (btnCtx) => btnCtx.openPopup({
          title: 'Новый проект',
          url: BASE + 'new-project.html',
          width: 460,
          height: 520,
        }),
      });
    }

    dbg('buttons result ' + buttons.length);
    return buttons;
    } catch (e) { dbg('buttons ERROR ' + (e && e.message)); return []; }
  },
});

if (initResult && typeof initResult.then === 'function') {
  initResult.then(
    function (r) { dbg('initialize RESOLVED', r || true); },
    function (e) { dbg('initialize REJECTED', (e && e.message) || String(e)); }
  );
} else {
  dbg('initialize returned non-promise', typeof initResult);
}
