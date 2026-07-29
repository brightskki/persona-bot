// Обычно явно показываем, от чьего лица реплика. Иногда оставляем чистый текст:
// это выглядит естественнее, когда контекст уже однозначно указывает на персону.
const TEMPLATES = [
  (name, text) => `${name} бы написал: ${text}`,
  (name, text) => `Как говорит ${name}: ${text}`,
  (name, text) => `По версии ${name}: ${text}`,
  (name, text) => `${name}, как обычно: ${text}`,
  (name, text) => `Цитата дня от ${name}: ${text}`,
  (name, text) => `У ${name} на это один ответ: ${text}`,
  (name, text) => `${name} в своём стиле: ${text}`,
  (name, text) => `Голос ${name}: ${text}`,
  (name, text) => text,
  (name, text) => text
];

function formatPersonaReply(persona, text) {
  const name = persona.label || persona.name.split(/\s+/)[0];
  const template = TEMPLATES[Math.floor(Math.random() * TEMPLATES.length)];
  return template(name, text);
}

module.exports = { formatPersonaReply };
