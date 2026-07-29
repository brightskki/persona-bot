const fs = require('fs');
const path = require('path');

const personasPath = path.join(__dirname, '..', 'config', 'personas.json');

let personas = [];
try {
  personas = JSON.parse(fs.readFileSync(personasPath, 'utf-8'));
} catch (e) {
  console.error('Не найден config/personas.json — скопируй config/personas.example.json и заполни его (или сгенерируй через scripts/buildPersonas.js).');
}

// Обычный \b в JS не понимает границы кириллических слов (\w = только латиница/цифры/_),
// поэтому ищем совпадение по границам через \p{L}\p{N} — иначе "Надир" находилось бы
// внутри слова "надирает" и т.п.
function containsWord(text, word) {
  if (!word) return false;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu');
  return re.test(text);
}

const customAliasesMap = {
  'димаш': ['дима', 'димашик', 'димашу', 'димаша', 'димаш'],
  'максут': ['макс', 'максуту', 'макса', 'максу', 'максик'],
  'киря': ['кирилл', 'кириллу', 'кирилла', 'кире', 'кирюха', 'кирюхе', 'киря'],
  'kirill': ['кирилл', 'кирилла', 'кирилу', 'кире', 'кирюха'],
  'арлан': ['арлаха', 'арлахе', 'арлану', 'арлана', 'арлан'],
  'женя': ['женек', 'жене', 'женю', 'женей', 'женя'],
  'ислам': ['исламу', 'ислама', 'исл', 'исламик', 'ислам'],
  'раим': ['раиму', 'раима', 'райм', 'райму', 'раим'],
  'дастан': ['дастик', 'дастику', 'дастану', 'дастана', 'дастан'],
  'надирка': ['надир', 'надиру', 'надира', 'надику', 'надирка']
};

function getPersonaSearchForms(persona) {
  const forms = new Set();
  if (persona.name) forms.add(persona.name.toLowerCase());

  const firstWord = (persona.name || '').split(' ')[0].replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  if (firstWord) {
    forms.add(firstWord);
    if (customAliasesMap[firstWord]) {
      customAliasesMap[firstWord].forEach((alias) => forms.add(alias));
    }
  }

  (persona.aliases || []).forEach((alias) => forms.add(alias.toLowerCase()));

  return Array.from(forms);
}

function personaMatchesText(persona, text) {
  const searchForms = getPersonaSearchForms(persona);
  return searchForms.some((form) => containsWord(text, form));
}

function findByNameOrAlias(text) {
  const sorted = [...personas].sort((a, b) => b.name.length - a.name.length);
  return sorted.find((p) => personaMatchesText(p, text));
}

function findAllMentioned(text) {
  return personas.filter((p) => personaMatchesText(p, text));
}

function listNames() {
  return personas.map((p) => p.name);
}

module.exports = { personas, findByNameOrAlias, findAllMentioned, listNames };
