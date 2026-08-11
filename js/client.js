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

// dbg — no-op (отладка снята после стабилизации). Оставлен пустым, чтобы не
// вычищать вызовы по всему файлу; ничего не шлёт и не логирует.
function dbg() {}

// Дефолты для ЭТОЙ инсталляции Kaiten. Каждое значение можно переопределить
// в настройках аддона на пространстве (страница settings.html) — тогда
// хардкод не мешает переносу в другую компанию.
const DEFAULTS = {
  // id аккаунта artempdirect3.kaiten.ru (сверено с живым API 2026-08-07).
  project_type_ids: [705580],   // тип «Проект»
  goal_type_ids: [705577],      // тип «Цель»
  direction_type_ids: [705579], // тип «Направление»
  task_type_ids: [705578],      // тип «Задача»
  hypothesis_type_ids: [705581], // тип «Гипотеза»
  new_project_board_id: 1853650, // доска «Обзор проектов» в «2 · Портфель проектов» —
                                 // форма кладёт проекты сюда; null = доска карточки
  functions_space_id: 825695,   // пространство «3 · Работа команд» — доски-функцзоны
  silent_days: 14,              // порог «молчим» для бейджа
};

// База страниц аддона: signUrl/openPopup резолвят пути не от /views/, поэтому абсолютно.
const BASE = 'https://burbonivanovich-oss.github.io/kaiten-project-addon/views/';
// Контекст Kaiten передаёт во фрагменте (#…), а не в query — HTML страниц кэшируется
// браузером на 10 минут. Версия в query ломает кэш; поднимать при каждой правке страниц.
const PAGE_V = 'v=43';

// Поля ищем ПО ИМЕНИ, а не по id: id в каждой компании свои.
const F = { status: 'Статус' };

/* Цвет бейджа — ENUM, а не hex.
 *
 * Документация (developers.kaiten.ru/addons/capabilities/card-facade-badges)
 * разрешает ровно три значения — green, red, orange — плюс отсутствие ключа
 * для цвета по умолчанию. Здесь раньше стояли hex-коды и комментарий
 * «это наша отрисовка»: предположение оказалось неверным, отрисовка не наша.
 * Kaiten молча не рисовал такие бейджи — на доске портфеля не появлялось
 * НИ ОДНОГО, включая те, у которых цвета не было вовсе.
 *
 * Ключ color не ставим вообще, если цвет нейтральный: undefined в значении и
 * отсутствие ключа — не одно и то же для валидатора.
 */
const BADGE_GREEN = 'green', BADGE_RED = 'red', BADGE_ORANGE = 'orange';

const STATUS_COLOR = {
  'В плане': BADGE_GREEN,
  'Отстаёт': BADGE_ORANGE,
  'Критичные проблемы': BADGE_RED,
};

// Собирает бейдж, опуская color, когда он не задан.
function badge(text, color) {
  return color ? { text, color } : { text };
}

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
const isTask = (cfg, card) => cfg.task_type_ids.indexOf(typeId(card)) !== -1;
const isHypothesis = (cfg, card) => cfg.hypothesis_type_ids.indexOf(typeId(card)) !== -1;

function pageUrl(name, params) {
  return BASE + name + '?' + PAGE_V + (params ? '&' + params : '');
}

function progress(card) {
  const total = card.children_count || 0;
  const done = card.children_done || 0;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

// Читает значение свойства из УЖЕ полученного массива props (без round-trip).
function readVal(props, card, name) {
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

async function propValue(ctx, card, name) {
  const props = await ctx.getCardProperties();
  return readVal(props, card, name);
}

/* Чтение свойства для БЕЙДЖЕЙ — отдельно и «мягко».
 *
 * getCardProperties() в контексте секции бросает «Unknown subject» (см. коммент
 * в card_body_section). В контексте бейджей он вёл себя так же: на живой доске
 * не появлялось НИ ОДНОГО бейджа — ни статуса, ни процента, ни «молчим», хотя
 * последние два считаются из самой карточки и свойств не требуют. Причина в
 * том, что статус читался ПЕРВЫМ, а общий catch возвращал пустой список,
 * унося с собой всё остальное.
 *
 * Поэтому: своя обёртка, свой catch и таймаут. Зависший мост тоже не должен
 * стоить доске всех бейджей — лучше доска без статуса, чем доска без ничего. */
function softProp(ctx, card, name, ms) {
  return Promise.race([
    propValue(ctx, card, name).catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), ms || 2500)),
  ]).catch(() => null);
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
    /* ПРОВЕРЕНО 11.08.2026 двумя зондами на живой доске портфеля.
     *
     * Зонд 1: безусловный `return [{ text: 'ЗОНД' }]` — не отрисовался.
     * Зонд 2: безусловный `return { text: 'ЗОНД2', color: 'green' }` (одиночный
     * объект, как в примерах документации) — тоже не отрисовался.
     *
     * Значит форма ответа ни при чём и кодом бейджи не чинятся. Проверено и
     * исключено также: запись аддона на сервере (GET /spaces/{id}/addons отдаёт
     * capabilities с card_facade_badges во всех 12 пространствах), статус,
     * коннектор, email владельца, кэш. iframe аддона на странице доски
     * загружается — то есть аддон работает, не работает именно эта точка.
     *
     * Цвета приведены к enum (green/red/orange) по документации: на hex они не
     * появились бы и после починки причины, какой бы та ни оказалась. */
    try {
    const card = await ctx.getCard();
    const cfg = await getCfg(ctx);

    // ЗАДАЧА — привязка к проекту и оценка
    if (isTask(cfg, card)) {
      const badges = [];
      // parent_id Kaiten не заполняет никогда — привязка видна в parents_count.
      // Синего в палитре бейджей нет, поэтому просто без цвета.
      if (card.parents_count) badges.push(badge('📁 Проект'));
      if (card.estimate_workload) badges.push(badge(card.estimate_workload + ' ч'));
      return badges;
    }

    // ЦЕЛЬ — прогресс вложенных проектов
    if (isGoal(cfg, card)) {
      const { done, total, pct } = progress(card);
      if (!total) return [];
      return [badge(`${done}/${total} проектов · ${pct}%`)];
    }

    if (!isProject(cfg, card)) return [];

    // ПРОЕКТ — статус, прогресс, «молчим».
    // Порядок сборки важен: сначала всё, что считается из самой карточки,
    // и только потом статус, за которым надо идти к мосту.
    const { done, total, pct } = progress(card);
    const silent = silentDays(card);

    const badges = [];
    if (total) badges.push(badge(`${pct}% · ${done}/${total}`));

    // тухнущий проект видно с доски: комментариев не было дольше порога
    if (silent != null && silent >= cfg.silent_days && card.state !== 3) {
      badges.push(badge(`🔇 молчим ${silent} дн`, BADGE_RED));
    }

    // Авто-эскалация: объективный сигнал о риске независимо от ручного статуса
    if (card.due_date && total > 0 && card.state !== 3) {
      const start = new Date(card.created_at || card.created || 0);
      const due   = new Date(card.due_date);
      const now   = new Date();
      const totalMs = due - start;
      if (totalMs > 0) {
        const timePct = Math.min(Math.round(((now - start) / totalMs) * 100), 100);
        const gap = timePct - pct;
        if (now > due && pct < 100) {
          badges.push(badge('🚨 просрочен', BADGE_RED));
        } else if (gap >= 40) {
          badges.push(badge(`⏰ план ${timePct}% · факт ${pct}%`, BADGE_RED));
        } else if (gap >= 20) {
          badges.push(badge(`⏰ ${timePct}% срока → ${pct}%`, BADGE_ORANGE));
        }
      }
    }

    // Статус — последним и «мягко»: если мост свойств не ответит, доска
    // всё равно покажет процент, «молчим» и эскалацию.
    const status = await softProp(ctx, card, F.status);
    if (status) badges.unshift(badge(status, STATUS_COLOR[status]));

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
        // Простая секция: НИКАКИХ getCardProperties здесь — в card_body_section
        // он бросает «Unknown subject» и роняет секцию. Статус/метрику читает
        // сам iframe секции (project.js) своими SDK-методами.
        return [{
          title: 'Ход проекта',
          // Высота ЗАЯВЛЕННАЯ, а не итоговая: fitSize внутри iframe её потом
          // подгоняет. Но пока он не сработал, лишнее обрезается без полосы
          // прокрутки — на живом проекте с семью задачами при height:460
          // «Задачи по командам» показывали заголовок и ни одной строки.
          // Ставим с запасом: пустое место внизу дешевле невидимого списка.
          content: { type: 'iframe', url: ctx.signUrl(pageUrl('project.html')), height: 900 },
        }];
      }
      if (isGoal(cfg, card) || isDirection(cfg, card)) {
        return [{
          title: isDirection(cfg, card) ? 'Сводка направления' : 'Проекты этой цели',
          content: { type: 'iframe', url: ctx.signUrl(pageUrl('goal.html')), height: 620 },
        }];
      }
      if (isHypothesis(cfg, card)) {
        // конвертация идеи в проект или задачу
        return [{
          title: 'Оформить идею',
          // 240 хватало на две кнопки; теперь сверху чек-лист формулировки,
          // а под ним могут встать сразу две плашки — приоритет и разброс голосов.
          content: { type: 'iframe', url: ctx.signUrl(pageUrl('convert.html')), height: 620 },
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
    // Права режем покнопочно, а не списком целиком: куратор по ТЗ не правит
    // карточки, но обязан видеть сводку — раньше он не получал вообще ничего.
    const canWrite = !(perms && perms.card && perms.card.update === false);

    const buttons = [];
    const proj = isProject(cfg, card);
    const goal = isGoal(cfg, card);
    const dir = isDirection(cfg, card);

    /* Действия разложены по уровням, а не свалены в один ряд.
     *
     * Было шесть равнозначных кнопок на проекте: главное действие не отличалось
     * от редкого, а «Создать проект» вообще не относится к текущему проекту.
     * Теперь на карточке не больше трёх, и каждая отвечает роли этого уровня:
     *   проект (машинист)  — поставить задачу, отчитаться, посмотреть загрузку;
     *   цель (куратор)     — завести проект, свести для руководства, обзор;
     *   направление        — только чтение.
     *
     * Формы открываем ЦЕНТРИРОВАННОЙ МОДАЛКОЙ (openDialog), а не openPopup:
     * попап прибит к кнопке, имеет фиксированную высоту и режет контент.
     */

    // ── ПРОЕКТ · машинист ───────────────────────────────────────────────
    if (proj) {
      if (canWrite) {
        // Главное действие: задача заводится СРАЗУ на доску команды и в тот же
        // момент привязывается к проекту — связь нельзя забыть, а значит не
        // рассыплются % готовности, «задачи по командам» и загрузка.
        buttons.push({
          text: '➕ Задача команде',
          callback: (c) => c.openDialog({
            title: 'Задача команде', url: pageUrl('new-task.html'), width: 'sm',
          }),
        });
        buttons.push({
          text: '📝 Отчёт за 2 недели',
          callback: (c) => c.openDialog({
            title: 'Отчёт по проекту', url: pageUrl('report.html'), width: 'sm',
          }),
        });
      }
      // Загрузка нужна ровно перед постановкой задачи — поэтому она здесь,
      // а не на стратегическом уровне, где ей нечего делать.
      buttons.push({
        text: '📊 Загруженность команды',
        callback: (c) => c.openDialog({
          title: 'Загруженность команды', url: pageUrl('workload.html'), width: 'xl',
        }),
      });
    }

    // ── ЦЕЛЬ · куратор ─────────────────────────────────────────────────
    if (goal) {
      if (canWrite) {
        // цель-родитель предзаполнена — заведение проекта прямо с цели
        buttons.push({
          text: '➕ Проект к этой цели',
          callback: (c) => c.openDialog({
            title: 'Новый проект', url: pageUrl('new-project.html', 'goal=' + card.id),
            width: 'sm',
          }),
        });
      }
      buttons.push({
        text: '📋 Сводка для руководства',
        callback: (c) => c.openDialog({
          title: 'Сводка для руководства', url: pageUrl('summary.html'), width: 'lg',
        }),
      });
      buttons.push({
        text: '📊 Дашборд команды',
        callback: (c) => c.openDialog({
          // Дашборд самодостаточен и данных в нём много — открываем во весь экран.
          title: 'Дашборд команды', url: pageUrl('dashboard.html'), fullScreen: true,
        }),
      });
    }

    // ── НАПРАВЛЕНИЕ · только обзор ─────────────────────────────────────
    if (dir) {
      buttons.push({
        text: '📋 Сводка для руководства',
        callback: (c) => c.openDialog({
          title: 'Сводка для руководства', url: pageUrl('summary.html'), width: 'lg',
        }),
      });
      buttons.push({
        text: '📊 Дашборд команды',
        callback: (c) => c.openDialog({
          title: 'Дашборд команды', url: pageUrl('dashboard.html'), fullScreen: true,
        }),
      });
    }

    // Создание проекта с нуля — редкое действие, поэтому только на шаблонной
    // карточке, а не на каждом проекте, к которому оно отношения не имеет.
    if (/ШАБЛОН/.test(card.title || '') && canWrite) {
      buttons.push({
        text: '🆕 Создать проект',
        callback: (c) => c.openDialog({
          title: 'Новый проект', url: pageUrl('new-project.html'), width: 'sm',
        }),
      });
    }

    // Поставить цель — на любой карточке доски «Цели» (включая шаблон «НАЧНИ ОТСЮДА»)
    if (card.board_id === 1853658 && canWrite && !goal) {
      buttons.push({
        text: '➕ Поставить цель',
        callback: (c) => c.openDialog({
          title: 'Новая цель', url: pageUrl('new-goal.html'), width: 'sm',
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
