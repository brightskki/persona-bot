const { personas, findByNameOrAlias, findAllMentioned, findByTelegramUsername } = require('../lib/personas');
const {
  appendHistory, getHistory, getChatLevel, setChatLevel, levelLabel,
  getChatMode, setChatMode, modeLabel, listModes,
  shouldMakeAutonomousReply, shouldMakeReactionForMessage, shouldMakeSelfCorrection,
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

function pickPersonaFromDecision(decision) {
  if (!decision?.personaName) return null;
  return personas.find((p) => p.name.toLowerCase() === decision.personaName.toLowerCase()) || null;
}

function pickRandomPersona() {
  if (personas.length === 0) return null;
  return personas[Math.floor(Math.random() * personas.length)];
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

    const levelMatch = text.match(/^\/level(?:@\w+)?(?:\s+(\d))?$/i);
    if (levelMatch) {
      const requested = levelMatch[1];
      if (requested === undefined) {
        const current = await getChatLevel(chatId);
        await sendMessage(
          chatId,
          `Текущий level: ${current} — ${levelLabel(current)}\n\n/level 0 — вырублен\n/level 1 — только @ / реплай / имя\n/level 2 — сам раз в ~1000\n/level 3 — сам раз в ~100\n/level 4 — сам раз в ~10\n/level 5 — на каждое сообщение\n\nНа 1–5: @бот, реплай и имя персоны — всегда.`,
          message.message_id
        );
        return res.status(200).json({ ok: true });
      }

      const next = await setChatLevel(chatId, requested);
      if (next === null) {
        await sendMessage(chatId, 'Укажи число от 0 до 5. Пример: /level 1', message.message_id);
        return res.status(200).json({ ok: true });
      }

      await sendMessage(chatId, `Level ${next}: ${levelLabel(next)}`, message.message_id);
      console.log(`🎚️ Chat ${chatId} level set to ${next}`);
      return res.status(200).json({ ok: true });
    }

    const modeMatch = text.match(/^\/mode(?:@\w+)?(?:\s+([a-zA-Z-]+))?$/i);
    if (modeMatch) {
      const requested = modeMatch[1];
      if (!requested) {
        const current = await getChatMode(chatId);
        await sendMessage(
          chatId,
          `Текущий mode: ${current} — ${modeLabel(current)}\n\n${listModes()}`,
          message.message_id
        );
        return res.status(200).json({ ok: true });
      }

      const next = await setChatMode(chatId, requested);
      if (!next) {
        await sendMessage(
          chatId,
          `Неизвестный mode. Доступно:\n${listModes()}`,
          message.message_id
        );
        return res.status(200).json({ ok: true });
      }

      await sendMessage(chatId, `Mode ${next}: ${modeLabel(next)}`, message.message_id);
      console.log(`🎭 Chat ${chatId} mode set to ${next}`);
      return res.status(200).json({ ok: true });
    }

    const commandMatch = text.match(/^\/(summary|roast)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
    if (commandMatch) {
      const command = commandMatch[1].toLowerCase();
      const argument = (commandMatch[2] || '').trim();
      const history = await getHistory(chatId);

      if (command === 'summary') {
        await sendChatAction(chatId, 'typing');
        const summary = await generateSummary(null, history, personas);
        if (summary) {
          const result = `Краткая выжимка:\n\n${summary}`;
          await sendMessage(chatId, result, message.message_id);
          await appendHistory(chatId, `Система: ${result}`);
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
    const chatLevel = chatType === 'private' ? 5 : await getChatLevel(chatId);
    const history = await getHistory(chatId);

    if (chatType === 'private') {
      personaToReply = mentionedPersona || personas[0] || null;
    } else if (chatLevel === 0) {
      console.log('🔇 Level 0 — bot disabled');
    } else if (isReplyToBot) {
      const repliedText = message.reply_to_message.text || '';
      const previousPersonaLine = [...history]
        .reverse()
        .find((entry) => entry.endsWith(`: ${repliedText}`));
      personaToReply = personas.find((p) => previousPersonaLine?.startsWith(`${p.name}:`)) || pickRandomPersona();
      console.log(`💬 Reply to bot — answering as "${personaToReply?.name}"`);
    } else if (isMentionedBot) {
      const decision = await decideResponder(personas, history, line, 5);
      personaToReply = pickPersonaFromDecision(decision) || mentionedPersona || pickRandomPersona();
      console.log(`📣 Bot mentioned — answering as "${personaToReply?.name}"`);
    } else if (mentionedPersona) {
      // Имя персоны на level 1–5 — всегда.
      personaToReply = mentionedPersona;
      console.log(`👤 Persona mentioned — answering as "${mentionedPersona.name}"`);
    } else {
      const isAutonomousTurn = await shouldMakeAutonomousReply(chatId, chatLevel);
      console.log(`🎲 Level ${chatLevel} autonomous: ${isAutonomousTurn ? 'yes' : 'no'}`);
      if (isAutonomousTurn) {
        const decision = await decideResponder(personas, history, line, chatLevel === 5 ? 5 : chatLevel);
        personaToReply = pickPersonaFromDecision(decision) || pickRandomPersona();
        console.log(`🤖 Autonomous reply as "${personaToReply?.name}"`);
      } else if (!text.startsWith('/') && chatLevel >= 2) {
        shouldSelfCorrect = chatLevel >= 4 && await shouldMakeSelfCorrection(chatId);
        if (shouldSelfCorrect) {
          const decision = await decideResponder(personas, history, line, chatLevel);
          personaToReply = pickPersonaFromDecision(decision) || pickRandomPersona();
        } else {
          shouldReact = await shouldMakeReactionForMessage(chatId, chatLevel);
        }
      }
    }

    if (personaToReply) {
      const chatMode = await getChatMode(chatId);
      // В режиме cabluc иногда «запрещают» отвечать — молчим.
      if (chatMode === 'cabluc' && Math.random() < 0.3) {
        console.log('👠 Cabluc mode: reply forbidden this turn');
        return res.status(200).json({ ok: true });
      }

      console.log(`🤖 Generating reply as persona "${personaToReply.name}" (mode=${chatMode})...`);
      const relationsContext = buildRelationsContext(personaToReply, history, line);
      const reply = await generateReply(personaToReply, history, line, relationsContext, personas, chatMode);

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
    } else if (shouldReact) {
      const emoji = await decideReaction(history, line);
        if (emoji) {
          const reactionSet = await setMessageReaction(chatId, message.message_id, emoji);
          console.log(reactionSet ? `✨ Set reaction ${emoji}` : `⚠️ Could not set reaction ${emoji}`);
        } else {
          console.log('ℹ️ Reaction skipped: no contextual emoji.');
        }
    } else {
      console.log('ℹ️ No persona chosen to reply for this message.');
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
