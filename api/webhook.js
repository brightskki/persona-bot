const { personas, findByNameOrAlias, findAllMentioned } = require('../lib/personas');
const { appendHistory, getHistory, shouldMakeAutonomousReply } = require('../lib/state');
const { decideResponder, generateReply } = require('../lib/llm');
const { sendMessage } = require('../lib/telegram');

// Собирает справку "как отвечающая персона относится к другим людям,
// упомянутым в текущем разговоре" — из поля relations в personas.json.
function buildRelationsContext(speaker, history, lastMessage) {
  const textBlob = `${history.join('\n')}\n${lastMessage}`;
  const mentioned = findAllMentioned(textBlob).filter((p) => p.name !== speaker.name);

  if (mentioned.length === 0) return '';

  const lines = mentioned
    .map((p) => {
      const note = speaker.relations && speaker.relations[p.name];
      return note ? `- ${p.name}: ${note}` : null;
    })
    .filter(Boolean);

  return lines.join('\n');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true });
  }

  try {
    const update = req.body;
    const message = update ? update.message : null;

    if (!message || !message.text) {
      console.log('ℹ️ Webhook received non-text update or empty body');
      return res.status(200).json({ ok: true });
    }

    const chatId = message.chat.id;
    const text = message.text;
    const fromId = message.from ? message.from.id : null;
    const chatType = message.chat.type; // 'private', 'group', 'supergroup', 'channel'
    const fromName = message.from ? (message.from.username || message.from.first_name || 'кто-то') : 'кто-то';

    console.log(`📩 Incoming message from "${fromName}" (id=${fromId}) in chatId=${chatId} [${chatType}]: "${text}"`);

    // ── OWNER DM ────────────────────────────────────────────────────────────
    // Личка хозяина служит песочницей. В группу уходит только явная команда.
    const OWNER_ID = process.env.OWNER_TELEGRAM_ID;
    const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;
    const isOwnerDm = OWNER_ID && chatType === 'private' && String(fromId) === String(OWNER_ID);
    if (
      isOwnerDm &&
      GROUP_CHAT_ID
    ) {
      const sendToGroupMatch = text.match(/^\/send_to_group(?:@\w+)?\s+([\s\S]+)$/i);
      if (sendToGroupMatch) {
        const forwardText = sendToGroupMatch[1].trim();
        console.log(`📤 Owner DM → forwarding explicitly to group ${GROUP_CHAT_ID}: "${forwardText}"`);
        await sendMessage(GROUP_CHAT_ID, forwardText);
        await sendMessage(chatId, '✅ Отправлено в группу');
        return res.status(200).json({ ok: true });
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    const ALLOWED_CHAT_ID = GROUP_CHAT_ID;
    if (ALLOWED_CHAT_ID) {
      // Сравниваем чистые цифры (без -100 и минусов), чтобы 1004303285808 и -1004303285808 совпадали
      const cleanChatId = String(chatId).replace(/^-100|^-/, '');
      const cleanAllowedId = String(ALLOWED_CHAT_ID).replace(/^-100|^-/, '');
      if (!isOwnerDm && cleanChatId !== cleanAllowedId) {
        console.log(`⚠️ Ignored message: chatId=${chatId} does not match GROUP_CHAT_ID=${ALLOWED_CHAT_ID}`);
        return res.status(200).json({ ok: true });
      }
    }

    const botUsername = process.env.BOT_USERNAME || '';

    const repliedFrom = message.reply_to_message?.from;
    const isReplyToBot = Boolean(
      repliedFrom && (
        (process.env.BOT_TELEGRAM_ID && String(repliedFrom.id) === String(process.env.BOT_TELEGRAM_ID)) ||
        (repliedFrom.username && botUsername && repliedFrom.username.toLowerCase() === botUsername.toLowerCase())
      )
    );

    const line = `${fromName}: ${text}`;
    await appendHistory(chatId, line);

    const mentionedPersona = findByNameOrAlias(text);
    let personaToReply = null;

    if (chatType === 'private') {
      // В личке хозяин может тестировать ответы без риска написать в группу.
      personaToReply = mentionedPersona || personas[0] || null;
    } else if (mentionedPersona) {
      console.log(`👤 Mentioned persona matched: "${mentionedPersona.name}"`);
      personaToReply = mentionedPersona;
    } else if (isReplyToBot) {
      console.log(`💬 Message is reply to bot, picking default persona "${personas[0]?.name}"`);
      personaToReply = personas[0];
    } else {
      const isAutonomousTurn = await shouldMakeAutonomousReply(chatId);
      console.log(`🎲 Autonomous reply interval: ${isAutonomousTurn ? 'reached' : 'not reached'}`);
      if (isAutonomousTurn) {
        const history = await getHistory(chatId);
        const decision = await decideResponder(personas, history, line);
        console.log('🤖 Moderator decision:', decision);
        if (decision.personaName) {
          personaToReply =
            personas.find((p) => p.name.toLowerCase() === decision.personaName.toLowerCase()) || null;
        }

        // Даже если модератор вернул кривой JSON, в назначенный ход
        // всё равно появляется одна короткая реплика от случайной персоны.
        if (!personaToReply && personas.length > 0) {
          personaToReply = personas[Math.floor(Math.random() * personas.length)];
          console.log(`🎲 Random chance triggered! Picked persona: "${personaToReply.name}"`);
        }
      }
    }

    if (personaToReply) {
      console.log(`🤖 Generating reply as persona "${personaToReply.name}"...`);
      const history = await getHistory(chatId);
      const relationsContext = buildRelationsContext(personaToReply, history, line);
      const reply = await generateReply(personaToReply, history, line, relationsContext);

      if (reply) {
        console.log(`🚀 Reply generated successfully: "${reply}". Sending to Telegram...`);
        // Без служебных подписей вроде «Женя бы сказал»: персона говорит сама.
        await sendMessage(chatId, reply, mentionedPersona || isReplyToBot ? message.message_id : undefined);
        await appendHistory(chatId, `${personaToReply.name}: ${reply}`);
      } else {
        console.log('⚠️ LLM returned empty reply.');
      }
    } else {
      console.log('ℹ️ No persona chosen to reply for this message.');
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('❌ Webhook error:', err);
    return res.status(200).json({ ok: true });
  }
};
