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
function dbg(step, extra) {
  try { window.parent.postMessage({ type: 'ADDON_DEBUG', step, extra: extra || null }, '*'); } catch (e) {}
}
dbg('client.js loaded', { hasAddon: typeof Addon !== 'undefined' });
window.addEventListener('message', function (e) {
  try {
    if (e.data && e.data.type === 'ADDON_DEBUG') return;
    var d = typeof e.data === 'object' ? JSON.stringify(e.data) : String(e.data);
    dbg('incoming: ' + String(d).slice(0, 160));
  } catch (err) {}
});

const PROJECT_TYPE = 'Проект';

// Поля ищем ПО ИМЕНИ, а не по id: id в каждой компании свои.
const F = { status: 'Статус', metric: 'Метрика', plan: 'План', fact: 'Факт' };

// Цвета для плашек. Тут hex, а не индексы палитры Kaiten — это наша отрисовка.
const STATUS_COLOR = {
  'В плане': '#1D9E75',
  'Отстаёт': '#EF9F27',
  'Критичные проблемы': '#E24B4A',
};

function isProject(card) {
  const t = card && card.type;
  return !!t && (t.name === PROJECT_TYPE || t.letter === 'П');
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
Addon.initialize({
  /* 1. БЕЙДЖИ НА ДОСКЕ — светофор и процент, не открывая карточку. */
  card_facade_badges: async (ctx) => {
    dbg('card_facade_badges called');
    const card = await ctx.getCard();
    if (!isProject(card)) return [];

    const { done, total, pct } = progress(card);
    const status = await propValue(ctx, card, F.status);
    const badges = [];

    if (status) badges.push({ text: status, color: STATUS_COLOR[status] || '#888780' });
    if (total) badges.push({ text: `${pct}% · ${done}/${total}` });
    return badges;
  },

  /* 2. СТРАНИЦА ПРОЕКТА внутри карточки.
     signUrl обязателен: он подписывает адрес, иначе страница не получит контекст. */
  card_body_section: async (ctx) => {
    dbg('card_body_section called');
    const card = await ctx.getCard();
    if (!isProject(card)) return [];

    return [{
      title: 'Ход проекта',
      content: { type: 'iframe', url: ctx.signUrl('./project.html'), height: 460 },
    }];
  },

  /* 3. КНОПКИ — отчёт и быстрое заведение нового проекта. */
  card_buttons: async (ctx) => {
    dbg('card_buttons called');
    const card = await ctx.getCard();

    const perms = ctx.getPermissions();
    if (perms && perms.card && perms.card.update === false) return [];

    const buttons = [];

    if (isProject(card)) {
      buttons.push({
        text: '📝 Отчёт за 2 недели',
        callback: (btnCtx) => btnCtx.openPopup({
          title: 'Отчёт по проекту',
          url: './report.html',
          width: 460,
          height: 560,
        }),
      });
    }

    // «Создать проект» видна на проектах и на карточке-шаблоне «⚡ ШАБЛОН…»
    if (isProject(card) || /ШАБЛОН/.test(card.title || '')) {
      buttons.push({
        text: '🆕 Создать проект',
        callback: (btnCtx) => btnCtx.openPopup({
          title: 'Новый проект',
          url: './new-project.html',
          width: 460,
          height: 520,
        }),
      });
    }

    return buttons;
  },
});
