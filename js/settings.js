/* НАСТРОЙКИ АДДОНА — попап при подключении к пространству.
 *
 * Здесь живёт всё, что отличается между компаниями: id типов карточек,
 * доска для новых проектов, порог «молчим». Хранится в Kaiten через
 * setSettings — API-доступ и OAuth не нужны.
 */

const iframe = Addon.iframe();

const FIELDS = ['project_type_ids', 'goal_type_ids', 'direction_type_ids',
  'new_project_board_id', 'silent_days'];
const $ = (id) => document.getElementById(id);
const msg = (t) => { $('msg').textContent = t || ''; };

// «696186, 696272» → [696186, 696272]; мусор отбрасываем молча
const toIds = (s) => String(s || '').split(',').map((x) => parseInt(x.trim(), 10))
  .filter((x) => !isNaN(x));

async function init() {
  try {
    const all = await iframe.getSettings();
    const s = (Array.isArray(all) ? all[0] : all) || {};
    for (const k of FIELDS) {
      if (s[k] == null) continue;
      $(k).value = Array.isArray(s[k]) ? s[k].join(', ') : s[k];
    }
  } catch (e) { msg('Настройки не прочитались — сохранение всё равно сработает'); }

  $('save').addEventListener('click', async () => {
    $('save').disabled = true;
    msg('Сохраняю…');
    const out = {};
    for (const k of ['project_type_ids', 'goal_type_ids', 'direction_type_ids']) {
      const ids = toIds($(k).value);
      if (ids.length) out[k] = ids;
    }
    if ($('new_project_board_id').value) out.new_project_board_id = Number($('new_project_board_id').value);
    if ($('silent_days').value) out.silent_days = Number($('silent_days').value);
    try {
      await iframe.setSettings(out);
      msg('✅ Сохранено');
      iframe.showSnackbar('Настройки аддона сохранены', 'success');
      setTimeout(() => iframe.closePopup(), 800);
    } catch (e) {
      msg('⚠️ Не сохранилось: ' + ((e && e.message) || e));
      $('save').disabled = false;
    }
  });

  iframe.fitSize('#settings');
}

init();
