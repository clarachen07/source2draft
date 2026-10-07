export function assessTranslationUnit(unit, text, { afterRepair = false } = {}) {
  const hardErrors = [];
  const repairableIssues = [];
  const warnings = [];
  if (!text?.trim()) {
    hardErrors.push('缺失译文');
    repairableIssues.push('缺失译文');
    return { hardErrors, repairableIssues, warnings };
  }

  const exactMismatch = compareExactInvariantTokens(unit.text, text);
  if (exactMismatch) {
    hardErrors.push(exactMismatch);
    repairableIssues.push(exactMismatch);
  }

  const sourceInline = unit.text.match(/⟦SL_INLINE_\d{3}⟧/g) || [];
  const targetInline = text.match(/⟦SL_INLINE_\d{3}⟧/g) || [];
  if (JSON.stringify(sourceInline) !== JSON.stringify(targetInline)) hardErrors.push('公式占位符顺序或归属改变');

  const numeric = assessNumericEquivalence(unit.text, text);
  hardErrors.push(...numeric.hardErrors);
  warnings.push(...numeric.warnings);
  if (!afterRepair) repairableIssues.push(...numeric.hardErrors, ...numeric.warnings);

  if (isClearlyUntranslated(unit.text, text)) {
    hardErrors.push('疑似未完成翻译');
    repairableIssues.push('疑似未完成翻译');
  }
  return {
    hardErrors: [...new Set(hardErrors)],
    repairableIssues: [...new Set(repairableIssues)],
    warnings: [...new Set(warnings)],
  };
}


export function protectInvariantText(value) {
  const tokens = [];
  const text = String(value).replace(
    /⟦SL_INLINE_\d{3}⟧|https?:\/\/[^\s)\]}>"']+|\\[A-Za-z]+|\$[A-Z]{1,6}\b|\b(?:NASDAQ|NYSE|AMEX|OTC)\s*:\s*[A-Z]{1,6}\b|\b(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+\b|\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z][A-Za-z0-9]{2,}\b|[$€£¥]?[-+]?\d+(?:[,.]\d+)*(?:%|‰|[KMBT](?=\b))?/gi,
    (token) => `⟦SL_KEEP_${tokens.push(token)}⟧`,
  );
  return { text, tokens };
}

export function restoreInvariantText(value, tokens) {
  let text = String(value);
  tokens.forEach((token, index) => { text = text.replaceAll(`⟦SL_KEEP_${index + 1}⟧`, token); });
  return text;
}


export function translationUnits(document) {
  const units = [{ id: 'meta:title', text: document.title || '原文直译', kind: 'title' }];
  for (const block of document.blocks) {
    if (block.translationPolicy === 'preserve-original') continue;
    if (['heading', 'paragraph', 'quote', 'list_item'].includes(block.type) && block.text?.trim()) {
      units.push({ id: block.id, text: block.text, kind: block.type });
    }
    if (block.type === 'figure' && block.caption?.trim()) {
      units.push({ id: `${block.id}:caption`, text: block.caption, kind: 'figure_caption' });
    }
    if (block.type === 'table') {
      if (block.caption?.trim()) units.push({ id: `${block.id}:caption`, text: block.caption, kind: 'table_caption' });
    }
  }
  return units;
}


export function translatedUnitText(document, id) {
  if (id === 'meta:title') return document.translatedTitle;
  const direct = document.blocks.find((block) => block.id === id);
  if (direct) return direct.translatedText;
  const caption = /^(b\d+):caption$/.exec(id);
  if (caption) return document.blocks.find((block) => block.id === caption[1])?.translatedCaption;
  return undefined;
}


function exactInvariantTokens(value) {
  const text = String(value || '');
  const tokens = [
    ...(text.match(/⟦SL_INLINE_\d{3}⟧/g) || []),
    ...exactInvariantUrls(text),
    ...(text.match(/\\[A-Za-z]+/g) || []),
    ...(text.match(/\$[A-Z]{1,6}\b|\b(?:NASDAQ|NYSE|AMEX|OTC)\s*:\s*[A-Z]{1,6}\b/g) || []),
    ...(text.match(/\b(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+\b/g) || []),
    ...(text.match(/\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z][A-Za-z0-9]{2,}\b/g) || []),
  ];
  return tokens.sort();
}

function exactInvariantUrls(value) {
  return (String(value || '').match(/https?:\/\/[^\s)\]}>"'】。，；！？]+/gi) || [])
    .map((token) => token.replace(/[】）.,;:!?。，；：！？]+$/gu, ''))
    .filter(Boolean);
}

function compareExactInvariantTokens(source, translated) {
  const sourceTokens = exactInvariantTokens(source);
  const targetTokens = exactInvariantTokens(translated);
  return JSON.stringify(sourceTokens) === JSON.stringify(targetTokens)
    ? null
    : 'URL、占位符、Ticker 或型号标识不一致';
}

function maskExactInvariantTokens(value) {
  let text = String(value || '');
  for (const token of exactInvariantTokens(text).sort((a, b) => b.length - a.length)) {
    text = text.replaceAll(token, ' '.repeat(token.length));
  }
  return text;
}

function explicitNumericSignature(value) {
  const masked = maskExactInvariantTokens(value);
  return [
    ...invariantNumericSignature(masked, {
      expandShorthand: true,
      normalizePercentWords: true,
    }),
    ...chineseWrittenNumbers(masked),
  ].sort();
}

function assessNumericEquivalence(source, translated) {
  const sourceNumbers = explicitNumericSignature(source);
  const targetNumbers = explicitNumericSignature(translated);
  if (JSON.stringify(sourceNumbers) === JSON.stringify(targetNumbers)) {
    return { hardErrors: [], warnings: [] };
  }

  const sourceCounts = countTokens(sourceNumbers);
  const targetCounts = countTokens(targetNumbers);
  const allowanceCounts = countTokens([
    ...englishMonthNumbers(maskExactInvariantTokens(source)),
    ...englishNumberPhraseNumbers(maskExactInvariantTokens(source)),
  ]);
  const missing = [];
  const unexplained = [];
  for (const [token, count] of sourceCounts) {
    const missingCount = count - (targetCounts.get(token) || 0);
    if (missingCount > 0) missing.push(`${token}×${missingCount}`);
  }
  for (const [token, count] of targetCounts) {
    const extra = count - (sourceCounts.get(token) || 0);
    if (extra > (allowanceCounts.get(token) || 0)) {
      unexplained.push(`${token}×${extra - (allowanceCounts.get(token) || 0)}`);
    }
  }
  if (missing.length) {
    return {
      hardErrors: [`数字或链接不等价（明确阿拉伯数字缺失或改变：${missing.join('、')}）`],
      warnings: [],
    };
  }
  if (!unexplained.length) return { hardErrors: [], warnings: [] };
  if (containsNumericLanguage(source)) {
    return {
      hardErrors: [],
      warnings: [`低置信度数字格式差异（请人工抽查：${unexplained.join('、')}）`],
    };
  }
  return {
    hardErrors: [`数字或链接不等价（译文新增不等值数字：${unexplained.join('、')}）`],
    warnings: [],
  };
}

function invariantNumbers(value) {
  return (String(value).match(/(?<![A-Za-z0-9])[-+]?\d+(?:[,.]\d+)*(?:%|‰)?/g) || [])
    .map((token) => canonicalInvariantNumber(token))
    .filter(Boolean)
    .sort();
}

function invariantNumericSignature(
  value,
  { expandShorthand = false, normalizePercentWords = false } = {},
) {
  const magnitudeMultipliers = {
    thousand: 1_000n,
    million: 1_000_000n,
    billion: 1_000_000_000n,
    trillion: 1_000_000_000_000n,
    万: 10_000n,
    十万: 100_000n,
    百万: 1_000_000n,
    千万: 10_000_000n,
    亿: 100_000_000n,
    十亿: 1_000_000_000n,
    百亿: 10_000_000_000n,
    千亿: 100_000_000_000n,
    万亿: 1_000_000_000_000n,
  };
  const magnitudeTokens = [];
  let masked = String(value).replaceAll('**', '').replaceAll('−', '-');
  if (normalizePercentWords) {
    masked = masked.replace(
      /(?<![A-Za-z0-9])([-+]?\d+(?:[,.]\d+)*)\s*(?:percent|per\s+cent)\b/gi,
      (match, amount) => {
        const normalized = normalizeMagnitudeAmount(amount, 1n);
        if (normalized) magnitudeTokens.push(`PCT:${normalized}`);
        return ' '.repeat(match.length);
      },
    );
  }
  if (expandShorthand) {
    const shorthandMultipliers = {
      k: 1_000n,
      m: 1_000_000n,
      b: 1_000_000_000n,
      bn: 1_000_000_000n,
      t: 1_000_000_000_000n,
    };
    masked = masked.replace(
      /(?<![A-Za-z0-9])(?:[$€£¥]\s*)?([-+]?\d+(?:[,.]\d+)*)\s*(bn|[KMBT])\b/gi,
      (match, amount, unit) => {
        const normalized = normalizeMagnitudeAmount(
          amount,
          shorthandMultipliers[unit.toLowerCase()],
        );
        if (normalized) magnitudeTokens.push(`NUM:${normalized}`);
        return ' '.repeat(match.length);
      },
    );
  }
  masked = masked.replace(
    /(?<![A-Za-z0-9])(?:[$€£¥]\s*)?(one\s+and\s+(?:a|one)\s+half|[-+]?\d+(?:[,.]\d+)*)\s*(thousand|million|billion|trillion)\b(?:\s+(?:U\.?S\.?\s+)?dollars?)?/gi,
    (match, amount, unit) => {
      const normalized = normalizeMagnitudeAmount(amount, magnitudeMultipliers[unit.toLowerCase()]);
      if (normalized) magnitudeTokens.push(`NUM:${normalized}`);
      return ' '.repeat(match.length);
    },
  );
  masked = masked.replace(
    /(?<![A-Za-z0-9])(?:[$€£¥]\s*)?([-+]?\d+(?:[,.]\d+)*)\s*(万亿|千亿|百亿|十亿|千万|百万|十万|亿|万)(?:\s*(?:美元|美金|人民币|欧元|英镑|日元|元))?/g,
    (match, amount, unit) => {
      const normalized = normalizeMagnitudeAmount(amount, magnitudeMultipliers[unit]);
      if (normalized) magnitudeTokens.push(`NUM:${normalized}`);
      return ' '.repeat(match.length);
    },
  );
  return [...invariantNumbers(masked), ...magnitudeTokens].sort();
}

function canonicalInvariantNumber(token) {
  const value = String(token);
  const suffix = value.endsWith('%') ? 'PCT' : value.endsWith('‰') ? 'PERMILLE' : 'NUM';
  const amount = suffix === 'NUM' ? value : value.slice(0, -1);
  const normalized = normalizeMagnitudeAmount(amount, 1n);
  return normalized ? `${suffix}:${normalized}` : null;
}

function normalizeMagnitudeAmount(value, multiplier) {
  if (!multiplier) return null;
  const wholeNumbers = {
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  };
  const phrase = String(value).trim().toLowerCase();
  const fraction = /^(one|two|three|four|five|six|seven|eight|nine|ten)\s+and\s+(?:a|one)\s+half$/.exec(phrase);
  const decimal = fraction ? `${wholeNumbers[fraction[1]]}.5` : phrase.replaceAll(',', '');
  const parsed = /^([-+]?)(\d+)(?:\.(\d+))?$/.exec(decimal);
  if (!parsed) return null;
  const sign = parsed[1] === '-' ? -1n : 1n;
  const fractionDigits = parsed[3] || '';
  const denominator = 10n ** BigInt(fractionDigits.length);
  const numerator = BigInt(`${parsed[2]}${fractionDigits}`) * multiplier;
  const whole = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return `${sign * whole}`;
  const decimals = remainder.toString().padStart(fractionDigits.length, '0').replace(/0+$/, '');
  return `${sign < 0n ? '-' : ''}${whole}.${decimals}`;
}

function countTokens(tokens) {
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
  return counts;
}

function isClearlyUntranslated(source, translated) {
  // Protected formulas, citations, links, model IDs and similar immutable
  // tokens are intentionally identical in source and target. Do not count
  // their Latin marker text (for example SL_INLINE) as untranslated prose.
  const visibleSource = maskExactInvariantTokens(source);
  const visibleTranslated = maskExactInvariantTokens(translated);
  const sourceEnglish = (visibleSource.match(/[A-Za-z]/g) || []).length;
  if (sourceEnglish < 40) return false;
  const sourceWords = visibleSource.match(/[A-Za-z][A-Za-z'-]*/g) || [];
  const capitalized = sourceWords.filter((word) => /^[A-Z]/.test(word)).length;
  if (/[,;]/.test(visibleSource) && sourceWords.length >= 4 && capitalized / sourceWords.length >= 0.7) return false;
  const words = visibleTranslated.match(/[A-Za-z][A-Za-z'-]*/g) || [];
  const han = (visibleTranslated.match(/\p{Script=Han}/gu) || []).length;
  return words.length >= 10 && han < 4;
}

function englishMonthNumbers(value) {
  const months = {
    jan: '1', january: '1', feb: '2', february: '2', mar: '3', march: '3',
    apr: '4', april: '4', may: '5', jun: '6', june: '6', jul: '7', july: '7',
    aug: '8', august: '8', sep: '9', sept: '9', september: '9', oct: '10',
    october: '10', nov: '11', november: '11', dec: '12', december: '12',
  };
  const matches = String(value).matchAll(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b/gi,
  );
  return [...matches]
    .map((match) => months[match[1].toLowerCase()])
    .filter(Boolean)
    .map((number) => `NUM:${number}`);
}

function englishNumberPhraseNumbers(value) {
  const word = [
    'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
    'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
    'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty',
    'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'hundreds', 'thousand',
    'thousands', 'million', 'millions', 'billion', 'billions', 'trillion',
    'trillions', 'and', 'first', 'second', 'third', 'fourth', 'fifth',
    'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth',
    'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth',
    'eighteenth', 'nineteenth', 'twentieth', 'thirtieth', 'fortieth', 'fiftieth',
    'sixtieth', 'seventieth', 'eightieth', 'ninetieth', 'single', 'both',
    'double', 'triple', 'dozen', 'dozens',
  ].join('|');
  const matches = String(value).matchAll(new RegExp(`\\b(?:${word})(?:[\\s-]+(?:${word}))*\\b`, 'gi'));
  return [...matches]
    .flatMap((match) => {
      const phrase = match[0];
      if (/\band\b/i.test(phrase) && !/\b(?:hundred|thousand|million|billion|trillion)\b/i.test(phrase)) {
        return phrase.split(/\band\b/i).map((part) => parseEnglishNumberPhrase(part.trim()));
      }
      return [parseEnglishNumberPhrase(phrase)];
    })
    .filter((number) => number !== null)
    .map((number) => `NUM:${number}`);
}

function parseEnglishNumberPhrase(value) {
  const small = {
    zero: 0n, one: 1n, two: 2n, three: 3n, four: 4n, five: 5n,
    six: 6n, seven: 7n, eight: 8n, nine: 9n, ten: 10n, eleven: 11n,
    twelve: 12n, thirteen: 13n, fourteen: 14n, fifteen: 15n, sixteen: 16n,
    seventeen: 17n, eighteen: 18n, nineteen: 19n, twenty: 20n, thirty: 30n,
    forty: 40n, fifty: 50n, sixty: 60n, seventy: 70n, eighty: 80n, ninety: 90n,
    first: 1n, second: 2n, third: 3n, fourth: 4n, fifth: 5n, sixth: 6n,
    seventh: 7n, eighth: 8n, ninth: 9n, tenth: 10n, eleventh: 11n,
    twelfth: 12n, thirteenth: 13n, fourteenth: 14n, fifteenth: 15n,
    sixteenth: 16n, seventeenth: 17n, eighteenth: 18n, nineteenth: 19n,
    twentieth: 20n, thirtieth: 30n, fortieth: 40n, fiftieth: 50n,
    sixtieth: 60n, seventieth: 70n, eightieth: 80n, ninetieth: 90n,
    single: 1n, both: 2n, double: 2n, triple: 3n, dozen: 12n, dozens: 10n,
  };
  const scales = {
    hundred: 100n,
    hundreds: 100n,
    thousand: 1_000n,
    thousands: 1_000n,
    million: 1_000_000n,
    millions: 1_000_000n,
    billion: 1_000_000_000n,
    billions: 1_000_000_000n,
    trillion: 1_000_000_000_000n,
    trillions: 1_000_000_000_000n,
  };
  const words = String(value).toLowerCase().split(/[\s-]+/).filter((item) => item !== 'and');
  if (!words.length || !words.some((item) => Object.hasOwn(small, item) || Object.hasOwn(scales, item))) {
    return null;
  }
  let total = 0n;
  let current = 0n;
  for (const item of words) {
    if (Object.hasOwn(small, item)) {
      current += small[item];
      continue;
    }
    const scale = scales[item];
    if (!scale) return null;
    if (scale === 100n) {
      current = (current || 1n) * scale;
    } else {
      total += (current || 1n) * scale;
      current = 0n;
    }
  }
  return `${total + current}`;
}

function chineseWrittenNumbers(value) {
  let text = String(value || '');
  const tokens = [];
  text = text.replace(/百分之([负零〇一二两三四五六七八九十百千万亿兆点]+)/g, (match, amount) => {
    const parsed = parseChineseNumber(amount);
    if (parsed !== null) tokens.push(`PCT:${parsed}`);
    return ' '.repeat(match.length);
  });
  // The Han character in percentage terms is a morpheme, not an independent number 100.
  text = text.replace(/百分(?:比|点|率)/g, (match) => ' '.repeat(match.length));
  for (const match of text.matchAll(/[负零〇一二两三四五六七八九十百千万亿兆点]+/g)) {
    const raw = match[0];
    const before = text[match.index - 1] || '';
    const after = text[(match.index || 0) + raw.length] || '';
    const prefixText = text.slice(0, match.index).trimEnd();
    const prefix = prefixText.at(-1) || '';
    if (/[0-9.]$/.test(prefix) && /^[十百千万亿兆]/.test(raw)) continue;
    const boundaryAfter = !/\p{Script=Han}/u.test(after);
    const counterAfter = /[个项次名位份套种只家台条点倍成年月日时分秒周季届级章页组轮期步方侧端类笔股档架件者人]/.test(after);
    const ordinal = prefix === '第';
    const standalone = raw.length === 1
      && (ordinal || (/(?:为|等于|设为|共|约|近|达|至|到)$/.test(prefixText)
        && (boundaryAfter || counterAfter)))
      && !/[零〇一二两三四五六七八九]/.test(before)
      && !/[零〇一二两三四五六七八九]/.test(after);
    if (raw.length < 2 && !/[十百千万亿兆点]/.test(raw) && !standalone) continue;
    const parsed = parseChineseNumber(raw);
    if (parsed !== null) tokens.push(`NUM:${parsed}`);
  }
  return tokens;
}

function parseChineseNumber(value) {
  const digits = { 零: 0n, 〇: 0n, 一: 1n, 二: 2n, 两: 2n, 三: 3n, 四: 4n, 五: 5n, 六: 6n, 七: 7n, 八: 8n, 九: 9n };
  const raw = String(value);
  const negative = raw.startsWith('负');
  const unsigned = (negative ? raw.slice(1) : raw).replaceAll('万亿', '兆');
  if (!unsigned) return null;
  if (unsigned.includes('点')) {
    const [wholeRaw, fractionRaw, ...rest] = unsigned.split('点');
    if (rest.length || !fractionRaw || [...fractionRaw].some((char) => !Object.hasOwn(digits, char))) return null;
    const whole = parseChineseNumber(wholeRaw || '零');
    if (whole === null) return null;
    const decimal = `${whole}.${[...fractionRaw].map((char) => digits[char]).join('')}`;
    return negative ? `-${decimal}` : decimal;
  }
  if ([...unsigned].every((char) => Object.hasOwn(digits, char))) {
    const number = [...unsigned].map((char) => digits[char]).join('').replace(/^0+(?=\d)/, '');
    return `${negative ? '-' : ''}${number || '0'}`;
  }
  const units = { 十: 10n, 百: 100n, 千: 1_000n, 万: 10_000n, 亿: 100_000_000n, 兆: 1_000_000_000_000n };
  let total = 0n;
  let section = 0n;
  let number = 0n;
  for (const char of unsigned) {
    if (Object.hasOwn(digits, char)) {
      number = digits[char];
      continue;
    }
    const unit = units[char];
    if (!unit) return null;
    if (unit < 10_000n) {
      section += (number || 1n) * unit;
    } else {
      section += number;
      total += (section || 1n) * unit;
      section = 0n;
    }
    number = 0n;
  }
  const parsed = total + section + number;
  return `${negative ? -parsed : parsed}`;
}

function containsNumericLanguage(value) {
  return /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|single|double|triple|dozen|percent|percentage|percentages|per\s+cent|january|february|march|april|may|june|july|august|september|october|november|december)\b/i
    .test(String(value || ''));
}
