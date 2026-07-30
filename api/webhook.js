const { personas, findByNameOrAlias, findAllMentioned, findByTelegramUsername } = require('../lib/personas');
const {
  appendHistory, getHistory, shouldMakeAutonomousReply, shouldMakeReaction, shouldMakeSelfCorrection,
  shouldAwardBadge, recordBadgeActivity, takeBadgeCandidate
} = require('../lib/state');
const { decideResponder, generateReply, decideReaction, generateSummary, generateRoast } = require('../lib/llm');
const { sendMessage, sendChatAction, setMessageReaction } = require('../lib/telegram');
const { formatPersonaReply } = require('../lib/replyFormat');

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

async function selectCommandPersona(personaHint, history, line) {
  const explicitlySelected = personaHint ? findByNameOrAlias(personaHint) : null;
  if (explicitlySelected) return explicitlySelected;

  const decision = await decideResponder(personas, history, line);
  return personas.find((p) => p.name.toLowerCase() === decision.personaName?.toLowerCase())
    || personas[Math.floor(Math.random() * personas.length)];
}

function personaLabel(persona) {
  return persona.label || persona.name.split(/\s+/)[0];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function typingDelay(text) {
  return Math.max(2000, Math.min(5000, 1500 + String(text).length * 20));
}

function makeTypo(text) {
  const candidates = [...text.matchAll(/[А-Яа-яЁё]{5,}/g)];
  if (candidates.length === 0) return null;
  const match = candidates[Math.floor(Math.random() * candidates.length)];
  const word = match[0];
  const index = Math.max(1, Math.min(word.length - 2, Math.floor(word.length / 2)));
  const mistyped = `${word.slice(0, index)}${word[index + 1]}${word[index]}${word.slice(index + 2)}`;
  return { text: `${text.slice(0, match.index)}${mistyped}${text.slice(match.index + word.length)}`, correction: word };
}

async function sendPersonaReply(chatId, persona, content, replyToMessageId) {
  const formatted = formatPersonaReply(persona, content);
  await sendChatAction(chatId, 'typing');
  await delay(typingDelay(content));
  await sendMessage(chatId, formatted.text, replyToMessageId, formatted.parseMode);
  return formatted.plainText;
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
    const isMentionedBot = Boolean(
      botUsername && new RegExp(`(^|\\s)@${botUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'iu').test(text)
    );

    const repliedFrom = message.reply_to_message?.from;
    const isReplyToBot = Boolean(
      repliedFrom && (
        (process.env.BOT_TELEGRAM_ID && String(repliedFrom.id) === String(process.env.BOT_TELEGRAM_ID)) ||
        (repliedFrom.username && botUsername && repliedFrom.username.toLowerCase() === botUsername.toLowerCase())
      )
    );

    const line = `${fromName}: ${text}`;
    await appendHistory(chatId, line);

    let pendingBadge = null;
    if (chatType !== 'private' && !text.startsWith('/')) {
      await recordBadgeActivity(chatId, { userId: fromId, username: fromName, text, timestamp: message.date ? message.date * 1000 : Date.now() });
      if (await shouldAwardBadge(chatId)) pendingBadge = await takeBadgeCandidate(chatId);
    }

    const commandMatch = text.match(/^\/(summary|roast)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
    if (commandMatch) {
      const command = commandMatch[1].toLowerCase();
      const argument = (commandMatch[2] || '').trim();
      const history = await getHistory(chatId);

      if (command === 'summary') {
        const speaker = await selectCommandPersona(argument, history, line);
        await sendChatAction(chatId, 'typing');
        const summary = await generateSummary(speaker, history);
        if (summary) {
          const result = `Краткая выжимка:\n\n${summary}`;
          const plainText = await sendPersonaReply(chatId, speaker, result, message.message_id);
          await appendHistory(chatId, `${speaker.name}: ${plainText}`);
        }
        return res.status(200).json({ ok: true });
      }

      const roastMatch = argument.match(/^@([a-zA-Z0-9_]{5,32})\s+@([a-zA-Z0-9_]{5,32})$/);
      if (!roastMatch) {
        await sendMessage(chatId, 'Формат: /roast @от_кого @кого', message.message_id);
        return res.status(200).json({ ok: true });
      }

      const speakerUsername = roastMatch[1];
      const targetUsername = roastMatch[2];
      const speaker = findByTelegramUsername(speakerUsername);
      const targetPersona = findByTelegramUsername(targetUsername);
      if (!speaker || !targetPersona) {
        await sendMessage(chatId, 'Не знаю одного из username. Проверь формат: /roast @от_кого @кого', message.message_id);
        return res.status(200).json({ ok: true });
      }
      const relation = speaker.relations?.[targetPersona.name] || '';
      await sendChatAction(chatId, 'typing');
      const roast = await generateRoast(
        speaker,
        { username: targetUsername, persona: targetPersona },
        history,
        relation
      );

      if (roast) {
        const result = `Прожарка @${targetUsername}:\n\n${roast}`;
        const plainText = await sendPersonaReply(chatId, speaker, result, message.message_id);
        await appendHistory(chatId, `${speaker.name}: ${plainText}`);
      }
      return res.status(200).json({ ok: true });
    }

    const mentionedPersona = findByNameOrAlias(text);
    let personaToReply = null;
    let shouldReact = false;
    let shouldSelfCorrect = false;

    if (chatType === 'private') {
      // В личке хозяин может тестировать ответы без риска написать в группу.
      personaToReply = mentionedPersona || personas[0] || null;
    } else if (mentionedPersona) {
      console.log(`👤 Mentioned persona matched: "${mentionedPersona.name}"`);
      personaToReply = mentionedPersona;
    } else if (isReplyToBot) {
      // Продолжаем от лица того же человека, чью предыдущую реплику цитируют.
      const history = await getHistory(chatId);
      const repliedText = message.reply_to_message.text || '';
      const previousPersonaLine = [...history]
        .reverse()
        .find((entry) => entry.endsWith(`: ${repliedText}`));
      personaToReply = personas.find((p) => previousPersonaLine?.startsWith(`${p.name}:`)) || personas[0];
      console.log(`💬 Message is reply to bot, continuing as "${personaToReply?.name}"`);
    } else if (isMentionedBot) {
      // @username бота — явный вызов: отвечаем сразу, не ждём интервала 10–20 сообщений.
      const history = await getHistory(chatId);
      const decision = await decideResponder(personas, history, line);
      personaToReply = personas.find((p) => p.name.toLowerCase() === decision.personaName?.toLowerCase()) || personas[0];
      console.log(`📣 Bot mentioned directly, replying as "${personaToReply?.name}"`);
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
      } else if (!text.startsWith('/')) {
        shouldSelfCorrect = await shouldMakeSelfCorrection(chatId);
        if (shouldSelfCorrect) {
          const history = await getHistory(chatId);
          const decision = await decideResponder(personas, history, line);
          personaToReply = personas.find((p) => p.name.toLowerCase() === decision.personaName?.toLowerCase())
            || personas[Math.floor(Math.random() * personas.length)];
          console.log(`✍️ Self-correction interval reached, picked "${personaToReply?.name}"`);
        } else {
          shouldReact = await shouldMakeReaction(chatId);
          console.log(`✨ Reaction interval: ${shouldReact ? 'reached' : 'not reached'}`);
        }
      }
    }

    if (personaToReply) {
      console.log(`🤖 Generating reply as persona "${personaToReply.name}"...`);
      const history = await getHistory(chatId);
      const relationsContext = buildRelationsContext(personaToReply, history, line);
      await sendChatAction(chatId, 'typing');
      const reply = await generateReply(personaToReply, history, line, relationsContext);

      if (reply) {
        console.log(`🚀 Reply generated successfully: "${reply}". Sending to Telegram...`);
        const typo = shouldSelfCorrect ? makeTypo(reply) : null;
        const sentPlainText = await sendPersonaReply(
          chatId,
          personaToReply,
          typo ? typo.text : reply,
          mentionedPersona || isReplyToBot || isMentionedBot ? message.message_id : undefined
        );
        await appendHistory(chatId, `${personaToReply.name}: ${sentPlainText}`);
        if (typo) {
          await delay(1000 + Math.floor(Math.random() * 1001));
          await sendMessage(chatId, `*${typo.correction}`);
          await appendHistory(chatId, `${personaToReply.name}: *${typo.correction}`);
        }
      } else {
        console.log('⚠️ LLM returned empty reply.');
      }
    } else {
      if (shouldReact) {
        const history = await getHistory(chatId);
        const emoji = await decideReaction(history, line);
        const reactionSet = await setMessageReaction(chatId, message.message_id, emoji);
        console.log(reactionSet ? `✨ Set reaction ${emoji}` : `⚠️ Could not set reaction ${emoji}`);
      } else {
        console.log('ℹ️ No persona chosen to reply for this message.');
      }
    }

    if (pendingBadge) {
      const badge = `🏆 Ачивка получена: «${pendingBadge.title}» — @${pendingBadge.username} ${pendingBadge.reason}.`;
      await sendMessage(chatId, badge);
      await appendHistory(chatId, `Система: ${badge}`);
      console.log(`🏆 Awarded badge ${pendingBadge.title} to @${pendingBadge.username}`);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('❌ Webhook error:', err);
    return res.status(200).json({ ok: true });
  }
};
