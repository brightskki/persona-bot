const { Redis } = require('@upstash/redis');

const redis = Redis.fromEnv(); // читает UPSTASH_REDIS_REST_URL и UPSTASH_REDIS_REST_TOKEN из env

const HISTORY_LIMIT = Number(process.env.HISTORY_LIMIT || 500);
const AUTONOMOUS_REPLY_MIN_MESSAGES = Number(process.env.AUTONOMOUS_REPLY_MIN_MESSAGES || 10);
const AUTONOMOUS_REPLY_MAX_MESSAGES = Number(process.env.AUTONOMOUS_REPLY_MAX_MESSAGES || 20);
const REACTION_MIN_MESSAGES = Number(process.env.REACTION_MIN_MESSAGES || 3);
const REACTION_MAX_MESSAGES = Number(process.env.REACTION_MAX_MESSAGES || 7);
const SELF_CORRECTION_MIN_MESSAGES = Number(process.env.SELF_CORRECTION_MIN_MESSAGES || 35);
const SELF_CORRECTION_MAX_MESSAGES = Number(process.env.SELF_CORRECTION_MAX_MESSAGES || 45);
const BADGE_MIN_MESSAGES = Number(process.env.BADGE_MIN_MESSAGES || 100);
const BADGE_MAX_MESSAGES = Number(process.env.BADGE_MAX_MESSAGES || 200);

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

function nextAutonomousReplyAt() {
  const min = Math.max(1, Math.min(AUTONOMOUS_REPLY_MIN_MESSAGES, AUTONOMOUS_REPLY_MAX_MESSAGES));
  const max = Math.max(min, AUTONOMOUS_REPLY_MAX_MESSAGES);
  return min + Math.floor(Math.random() * (max - min + 1));
}

function nextReactionAt() {
  const min = Math.max(1, Math.min(REACTION_MIN_MESSAGES, REACTION_MAX_MESSAGES));
  const max = Math.max(min, REACTION_MAX_MESSAGES);
  return min + Math.floor(Math.random() * (max - min + 1));
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

// Возвращает true только раз в случайные 10–20 обычных сообщений.
// Счётчик хранится отдельно от истории, поэтому переживает перезапуски serverless-функции.
async function shouldMakeAutonomousReply(chatId) {
  const countKey = `autonomous-reply-count:${chatId}`;
  const targetKey = `autonomous-reply-target:${chatId}`;
  let target = Number(await redis.get(targetKey));

  if (!Number.isFinite(target) || target < 1) {
    target = nextAutonomousReplyAt();
    await redis.set(targetKey, String(target));
  }

  const count = Number(await redis.incr(countKey));
  if (count < target) return false;

  await redis.set(countKey, '0');
  await redis.set(targetKey, String(nextAutonomousReplyAt()));
  return true;
}

// Реакции живут по отдельному, более частому счётчику, но всё ещё не на каждом сообщении.
async function shouldMakeReaction(chatId) {
  const countKey = `reaction-count:${chatId}`;
  const targetKey = `reaction-target:${chatId}`;
  let target = Number(await redis.get(targetKey));

  if (!Number.isFinite(target) || target < 1) {
    target = nextReactionAt();
    await redis.set(targetKey, String(target));
  }

  const count = Number(await redis.incr(countKey));
  if (count < target) return false;

  await redis.set(countKey, '0');
  await redis.set(targetKey, String(nextReactionAt()));
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
  appendHistory, getHistory, shouldMakeAutonomousReply, shouldMakeReaction, shouldMakeSelfCorrection,
  shouldAwardBadge, recordBadgeActivity, takeBadgeCandidate
};
