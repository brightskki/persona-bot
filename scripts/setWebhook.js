require('dotenv').config();

const url = process.argv[2];

if (!url) {
  console.error('Использование: node scripts/setWebhook.js https://твой-проект.vercel.app/api/webhook');
  process.exit(1);
}

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Не задан TELEGRAM_BOT_TOKEN в .env');
  process.exit(1);
}

fetch(`https://api.telegram.org/bot${token}/setWebhook?url=${encodeURIComponent(url)}`)
  .then((r) => r.json())
  .then((data) => console.log('Ответ Telegram:', data))
  .catch((e) => console.error('Ошибка:', e));
