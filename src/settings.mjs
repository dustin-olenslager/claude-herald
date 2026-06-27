import { getMode, getModel } from './state.mjs';

export const MODES = ['strict', 'guided', 'yolo'];
export const MODELS = ['haiku', 'sonnet', 'opus'];

export const MODE_LABELS = {
  strict: '🔒 Strict',
  guided: '⚖️ Guided',
  yolo:   '🚀 Yolo',
};

export const MODE_DESCRIPTIONS = {
  strict: 'Approve every edit + every risky shell command.',
  guided: 'Auto edits, tap to approve pushes/deploys/deletes.',
  yolo:   'Approve nothing. Full autonomy.',
};

export function settingsMenu(chatId) {
  const mode = getMode(chatId);
  const model = getModel(chatId);
  const text = [
    'Settings',
    '',
    `Mode: ${MODE_LABELS[mode]}`,
    `· ${MODE_DESCRIPTIONS[mode]}`,
    '',
    `Model: ${model}`,
  ].join('\n');
  const markup = {
    inline_keyboard: [
      MODES.map((m) => ({
        text: (m === mode ? '✅ ' : '') + MODE_LABELS[m],
        callback_data: `mode:${m}`,
      })),
      MODELS.map((m) => ({
        text: (m === model ? '✅ ' : '🧠 ') + m,
        callback_data: `model:${m}`,
      })),
      [{ text: '✖ Close', callback_data: 'menu:close' }],
    ],
  };
  return { text, markup };
}
