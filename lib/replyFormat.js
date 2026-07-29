// Разные способы подписать, от чьего лица ответ — чтобы не было одного и того же
// "Отвечу как X:" каждый раз. Выбирается случайно при каждом ответе.
const TEMPLATES = [
  (name, text) => `${name}: ${text}`,
  (name, text) => `${name}: ${text}`,
  (name, text) => `Отвечу как ${name}: ${text}`,
  (name, text) => `Как сказал бы ${name}: ${text}`,
  (name, text) => `${name} бы сказал: ${text}`
];

function formatPersonaReply(name, text) {
  const template = TEMPLATES[Math.floor(Math.random() * TEMPLATES.length)];
  return template(name, text);
}

module.exports = { formatPersonaReply };
