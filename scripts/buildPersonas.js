/**
 * Строит config/personas.json из стандартного JSON-экспорта Telegram Desktop
 * (Настройки чата → Export chat history → JSON).
 *
 * Использование:
 *   node scripts/buildPersonas.js /путь/к/result.json
 *
 * Скрипт группирует сообщения по отправителю, чистит их (убирает медиа-заглушки,
 * системные сообщения, ссылки-простыни) и берёт случайную выборку примеров
 * на каждого человека — чтобы не пихать все 12 МБ в промпт.
 *
 * systemPrompt для каждого персонажа скрипт НЕ пишет — это единственное,
 * что нужно заполнить руками (личность, характер, манера).
 */

const fs = require('fs');
const path = require('path');

const SAMPLES_PER_PERSON = 200; // сколько примеров сообщений оставить на каждого
const MIN_LENGTH = 3; // игнорировать совсем короткие сообщения типа "да"/"ок" (мусорят стиль)
const MAX_LENGTH = 400; // игнорировать простыни — они не показательны для стиля

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Использование: node scripts/buildPersonas.js /путь/к/result.json');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
const messages = raw.messages || raw; // на случай другого формата экспорта

function extractText(msg) {
  // В экспорте Telegram text может быть строкой или массивом сущностей (ссылки, жирный текст и т.д.)
  if (typeof msg.text === 'string') return msg.text;
  if (Array.isArray(msg.text)) {
    return msg.text
      .map((part) => (typeof part === 'string' ? part : part.text || ''))
      .join('');
  }
  return '';
}

const bySender = {};

for (const msg of messages) {
  if (msg.type !== 'message') continue; // пропускаем service-сообщения (кто-то вышел/зашёл и т.д.)
  const sender = msg.from || msg.actor;
  if (!sender) continue;

  const text = extractText(msg).trim();
  if (text.length < MIN_LENGTH || text.length > MAX_LENGTH) continue;
  if (text.startsWith('http://') || text.startsWith('https://')) continue;

  if (!bySender[sender]) bySender[sender] = [];
  bySender[sender].push(text);
}

const personas = Object.entries(bySender).map(([name, msgs]) => {
  // Случайная выборка, чтобы не брать только самые ранние/поздние сообщения
  const shuffled = msgs.sort(() => Math.random() - 0.5);
  const sample = shuffled.slice(0, SAMPLES_PER_PERSON);

  return {
    name,
    aliases: [],
    systemPrompt: `Ты — ${name}. [ЗАПОЛНИ: кто он, характер, манера речи, темы]`,
    relations: {},
    archive: sample
  };
});

const outputPath = path.join(__dirname, '..', 'config', 'personas.json');
fs.writeFileSync(outputPath, JSON.stringify(personas, null, 2), 'utf-8');

console.log(`Готово. Найдено персон: ${personas.length}`);
personas.forEach((p) => console.log(`  - ${p.name}: ${p.archive.length} примеров сообщений`));
console.log(`\nФайл сохранён: ${outputPath}`);
console.log('Теперь открой его и заполни systemPrompt и relations для каждого персонажа.');
