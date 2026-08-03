const { Redis } = require('@upstash/redis');

const redis = Redis.fromEnv(); // читает UPSTASH_REDIS_REST_URL и UPSTASH_REDIS_REST_TOKEN из env

const HISTORY_LIMIT = Number(process.env.HISTORY_LIMIT || 500);
const DEFAULT_LEVEL = Number(process.env.DEFAULT_LEVEL || 1);
const DEFAULT_MODE = (process.env.DEFAULT_MODE || 'fun').toLowerCase();

// current — прежнее поведение (дешёвый decide + реакции через LLM).
// optimized — в LLM идём только когда реально отвечаем (@ / реплай / имя / интервал level).
function getPipelineMode() {
  const raw = String(process.env.PIPELINE_MODE || 'optimized').trim().toLowerCase();
  return raw === 'current' ? 'current' : 'optimized';
}

function isOptimizedPipeline() {
  return getPipelineMode() === 'optimized';
}

const CHAT_MODES = {
  fun: 'жёсткий троллинг',
  serious: 'максимально серьёзно',
  'fun-business': 'смешно про бизнес',
  business: 'только бизнес-сленг',
  stupid: 'как тупой',
  cabluc: 'жёсткий каблук (иногда нельзя отвечать)',
  putin: 'всегда топит за Россию',
  kazakh: 'топит за Казахстан, пишет на казахском',
  'passive-aggressive': 'пассивно-агрессивно',
  overdramatic: 'сверхдраматично',
  psychoanalyst: 'как психоаналитик',
  coach: 'как коуч',
  'gym-bro': 'протеин, жим, спорт',
  'tinder-match': 'пикапит всех (и иногда отрицает)',
  'capslock-rage': 'КАПСОМ всех успокаивает',
  selector: 'чётко да/нет на выбор',
  toxic: 'жёстко унижает, оскорбляет, матерится',
  'toxic-kazakh': 'жёстко матерится по-казахски (кутакбас и т.д.)'
};

function normalizeMode(value) {
  if (!value) return null;
  const mode = String(value).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(CHAT_MODES, mode) ? mode : null;
}

async function getChatMode(chatId) {
  const raw = await redis.get(`chat-mode:${chatId}`);
  return normalizeMode(raw) || normalizeMode(DEFAULT_MODE) || 'fun';
}

async function setChatMode(chatId, mode) {
  const next = normalizeMode(mode);
  if (!next) return null;
  await redis.set(`chat-mode:${chatId}`, next);
  return next;
}

function modeLabel(mode) {
  const key = normalizeMode(mode) || 'fun';
  return CHAT_MODES[key];
}

function listModes() {
  return Object.entries(CHAT_MODES)
    .map(([key, label]) => `/mode ${key} — ${label}`)
    .join('\n');
}
const SELF_CORRECTION_MIN_MESSAGES = Number(process.env.SELF_CORRECTION_MIN_MESSAGES || 35);
const SELF_CORRECTION_MAX_MESSAGES = Number(process.env.SELF_CORRECTION_MAX_MESSAGES || 45);
const BADGE_MIN_MESSAGES = Number(process.env.BADGE_MIN_MESSAGES || 100);
const BADGE_MAX_MESSAGES = Number(process.env.BADGE_MAX_MESSAGES || 200);

// Как часто бот сам влезает без @ / реплая / имени.
// 5 = каждое сообщение, 1 и 0 = никогда сам.
const LEVEL_AUTONOMOUS_EVERY = {
  0: null,
  1: null,
  2: 1000,
  3: 100,
  4: 10,
  5: 1
};

const LEVEL_REACTION_RATE = {
  0: 0,
  1: 0,
  2: 0.02,
  3: 0.05,
  4: 0.1,
  5: 0
};

const LEVEL_LABELS = {
  0: 'вырублен',
  1: 'только @ / реплай / имя',
  2: 'сам раз в ~1000 + всегда на @/реплай/имя',
  3: 'сам раз в ~100 + всегда на @/реплай/имя',
  4: 'сам раз в ~10 + всегда на @/реплай/имя',
  5: 'на каждое сообщение'
};

function clampLevel(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 5) return null;
  return n;
}

async function getChatLevel(chatId) {
  const raw = await redis.get(`chat-level:${chatId}`);
  const level = clampLevel(raw);
  return level === null ? clampLevel(DEFAULT_LEVEL) ?? 1 : level;
}

async function setChatLevel(chatId, level) {
  const next = clampLevel(level);
  if (next === null) return null;
  await redis.set(`chat-level:${chatId}`, String(next));
  return next;
}

function reactionRateForLevel(level) {
  return LEVEL_REACTION_RATE[level] ?? 0;
}

function levelLabel(level) {
  return LEVEL_LABELS[level] || LEVEL_LABELS[1];
}

function autonomousEveryForLevel(level) {
  return LEVEL_AUTONOMOUS_EVERY[level] ?? null;
}

// Самостоятельный ответ по интервалу level: 5=каждое, 4=10, 3=100, 2=1000, 1/0=никогда.
async function shouldMakeAutonomousReply(chatId, level) {
  const current = level === undefined ? await getChatLevel(chatId) : level;
  const every = autonomousEveryForLevel(current);
  if (!every) return false;
  if (every <= 1) return true;

  const countKey = `autonomous-reply-count:${chatId}`;
  const targetKey = `autonomous-reply-target:${chatId}`;
  let target = Number(await redis.get(targetKey));

  if (!Number.isFinite(target) || target !== every) {
    target = every;
    await redis.set(targetKey, String(target));
  }

  const count = Number(await redis.incr(countKey));
  if (count < target) return false;

  await redis.set(countKey, '0');
  await redis.set(targetKey, String(every));
  return true;
}

async function shouldMakeReactionForMessage(chatId, level) {
  const current = level === undefined ? await getChatLevel(chatId) : level;
  const rate = reactionRateForLevel(current);
  if (rate <= 0) return false;
  return Math.random() < rate;
}

async function appendHistory(chatId, line) {
  const key = `history:${chatId}`;
  await redis.rpush(key, line);
  await redis.ltrim(key, -HISTORY_LIMIT, -1);
}

async function getHistory(chatId) {
  const key = `history:${chatId}`;
  const items = await redis.lrange(key, 0, -1);
  return items || [];
}

function nextAt(minValue, maxValue) {
  const min = Math.max(1, Math.min(minValue, maxValue));
  const max = Math.max(min, maxValue);
  return min + Math.floor(Math.random() * (max - min + 1));
}

async function reachesRandomInterval(chatId, prefix, min, max) {
  const countKey = `${prefix}-count:${chatId}`;
  const targetKey = `${prefix}-target:${chatId}`;
  let target = Number(await redis.get(targetKey));
  if (!Number.isFinite(target) || target < 1) {
    target = nextAt(min, max);
    await redis.set(targetKey, String(target));
  }
  const count = Number(await redis.incr(countKey));
  if (count < target) return false;
  await redis.set(countKey, '0');
  await redis.set(targetKey, String(nextAt(min, max)));
  return true;
}

async function shouldMakeSelfCorrection(chatId) {
  return reachesRandomInterval(chatId, 'self-correction', SELF_CORRECTION_MIN_MESSAGES, SELF_CORRECTION_MAX_MESSAGES);
}

async function shouldAwardBadge(chatId) {
  return reachesRandomInterval(chatId, 'badge', BADGE_MIN_MESSAGES, BADGE_MAX_MESSAGES);
}

function almatyDateParts(timestamp) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Almaty', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(timestamp));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

async function recordBadgeActivity(chatId, { userId, username, text, timestamp = Date.now() }) {
  if (!userId || !username) return;
  const { date, hour } = almatyDateParts(timestamp);
  const user = { userId: String(userId), username };
  const expiresIn = 60 * 60 * 48;

  if (hour >= 3 && hour < 5) {
    const key = `badge-night:${chatId}:${date}:${user.userId}`;
    const count = Number(await redis.incr(key));
    await redis.expire(key, expiresIn);
    if (count === 50) {
      await redis.rpush(`badge-candidates:${chatId}`, JSON.stringify({ ...user, title: 'Ночная сова', reason: 'накатал 50 сообщений с 3 до 5 утра' }));
    }
  }

  if (/(?:скид|цен[а-я]*|ценник|дешев|дорог|эконом|акци|тенге|\bтг\b|₸)/iu.test(text)) {
    const key = `badge-discount:${chatId}:${date}:${user.userId}`;
    const count = Number(await redis.incr(key));
    await redis.expire(key, expiresIn);
    if (count === 10) {
      await redis.rpush(`badge-candidates:${chatId}`, JSON.stringify({ ...user, title: 'Эксперт по скидкам', reason: '10 раз за день упомянул цены или экономию' }));
    }
  }
}

async function takeBadgeCandidate(chatId) {
  const raw = await redis.lpop(`badge-candidates:${chatId}`);
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}

module.exports = {
  appendHistory,
  getHistory,
  getChatLevel,
  setChatLevel,
  clampLevel,
  levelLabel,
  getChatMode,
  setChatMode,
  normalizeMode,
  modeLabel,
  listModes,
  getPipelineMode,
  isOptimizedPipeline,
  shouldMakeAutonomousReply,
  shouldMakeReactionForMessage,
  shouldMakeSelfCorrection,
  shouldAwardBadge,
  recordBadgeActivity,
  takeBadgeCandidate
};
