function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Имя — тихой italic-подписью после реплики: понятно, кто говорит, но сам текст
// остаётся главным и не начинается с искусственного «Женя бы сказал».
function formatPersonaReply(persona, text) {
  const name = persona.label || persona.name.split(/\s+/)[0];
  const plainText = `${text}\n\n${name}`;
  return {
    text: `${escapeHtml(text)}\n\n<i>${escapeHtml(name)}</i>`,
    plainText,
    parseMode: 'HTML'
  };
}

module.exports = { formatPersonaReply };
