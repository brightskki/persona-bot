require('dotenv').config();

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Не задан TELEGRAM_BOT_TOKEN в .env');
  process.exit(1);
}

fetch(`https://api.telegram.org/bot${token}/deleteWebhook`)
  .then((r) => r.json())
  .then((data) => console.log('Ответ Telegram:', data))
  .catch((e) => console.error('Ошибка:', e));
