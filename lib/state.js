const { Redis } = require('@upstash/redis');

const redis = Redis.fromEnv(); // читает UPSTASH_REDIS_REST_URL и UPSTASH_REDIS_REST_TOKEN из env

const HISTORY_LIMIT = Number(process.env.HISTORY_LIMIT || 20);
const AUTONOMOUS_REPLY_MIN_MESSAGES = Number(process.env.AUTONOMOUS_REPLY_MIN_MESSAGES || 10);
const AUTONOMOUS_REPLY_MAX_MESSAGES = Number(process.env.AUTONOMOUS_REPLY_MAX_MESSAGES || 20);

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

module.exports = { appendHistory, getHistory, shouldMakeAutonomousReply };
