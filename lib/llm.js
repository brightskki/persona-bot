const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;

const CHEAP_MODEL = process.env.CHEAP_MODEL || 'google/gemma-4-26b-a4b-it:free';
const MAIN_MODEL = process.env.MAIN_MODEL || 'google/gemma-4-26b-a4b-it:free';
const MAX_REPLY_CHARS = Number(process.env.MAX_REPLY_CHARS || 140);

function sanitizeReply(text) {
  if (!text) return '';
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  const lines = cleaned.split('\n');
  const result = [];
  let isThinkingBlock = true;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Фильтруем строки мыслительного процесса ("Отвечу как...", "The user wants me to...", "Looking at context...")
    if (
      isThinkingBlock &&
      (/^(Отвечу как|Скажу как|Посмотрю на|Тебе нужно|The user|Looking at|My style|Relationship|Response should|Context:|So [A-Z]|Arlan is|Dimash is|Here is|First,|Let me|I need to|We need|Should consider|Probably something|Keep short|Use his style|But need|Actually last|They want|The instruction|So we|Let's produce)/i.test(trimmed) ||
       (trimmed.endsWith('...') && /^(Сначала|В чате|Поскольку)/i.test(trimmed)))
    ) {
      continue;
    }

    isThinkingBlock = false;
    result.push(line);
  }

  let finalContent = (result.length > 0 ? result.join('\n') : cleaned).trim();
  finalContent = finalContent.replace(/^(Отвечу как [^:]+:|Скажу как [^:]+:|Response:)/i, '').trim();
  return finalContent;
}

function cleanAndValidateReply(persona, rawText) {
  let text = sanitizeReply(rawText);

  // Если модель вернула английский дамп или служебный текст — молчим
  const hasCyrillic = /[\p{Script=Cyrillic}]/u.test(text);
  if (
    !text ||
    !hasCyrillic ||
    /^(We need|The user|Response Safety|User Safety|Looking at|My style|Thinking Process)/i.test(text)
  ) {
    console.log('⚠️ LLM returned English dump or empty — staying silent.');
    return '';
  }

  return shortenReply(text);
}

// Модель иногда превращает один ответ в мини-биографию. Бот должен звучать
// как живая короткая реплика в чате, поэтому ограничиваем ответ и промптом,
// и здесь — на случай, если промпт будет проигнорирован.
function shortenReply(text) {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 1);
  let shortText = lines.join('\n');

  if (shortText.length <= MAX_REPLY_CHARS) return shortText;

  shortText = shortText.slice(0, MAX_REPLY_CHARS + 1);
  const lastWordBoundary = shortText.lastIndexOf(' ');
  return (lastWordBoundary > 0 ? shortText.slice(0, lastWordBoundary) : shortText.slice(0, MAX_REPLY_CHARS)).trim();
}

async function callOpenRouter(model, messages, maxTokens = 300, jsonMode = false) {
  // OpenRouter разрешает максимум 3 модели в массиве 'models'
  const models = Array.from(new Set([
    model,
    'google/gemma-4-26b-a4b-it:free',
    'openai/gpt-oss-20b:free'
  ])).slice(0, 3);

  const body = {
    models,
    messages,
    max_tokens: maxTokens,
    temperature: 0.85
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text();
    // При 429 (rate limit) тихо молчим, не спамим в чат
    if (res.status === 429) {
      console.log('⏸️ OpenRouter rate limit (429) — staying silent.');
    } else {
      console.error(`OpenRouter error (${res.status}):`, errText);
    }
    return '';
  }

  const data = await res.json();
  const rawMsg = data.choices?.[0]?.message;
  let content = (rawMsg?.content || rawMsg?.reasoning || '').trim();
  content = sanitizeReply(content);

  if (!content && rawMsg) {
    console.log('⚠️ OpenRouter returned raw message object:', JSON.stringify(rawMsg));
  }

  return content;
}

/**
 * Выбирает наиболее уместную персону для уже запланированного редкого вброса.
 * Возвращает { shouldReply: boolean, personaName: string|null }
 */
async function decideResponder(personas, history, lastMessage) {
  const names = personas.map((p) => p.name).join(', ');

  const systemPrompt = `Ты — модератор активного дружеского чата. Персонажи в чате: ${names}.
Сейчас наступил редкий запланированный момент для одной короткой смешной реплики в контексте разговора. Выбери ТОЛЬКО ОДНОГО наиболее подходящего персонажа: того, чья манера и отношения с участниками лучше всего подходят для ироничной, естественной реакции.

Ответь СТРОГО в формате JSON:
{"persona": "Имя персонажа"}`;

  const userPrompt = `Последние сообщения чата:\n${history.slice(-10).join('\n')}\n\nПоследнее сообщение: ${lastMessage}`;

  const raw = await callOpenRouter(
    CHEAP_MODEL,
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    // Gemini может потратить часть короткого лимита на внутреннее рассуждение;
    // 120 токенов оставляют место для полного JSON-ответа.
    120,
    true
  );

  try {
    const jsonMatch = raw.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) {
      console.log('⚠️ No JSON found in decideResponder raw output:', raw);
      return { shouldReply: false, personaName: null };
    }
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      shouldReply: true,
      personaName: parsed.persona || parsed.personaName || null
    };
  } catch (e) {
    console.error('Не удалось распарсить решение модели:', raw);
    return { shouldReply: false, personaName: null };
  }
}

// 🤡 — фирменная реакция и выпадает заметно чаще. Остальные выбираются моделью
// только в подходящем контексте, чтобы не выглядели случайным набором эмодзи.
async function decideReaction(history, lastMessage) {
  if (Math.random() < 0.6) return '🤡';

  const allowed = ['😂', '🔥', '💀', '🤝', '😭', '👏', '🤯'];
  const raw = await callOpenRouter(
    CHEAP_MODEL,
    [
      {
        role: 'system',
        content: `Выбери одну реакцию на сообщение в дружеском чате. Доступны только: ${allowed.join(', ')}. Выбери эмодзи, который лучше всего подходит по смыслу; не объясняй выбор. Ответь JSON: {"emoji":"…"}`
      },
      { role: 'user', content: `Контекст:\n${history.slice(-6).join('\n')}\n\nНовое сообщение: ${lastMessage}` }
    ],
    80,
    true
  );

  try {
    const parsed = JSON.parse(raw.match(/\{[\s\S]*?\}/)?.[0] || '{}');
    return allowed.includes(parsed.emoji) ? parsed.emoji : '😂';
  } catch {
    return '😂';
  }
}

function cleanLongReply(rawText, maxChars = 700, maxLines = 6) {
  const text = sanitizeReply(rawText);
  if (!text || !/[\p{Script=Cyrillic}]/u.test(text)) return '';

  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, maxLines);
  let result = lines.join('\n');
  if (result.length <= maxChars) return result;

  result = result.slice(0, maxChars + 1);
  const boundary = result.lastIndexOf(' ');
  return (boundary > 0 ? result.slice(0, boundary) : result.slice(0, maxChars)).trim();
}

async function generateSummary(persona, history) {
  const raw = await callOpenRouter(
    MAIN_MODEL,
    [
      {
        role: 'system',
        content: `${persona.systemPrompt}\n\nТы делаешь «Прожарку» — короткую и ироничную выжимку дружеского чата от лица этой персоны. Не выдумывай события, используй только факты из переданной переписки. Не раскрывай личные сведения из профиля персоны и не пиши длинный текст.`
      },
      {
        role: 'user',
        content: `Последние сообщения чата:\n${history.slice(-100).join('\n')}\n\nДай «Прожарку»: 3–5 коротких строк с тем, что обсуждали, кто за что топил и один добрый подкол. Только готовый текст.`
      }
    ],
    350
  );
  return cleanLongReply(raw);
}

async function generateRoast(persona, target, history, relation = '') {
  const targetMessages = history
    .filter((line) => line.toLowerCase().startsWith(`${target.username.toLowerCase()}:`))
    .slice(-25)
    .join('\n');
  const targetProfile = target.persona
    ? `Внутренняя справка о цели: ${target.persona.systemPrompt}`
    : 'Внутренней справки о цели нет: опирайся только на его сообщения.';

  const raw = await callOpenRouter(
    MAIN_MODEL,
    [
      {
        role: 'system',
        content: `${persona.systemPrompt}\n\nТы выдаёшь точечную дружескую «прожарку» от лица этой персоны. Это шутка для знакомых, не травля: не используй защищённые признаки, здоровье, сексуальность, угрозы или унижение. Не пересказывай анкету и личные данные цели списком. Сделай 2–4 острые, но добрые строки.`
      },
      {
        role: 'user',
        content: `Цель: @${target.username}${target.persona ? ` (${target.persona.name})` : ''}.\n${targetProfile}\n${relation ? `Отношение говорящего к цели: ${relation}\n` : ''}Последние сообщения цели:\n${targetMessages || 'Нет сообщений цели в сохранённой истории.'}\n\nДай только готовую прожарку.`
      }
    ],
    350
  );
  return cleanLongReply(raw, 550, 4);
}

// Генерация ответа от лица конкретной персоны.
// relationsContext — текстовая справка о том, как эта персона относится
// к другим людям, упомянутым в текущем разговоре (см. webhook.js).
async function generateReply(persona, history, lastMessage, relationsContext = '') {
  const examples = (persona.archive || []).slice(0, 25).join('\n---\n');
  const location = persona.location || 'Алматы';

  const systemPrompt = `${persona.systemPrompt}

Живёшь в: ${location}.

Все сведения выше — закрытая справка для понимания характера и манеры, а не материал для пересказа. Не перечисляй их, не раскрывай личные детали и не строь из них биографию. Используй максимум одну общую черту, только если она прямо уместна в текущем сообщении.

Вот примеры того, как ты реально пишешь в чатах (ориентируйся на стиль, орфографию, длину сообщений — не копируй содержание примеров):
${examples}
${relationsContext ? `\nВажный контекст об отношениях с людьми в этом разговоре:\n${relationsContext}` : ''}`;

  const userPrompt = `Контекст переписки в группе:\n${history.slice(-15).join('\n')}\n\nОтветь на последнее сообщение ОДНОЙ короткой репликой до 140 символов — без переноса строк. Нужна живая реакция в мессенджере, не монолог. Никогда не пересказывай профиль, архив или биографию персоны: не перечисляй имя, отношения, работу, учёбу, вес, привычки и другие личные сведения. Даже на просьбу «расскажи о человеке» дай одну лёгкую шутку или подкол, без фактов и без представления себя. Если уместно — саркастично, но без злобы. Говори от первого лица самой персоны. Не называй себя со стороны и не используй конструкции «Женя бы сказал», «от лица Жени» или подписи.

СТРОГОЕ ПРАВИЛО: Выдай ТОЛЬКО чистый текст реплики для чата! Категорически запрещено писать вступления, "Отвечу как...", "Скажу как...", "The user wants...", "Looking at context", "Thinking". Запрещены любые рассуждения вслух.`;

  let reply = await callOpenRouter(
    MAIN_MODEL,
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    120
  );

  reply = cleanAndValidateReply(persona, reply);

  return reply;
}

module.exports = { decideResponder, generateReply, decideReaction, generateSummary, generateRoast };
