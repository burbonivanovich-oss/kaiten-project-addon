/* ТОЧКА ВХОДА АДДОНА.
 *
 * Kaiten грузит index.html в скрытый iframe и вызывает Addon.initialize.
 * Здесь мы говорим: «я умею рисовать вот это в вот этих местах».
 *
 *   card_facade_badges — плашки на лицевой стороне карточки НА ДОСКЕ
 *   card_body_section  — свой экран внутри открытой карточки
 *   card_buttons       — своя кнопка в карточке
 *
 * Проект — «Ход проекта», отчёт, сводка. Цель/Направление — сводка по
 * вложенным и быстрое заведение проекта. На задачах аддон молчит —
 * иначе он замусорит доски команд.
 */

// Временная отладка: шлём вехи в родительское окно, чтобы их было видно
// из консоли хоста (удалить после стабилизации).
var DBG = [];
function dbg(step, extra) {
  DBG.push(step + (extra ? ' ' + JSON.stringify(extra) : ''));
  try { window.parent.postMessage({ type: 'ADDON_DEBUG', step, extra: extra || null }, '*'); } catch (e) {}
}
var _n = 0;
var _t = setInterval(function () {
  if (++_n > 15) return clearInterval(_t);
  try { window.parent.postMessage({ type: 'ADDON_DEBUG_BULK', log: DBG.slice() }, '*'); } catch (e) {}
}, 2000);
dbg('client.js loaded', { hasAddon: typeof Addon !== 'undefined' });

// Дефолты для ЭТОЙ инсталляции Kaiten. Каждое значение можно переопределить
// в настройках аддона на пространстве (страница settings.html) — тогда
// хардкод не мешает переносу в другую компанию.
const DEFAULTS = {
  project_type_ids: [696186],   // тип «Проект»
  goal_type_ids: [696185],      // тип «Цель»
  direction_type_ids: [696272], // тип «Направление»
  new_project_board_id: 1833089, // доска «Проекты» — форма кладёт проекты сюда,
                                 // с какой бы карточки её ни открыли; null = доска карточки
  silent_days: 14,              // порог «молчим» для бейджа
};

// База страниц аддона: signUrl/openPopup резолвят пути не от /views/, поэтому абсолютно.
const BASE = 'https://burbonivanovich-oss.github.io/kaiten-project-addon/views/';
// Контекст Kaiten передаёт во фрагменте (#…), а не в query — HTML страниц кэшируется
// браузером на 10 минут. Версия в query ломает кэш; поднимать при каждой правке страниц.
const PAGE_V = 'v=9';

// Поля ищем ПО ИМЕНИ, а не по id: id в каждой компании свои.
const F = { status: 'Статус' };

// Цвета для плашек. Тут hex, а не индексы палитры Kaiten — это наша отрисовка.
const STATUS_COLOR = {
  'В плане': '#1D9E75',
  'Отстаёт': '#EF9F27',
  'Критичные проблемы': '#E24B4A',
};

// Настройки пространства поверх дефолтов. getSettings отдаёт МАССИВ
// (по пространствам, [0] — текущее); может быть пуст — тогда живём на дефолтах.
async function getCfg(ctx) {
  let s = null;
  try {
    const all = await ctx.getSettings();
    s = Array.isArray(all) ? all[0] : all;
  } catch (e) { dbg('getSettings failed'); }
  const cfg = Object.assign({}, DEFAULTS);
  if (s && typeof s === 'object') {
    for (const k of Object.keys(DEFAULTS)) {
      if (s[k] != null && s[k] !== '') cfg[k] = s[k];
    }
  }
  return cfg;
}

function typeId(card) {
  return card ? (card.type_id || card.card_type_id || (card.type && card.type.id)) : null;
}
const isProject = (cfg, card) => cfg.project_type_ids.indexOf(typeId(card)) !== -1;
const isGoal = (cfg, card) => cfg.goal_type_ids.indexOf(typeId(card)) !== -1;
const isDirection = (cfg, card) => cfg.direction_type_ids.indexOf(typeId(card)) !== -1;

function pageUrl(name, params) {
  return BASE + name + '?' + PAGE_V + (params ? '&' + params : '');
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

function silentDays(card) {
  const iso = card.comment_last_added_at || card.created;
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

dbg('before Addon.initialize');
var initResult = Addon.initialize({
  /* 1. БЕЙДЖИ НА ДОСКЕ — светофор, процент и «молчим», не открывая карточку.
     Никаких API-вызовов: только то, что уже есть в объекте карточки. */
  card_facade_badges: async (ctx) => {
    dbg('card_facade_badges called');
    try {
    const card = await ctx.getCard();
    const cfg = await getCfg(ctx);
    if (!isProject(cfg, card)) return [];

    const { done, total, pct } = progress(card);
    const status = await propValue(ctx, card, F.status);
    const badges = [];

    if (status) badges.push({ text: status, color: STATUS_COLOR[status] || '#888780' });
    if (total) badges.push({ text: `${pct}% · ${done}/${total}` });

    // тухнущий проект видно с доски: комментариев не было дольше порога
    const silent = silentDays(card);
    if (silent != null && silent >= cfg.silent_days && card.state !== 3) {
      badges.push({ text: `🔇 молчим ${silent} дн`, color: '#E24B4A' });
    }
    dbg('badges result ' + badges.length);
    return badges;
    } catch (e) { dbg('badges ERROR ' + (e && e.message)); return []; }
  },

  /* 2. СЕКЦИИ внутри карточки.
     Проект — «Ход проекта». Цель/Направление — сводка по вложенным.
     signUrl обязателен: он подписывает адрес, иначе страница не получит контекст. */
  card_body_section: async (ctx) => {
    dbg('card_body_section called');
    try {
      const card = await ctx.getCard();
      const cfg = await getCfg(ctx);
      if (isProject(cfg, card)) {
        return [{
          title: 'Ход проекта',
          content: { type: 'iframe', url: ctx.signUrl(pageUrl('project.html')), height: 460 },
        }];
      }
      if (isGoal(cfg, card) || isDirection(cfg, card)) {
        return [{
          title: isDirection(cfg, card) ? 'Сводка направления' : 'Проекты этой цели',
          content: { type: 'iframe', url: ctx.signUrl(pageUrl('goal.html')), height: 420 },
        }];
      }
      dbg('body: not our type');
      return [];
    } catch (e) { dbg('body ERROR ' + (e && e.message)); return []; }
  },

  /* 3. КНОПКИ. */
  card_buttons: async (ctx) => {
    dbg('card_buttons called');
    try {
    const card = await ctx.getCard();
    const cfg = await getCfg(ctx);

    let perms = null;
    try { perms = ctx.getPermissions(); } catch (pe) { dbg('perms error ' + (pe && pe.message)); }
    if (perms && perms.card && perms.card.update === false) return [];

    const buttons = [];
    const proj = isProject(cfg, card);
    const goal = isGoal(cfg, card);
    const dir = isDirection(cfg, card);

    // Формы открываем ЦЕНТРИРОВАННОЙ МОДАЛКОЙ (openDialog), а не openPopup:
    // попап прибит к кнопке, имеет фиксированную высоту и режет контент.
    if (proj) {
      buttons.push({
        text: '📝 Отчёт за 2 недели',
        callback: (c) => c.openDialog({
          title: 'Отчёт по проекту', url: pageUrl('report.html'), width: 'sm',
        }),
      });
    }

    if (goal) {
      // цель-родитель предзаполнена — заведение проекта прямо с цели
      buttons.push({
        text: '➕ Проект к этой цели',
        callback: (c) => c.openDialog({
          title: 'Новый проект', url: pageUrl('new-project.html', 'goal=' + card.id),
          width: 'sm',
        }),
      });
    }

    if (proj || /ШАБЛОН/.test(card.title || '')) {
      buttons.push({
        text: '🆕 Создать проект',
        callback: (c) => c.openDialog({
          title: 'Новый проект', url: pageUrl('new-project.html'), width: 'sm',
        }),
      });
    }

    if (proj || goal || dir) {
      buttons.push({
        text: '📋 Сводка для руководства',
        callback: (c) => c.openDialog({
          title: 'Сводка для руководства', url: pageUrl('summary.html'), width: 'md',
        }),
      });
    }

    dbg('buttons result ' + buttons.length);
    return buttons;
    } catch (e) { dbg('buttons ERROR ' + (e && e.message)); return []; }
  },

  /* 4. НАСТРОЙКИ — попап при подключении аддона к пространству
     (контракт из примера вендора kaiten-test-addon). */
  settings: (ctx) => {
    dbg('settings called');
    return ctx.openPopup({
      type: 'iframe',
      title: 'Настройки «Страницы проекта»',
      url: pageUrl('settings.html'),
      width: 480,
      height: 520,
    });
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
