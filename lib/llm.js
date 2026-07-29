const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;

const CHEAP_MODEL = process.env.CHEAP_MODEL || 'google/gemma-4-26b-a4b-it:free';
const MAIN_MODEL = process.env.MAIN_MODEL || 'google/gemma-4-26b-a4b-it:free';

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

  return text;
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
    60,
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

// Генерация ответа от лица конкретной персоны.
// relationsContext — текстовая справка о том, как эта персона относится
// к другим людям, упомянутым в текущем разговоре (см. webhook.js).
async function generateReply(persona, history, lastMessage, relationsContext = '') {
  const examples = (persona.archive || []).slice(0, 25).join('\n---\n');
  const location = persona.location || 'Алматы';

  const systemPrompt = `${persona.systemPrompt}

Живёшь в: ${location}.

Вот примеры того, как ты реально пишешь в чатах (ориентируйся на стиль, орфографию, длину сообщений — не копируй содержание примеров):
${examples}
${relationsContext ? `\nВажный контекст об отношениях с людьми в этом разговоре:\n${relationsContext}` : ''}`;

  const userPrompt = `Контекст переписки в группе:\n${history.slice(-15).join('\n')}\n\nОтветь на последнее сообщение в своём стиле, учитывая свои отношения с людьми, если они упомянуты. Коротко, естественно, как в мессенджере. Если уместно — саркастично подколоть себя или кого-то из своих, без злобы. Говори от первого лица самой персоны: например «Да я сегодня недобрал, конечно же, я же Женя». Не называй себя со стороны и не используй конструкции «Женя бы сказал», «от лица Жени» или подписи.

СТРОГОЕ ПРАВИЛО: Выдай ТОЛЬКО чистый текст реплики для чата! Категорически запрещено писать вступления, "Отвечу как...", "Скажу как...", "The user wants...", "Looking at context", "Thinking". Запрещены любые рассуждения вслух.`;

  let reply = await callOpenRouter(
    MAIN_MODEL,
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    250
  );

  reply = cleanAndValidateReply(persona, reply);

  return reply;
}

module.exports = { decideResponder, generateReply };
