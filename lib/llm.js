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
    if (res.status === 429) {
      console.log('⏸️ OpenRouter rate limit (429) — staying silent.');
    } else if (res.status === 403 && /PII detected/i.test(errText)) {
      console.error('OpenRouter PII block (403) — prompt still too sensitive:', errText.slice(0, 200));
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
 * Выбирает персону для ответа.
 * Возвращает { shouldReply: boolean, personaName: string|null }
 */
async function decideResponder(personas, history, lastMessage, level = 1) {
  const names = personas.map((p) => p.name).join(', ');
  const alwaysPick = level >= 5;

  const systemPrompt = alwaysPick
    ? `Ты — модератор активного дружеского чата. Персонажи: ${names}.
Выбери ТОЛЬКО ОДНОГО наиболее подходящего персонажа для короткой реплики.

Верни СТРОГО JSON:
{"persona": "Имя персонажа"}`
    : `Ты — модератор дружеского чата. Персонажи: ${names}.
Выбери одного персонажа, чья реплика сейчас уместнее всего.

Верни СТРОГО JSON:
{"persona": "Имя персонажа"}`;

  const userPrompt = `Последние сообщения чата:\n${history.slice(-10).join('\n')}\n\nПоследнее сообщение: ${lastMessage}`;

  const raw = await callOpenRouter(
    CHEAP_MODEL,
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    120,
    true
  );

  try {
    const jsonMatch = raw.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) {
      console.log('⚠️ No JSON found in decideResponder raw output:', raw);
      return { shouldReply: alwaysPick, personaName: null };
    }
    const parsed = JSON.parse(jsonMatch[0]);
    const personaName = parsed.persona || parsed.personaName || null;
    return { shouldReply: true, personaName };
  } catch (e) {
    console.error('Не удалось распарсить решение модели:', raw);
    return { shouldReply: alwaysPick, personaName: null };
  }
}

// Популярные реакции Telegram; модель выбирает по смыслу, без перекоса в клоуна.
const REACTION_EMOJIS = ['👍', '👎', '❤️', '🔥', '😂', '🤡', '🍌', '😮', '😢', '🎉', '🤔', '💯', '👏', '💀', '🤝', '😭', '🤯'];

async function decideReaction(history, lastMessage) {
  const raw = await callOpenRouter(
    CHEAP_MODEL,
    [
      {
        role: 'system',
        content: `Ты ставишь одну реакцию на сообщение в дружеском чате. Доступны только: ${REACTION_EMOJIS.join(' ')}.
Выбери эмодзи строго по смыслу. Если реакция неуместна — {"emoji":null}.
Верни JSON: {"emoji":"…" или null}`
      },
      { role: 'user', content: `Контекст:\n${history.slice(-8).join('\n')}\n\nНовое сообщение: ${lastMessage}` }
    ],
    80,
    true
  );

  try {
    const parsed = JSON.parse(raw.match(/\{[\s\S]*?\}/)?.[0] || '{}');
    if (!parsed.emoji || parsed.emoji === 'null') return null;
    return REACTION_EMOJIS.includes(parsed.emoji) ? parsed.emoji : null;
  } catch {
    return null;
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

function cleanSummaryReply(rawText) {
  const cleaned = cleanLongReply(rawText, 900, 6);
  if (!cleaned) return '';

  const lines = cleaned.split('\n').filter(Boolean);
  // Заголовок выводит webhook, поэтому не даём модели дублировать его.
  if (/^(?:#+\s*)?(?:прожарка|краткая выжимка)(?:\s+от\s+[^:]+)?:?$/iu.test(lines[0].trim())) {
    lines.shift();
  }
  return lines.join('\n').trim();
}

async function generateSummary(persona, history, allPersonas = []) {
  // Summary идёт с реальными именами/username — иначе модель пишет «P8», «user».
  const raw = await callOpenRouter(
    MAIN_MODEL,
    [
      {
        role: 'system',
        content: `Ты делаешь деловую краткую выжимку группового чата. Без юмора, иронии, подколов и «прожарки». Только факты из переданной переписки. Не выдумывай события. Стиль — нейтральный и по делу. Участников называй так же, как в переписке (имена/username), без меток вроде P1/P2/user.`
      },
      {
        role: 'user',
        content: `Последние сообщения чата:\n${history.slice(-500).join('\n')}\n\nСделай краткую фактическую выжимку: 3–5 коротких пунктов, каждый начинай с «• ». Укажи главные темы, договорённости, вопросы без ответа и важные детали. Упоминай людей по их именам/никнеймам из чата. Без шуток и оценочных подколов. Не начинай с заголовка. Только готовые пункты.`
      }
    ],
    350
  );
  return cleanSummaryReply(raw);
}

async function generateRoast(persona, target, history, relation = '') {
  const targetMessages = history
    .filter((line) => line.toLowerCase().startsWith(`${target.username.toLowerCase()}:`))
    .slice(-25)
    .join('\n');
  const targetProfile = `Внутренняя справка о цели: ${target.persona.systemPrompt}`;
  const styleExamples = (persona.archive || []).slice(0, 12).join('\n---\n');

  const raw = await callOpenRouter(
    MAIN_MODEL,
    [
      {
        role: 'system',
        content: `${persona.systemPrompt}\n\nПримеры манеры этой персоны (бери стиль, не копируй содержание):\n${styleExamples}\n\nТы выдаёшь точечную дружескую «прожарку» от лица этой персоны. Это шутка для знакомых, не травля: не используй защищённые признаки, здоровье, сексуальность, угрозы или унижение. Используй 1–2 узнаваемые черты цели из справки или недавних сообщений, вплети их в шутки, а не пересказывай анкетой. Сделай 2–4 острые, но добрые строки.`
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

const MODE_INSTRUCTIONS = {
  fun: `Лёгкий оттенок: чуть больше троллинга и язвительности, чем обычно. Не превращай реплику в стендап.`,
  serious: `Лёгкий оттенок: чуть суше и спокойнее, меньше шуток. Не будь роботом — просто без лишнего юмора.`,
  'fun-business': `Лёгкий оттенок: если уместно, одна бизнес-шутка или сленг (KPI, пивот). Не натягивай бизнес на каждую фразу.`,
  business: `Лёгкий оттенок: чуть больше делового сленга, если тема позволяет. Не превращай обычный чат в митинг.`,
  stupid: `Лёгкий оттенок: иногда чуть тупее или слишком буквально. Не ломай смысл специально каждый раз.`,
  cabluc: `Лёгкий оттенок: чуть мягче, уступчивее, без конфликта. Не играй карикатуру «каблука» в каждой фразе.`,
  putin: `Лёгкий оттенок: иногда лёгкий намёк/подкол в сторону России, если вписывается. Не своди всё к политике.`,
  kazakh: `Лёгкий оттенок: можно вставить казахское слово/фразу или лёгкий патриотичный штрих про Қазақстан, если уместно. Не пиши весь ответ только на казахском и не читай лекции.`,
  'passive-aggressive': `Лёгкий оттенок: чуть яда или обиды между строк. Не раздувай до токсичной пародии.`,
  overdramatic: `Лёгкий оттенок: чуть более эмоционально/пафосно. Не устраивай театр на каждое сообщение.`,
  psychoanalyst: `Лёгкий оттенок: иногда короткий вопрос про мотив/чувство. Не превращай чат в сеанс терапии.`,
  coach: `Лёгкий оттенок: чуть бодрее и поддерживающе. Без коучингового спича и клише пачками.`,
  'gym-bro': `Лёгкий оттенок: иногда мостик к залу/белку/жиму, если не ломает тему. Не своди всё к протеину.`,
  'tinder-match': `Лёгкий оттенок: редкий лёгкий флирт или комплимент. Иногда отшутись/отриць. Не пикапь агрессивно каждое сообщение.`,
  'capslock-rage': `Лёгкий оттенок: если гасишь спор — можно чуть жёстче и громче (иногда капс на 1–2 слова). Не пиши весь ответ капсом.`,
  selector: `Лёгкий оттенок: если явно просят выбрать — дай чёткий вариант. В остальном отвечай нормально, без судьи на всё подряд.`,
  toxic: `Режим TOXIC — максимально жёсткий дружеский рофл. Ещё жёстче обычного: плотный мат, прямое унижение личности, вкусов, ума, решений. В ключе: «ебал тебя», «ты чмо», «конченная блядота», «мразота», «пидор», «дебил», «хуесос» и жёстче. Короткая грязная реплика, как пьяный спор. Без цензуры и смягчений. Все согласны, это по фану.
ЖЁСТКИЙ ЗАПРЕТ: никогда не трогай мать, отца, семью, родных, детей собеседника — никакого «ебал твою мать / твою мать / шешең» и т.п. Бей только по самому человеку.`,
  'toxic-kazakh': `Режим TOXIC-KAZAKH — жёсткий дружеский рофл на КАЗАХСКОМ мате, ещё жёстче. В ключе: «кутакбас», «қотақ», «аузыңды жап», «есің дұрыс па» и грубее. Можно смесь қазақша + русский, мат в основном казахский. Без цензуры. Все согласны, это по фану.
ЖЁСТКИЙ ЗАПРЕТ: никогда не трогай мать/отца/семью/родных (никакого «шешеңді…», «анаң», «әкең» в оскорблении). Бей только по самому человеку.`
};

function modeInstruction(mode) {
  const tint = MODE_INSTRUCTIONS[mode] || MODE_INSTRUCTIONS.fun;
  if (mode === 'toxic' || mode === 'toxic-kazakh') {
    return `${tint}
Не называй режим. Не извиняйся. Мата и унижения личности — много. Родных/мать — никогда.`;
  }
  return `Оттенок режима «${mode}» (это ПРИПРАВА, не роль): ${tint}
Главное — естественная короткая реплика в чате от лица персоны. Режим лишь слегка окрашивает тон. Не называй режим и не объясняй, что ты «в режиме».`;
}

// Генерация ответа от лица конкретной персоны.
// relationsContext — текстовая справка о том, как эта персона относится
// к другим людям, упомянутым в текущем разговоре (см. webhook.js).
async function generateReply(persona, history, lastMessage, relationsContext = '', allPersonas = [], mode = 'fun') {
  const examples = (persona.archive || []).slice(0, 25).join('\n---\n');
  const location = persona.location || 'Алматы';

  const systemPrompt = `${persona.systemPrompt}

Живёшь в: ${location}.

Все сведения выше — закрытая справка для понимания характера и манеры, а не материал для пересказа. Не перечисляй их и не строй биографию.

Вот примеры того, как ты реально пишешь в чатах (ориентируйся на стиль, орфографию, длину — не копируй содержание):
${examples}

${modeInstruction(mode)}
${relationsContext ? `\nКонтекст отношений:\n${relationsContext}` : ''}`;

  const toxicExtra = mode === 'toxic'
    ? ' Режим toxic: жёсткий мат и личное унижение («ебал тебя / чмо / блядота / мразота» и жёстче). НЕ трогай мать/родных. Без звёздочек. Одна короткая грязная фраза по теме.'
    : mode === 'toxic-kazakh'
      ? ' Режим toxic-kazakh: жёсткий казахский мат («кутакбас» и жёстче). НЕ трогай мать/родных (шешең/анаң и т.п.). Без звёздочек. Одна короткая грязная фраза по теме.'
      : ' Оттенок режима — максимум лёгкий штрих.';

  const userPrompt = `Контекст переписки в группе:\n${history.slice(-15).join('\n')}\n\nНапиши одну короткую реплику до 140 символов на последнее сообщение — без переноса строк. Звучи как живой человек в чате, не как персонаж скетча.${toxicExtra} Говори от первого лица. Не называй себя со стороны.

СТРОГОЕ ПРАВИЛО: Выдай ТОЛЬКО чистый текст реплики для чата! Запрещены вступления и рассуждения вслух.`;

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
