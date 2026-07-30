const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

async function sendMessage(chatId, text, replyToMessageId, parseMode) {
  const body = { chat_id: chatId, text };
  if (replyToMessageId) body.reply_to_message_id = replyToMessageId;
  if (parseMode) body.parse_mode = parseMode;

  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('Telegram sendMessage error:', errText);
  }
}

async function sendChatAction(chatId, action = 'typing') {
  const res = await fetch(`${TELEGRAM_API}/sendChatAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action })
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('Telegram sendChatAction error:', errText);
    return false;
  }
  return true;
}

async function setMessageReaction(chatId, messageId, emoji) {
  const res = await fetch(`${TELEGRAM_API}/setMessageReaction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji }],
      is_big: false
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('Telegram setMessageReaction error:', errText);
    return false;
  }

  return true;
}

module.exports = { sendMessage, sendChatAction, setMessageReaction };
