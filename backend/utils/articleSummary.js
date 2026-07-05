// Rule-based extractive summary builder for card news.
// Design goals:
// - extraction first (no hallucination)
// - at most 2 sentences
// - dedupe and anti-promo safety filters
// - fallback and quality score for skip decision

const KO_STOPWORDS = new Set([
  "그리고",
  "그러나",
  "또한",
  "한편",
  "이번",
  "관련",
  "대한",
  "통해",
  "위해",
  "에서",
  "으로",
  "했다",
  "있다",
  "했다는",
  "했다고",
  "밝혔다",
  "기자",
  "뉴스",
  "기사",
]);

const EN_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "for",
  "of",
  "in",
  "on",
  "with",
  "from",
  "that",
  "this",
  "is",
  "are",
  "was",
  "were",
  "it",
  "as",
  "by",
  "at",
  "news",
  "article",
]);

const EVENT_VERBS = [
  "발표",
  "출시",
  "공개",
  "도입",
  "확대",
  "투자",
  "인수",
  "제휴",
  "전환",
  "밝혔다",
  "계획이다",
  "announce",
  "announced",
  "launch",
  "launched",
  "release",
  "released",
  "introduce",
  "introduced",
  "invest",
  "acquire",
  "acquired",
  "partner",
  "partnership",
  "plan",
  "plans",
];

const CLEAN_DROP_PATTERNS = [
  /(?:입력|수정)\s*\d{4}[./-]\d{1,2}[./-]\d{1,2}/i,
  /\b(?:기자|특파원)\b/,
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  /(?:무단전재|재배포|저작권자|copyright|all rights reserved)/i,
  /(?:구독|subscribe|newsletter|회원가입|로그인|sign up)/i,
  /(?:관련기사|추천기사|read more|recommended|관련 뉴스|more from)/i,
  // Share-UI/CTA boilerplate only. Anchored so ordinary prose like "market share" or
  // "shares surged" (and "Meta acquired the Twitter rival") is not discarded as a share widget.
  /(?:공유하기|소셜\s*공유|share this|share on|copy link|링크\s*복사|카카오톡|\bfacebook\.com\b|\bx\.com\b|\btwitter\.com\b|\blinkedin\.com\b)/i,
  /(?:사진=|이미지=|image source|caption)/i,
  /(?:출처[:：]\s*\S+|\bsource[:：]\s*\S+)/i,
  /(?:광고|sponsored|advertisement)/i,
];

const LOW_INFO_PATTERNS = [
  /(?:업계를 뒤흔들|판도를 바꿀|혁신적인|획기적인|엄청난|dramatic|game[- ]?changer)/i,
  // "could" only as a hedging modal (not "could not <verb>", which is factual reporting).
  /(?:전망이다|전망된다|기대된다|관측된다|expected to|is expected to|\bcould\b(?!\s+not\b))/i,
  /(?:칼럼|\bopinion\b|\beditorial\b)/i,
];

function decodeHtmlEntities(input) {
  if (!input) return "";
  let out = String(input);
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  out = out
    .replace(/&#(\d+);/g, (_m, dec) => {
      const n = Number(dec);
      return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : _m;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
      const n = Number.parseInt(hex, 16);
      return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : _m;
    })
    .replace(/&([a-zA-Z]+);/g, (m, name) => named[name] ?? m);
  return out;
}

function normalizeSpaces(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeCompareText(input) {
  return decodeHtmlEntities(String(input || ""))
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^0-9a-z\u00c0-\u024f\uac00-\ud7a3]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(input) {
  return normalizeCompareText(input)
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function jaccardSimilarity(aTokens, bTokens) {
  const a = new Set(aTokens || []);
  const b = new Set(bTokens || []);
  if (!a.size || !b.size) return 0;
  let inter = 0;
  a.forEach((t) => {
    if (b.has(t)) inter += 1;
  });
  return inter / Math.max(1, a.size + b.size - inter);
}

function countDigits(text) {
  const m = String(text || "").match(/\d/g);
  return m ? m.length : 0;
}

export function cleanHtmlContent(html) {
  const raw = String(html || "");
  if (!raw) return "";
  const noScript = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  const noTags = noScript.replace(/<[^>]+>/g, "\n");
  return normalizeSpaces(decodeHtmlEntities(noTags));
}

export function cleanArticleText(rawText) {
  const text = normalizeSpaces(cleanHtmlContent(rawText || ""));
  if (!text) return "";

  const lines = text
    .split(/\n+/)
    .map((line) => normalizeSpaces(line))
    .filter(Boolean);

  const filtered = [];
  const seen = new Set();
  for (const line of lines) {
    if (line.length < 6) continue;
    if (CLEAN_DROP_PATTERNS.some((re) => re.test(line))) continue;
    if (line.length <= 8 && !/\d/.test(line)) continue;
    const normalized = line
      .replace(/([!?.,])\1{2,}/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    const sig = normalizeCompareText(normalized);
    if (!sig || seen.has(sig)) continue;
    seen.add(sig);
    filtered.push(normalized);
  }

  return normalizeSpaces(filtered.join("\n"));
}

export function splitIntoSentences(text) {
  const normalized = normalizeSpaces(text || "");
  if (!normalized) return [];
  return normalized
    .split(/(?<=[.!?。！？])\s+|(?<=다\.)\s+|(?<=니다\.)\s+|(?<=했다\.)\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .map((sentence) => ({ text: sentence }));
}

function pickNamedEntities(title) {
  const raw = normalizeSpaces(title || "");
  if (!raw) return [];
  const entities = [];
  const quoted = raw.match(/["'“”‘’]([^"'“”‘’]{2,60})["'“”‘’]/g) || [];
  quoted.forEach((q) => {
    const clean = q.replace(/["'“”‘’]/g, "").trim();
    if (clean) entities.push(clean);
  });
  const enProper = raw.match(/\b[A-Z][A-Za-z0-9+\-]{1,}\b/g) || [];
  const koProper = raw.match(/[가-힣][가-힣A-Za-z0-9+\-]{1,}/g) || [];
  return [...entities, ...enProper, ...koProper];
}

export function extractTitleKeywords(title) {
  const raw = normalizeSpaces(title || "");
  if (!raw) return [];

  const entityCandidates = pickNamedEntities(raw).filter((x) => x.length >= 2);
  const tokenCandidates = tokenize(raw).filter((token) => {
    if (token.length < 2) return false;
    if (KO_STOPWORDS.has(token) || EN_STOPWORDS.has(token)) return false;
    return true;
  });

  const numeric = tokenCandidates.filter((token) => /\d/.test(token));
  const prioritized = [...numeric, ...entityCandidates, ...tokenCandidates];
  const unique = [];
  const seen = new Set();
  for (const token of prioritized) {
    const key = normalizeCompareText(token);
    if (!key || key.length < 2 || seen.has(key)) continue;
    seen.add(key);
    unique.push(token.trim());
  }
  return unique.slice(0, 6);
}

function hasTitleKeyword(sentence, titleKeywords = []) {
  const normalized = normalizeCompareText(sentence);
  return (titleKeywords || []).some((keyword) => {
    const k = normalizeCompareText(keyword);
    return k && normalized.includes(k);
  });
}

function hasNumericEvidence(sentence) {
  return /\d/.test(sentence || "");
}

function hasEntitySignal(sentence) {
  return /\b[A-Z][A-Za-z0-9+\-]{1,}\b/.test(sentence || "") || /(?:오픈AI|OpenAI|구글|Google|메타|Meta|엔비디아|NVIDIA|마이크로소프트|Microsoft|아마존|Amazon|애플|Apple)/i.test(sentence || "");
}

// English event verbs must match on word boundaries (substring matching wrongly fired on
// "plan" inside "airplane"/"planet", "release" inside "unreleased", etc.). Korean verbs have
// no word spacing, so they stay substring-matched.
const EVENT_VERBS_EN = EVENT_VERBS.filter((v) => /[a-z]/i.test(v));
const EVENT_VERBS_KO = EVENT_VERBS.filter((v) => !/[a-z]/i.test(v));
const EVENT_VERBS_EN_RE = new RegExp(
  `\\b(?:${EVENT_VERBS_EN.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})s?\\b`,
  "i",
);

function hasEventVerb(sentence) {
  const s = String(sentence || "");
  if (EVENT_VERBS_EN_RE.test(s)) return true;
  const lower = s.toLowerCase();
  return EVENT_VERBS_KO.some((verb) => lower.includes(verb));
}

function titleSimilarity(sentence, title) {
  const s = tokenize(sentence);
  const t = tokenize(title);
  return jaccardSimilarity(s, t);
}

function isReporterNarration(sentence) {
  return /(?:기자는|기자=|기자\)|특파원|보도에 따르면|according to reporters|reporters said)/i.test(sentence || "");
}

function isQuoteOnly(sentence) {
  const s = String(sentence || "").trim();
  const quoteLike = /["“”'‘’]|(?:라고|라며|said|stated|noted)/i.test(s);
  const factLike = hasNumericEvidence(s) || hasEventVerb(s) || hasEntitySignal(s);
  return quoteLike && !factLike;
}

function isAbstractOutlook(sentence) {
  return LOW_INFO_PATTERNS.some((re) => re.test(sentence || ""));
}

function isPromoSentence(sentence) {
  return /(?:지금 등록|register now|구독하세요|subscribe now|티켓|early bird|sponsored|advertisement)/i.test(sentence || "");
}

export function scoreSentence(sentence, context = {}) {
  const s = normalizeSpaces(sentence || "");
  const title = context.title || "";
  const titleKeywords = context.titleKeywords || [];
  const position = Number.isFinite(context.position) ? context.position : 9999;
  const reasons = [];
  let score = 0;

  if (hasTitleKeyword(s, titleKeywords)) {
    score += 3;
    reasons.push("+3 title keyword");
  }
  if (hasNumericEvidence(s)) {
    score += 3;
    reasons.push("+3 numeric signal");
  }
  if (hasEntitySignal(s)) {
    score += 2;
    reasons.push("+2 entity signal");
  }
  if (hasEventVerb(s)) {
    score += 2;
    reasons.push("+2 event verb");
  }
  if (position <= 5) {
    score += 2;
    reasons.push("+2 early paragraph");
  }
  const sim = titleSimilarity(s, title);
  if (sim >= 0.3) {
    score += 2;
    reasons.push("+2 title similarity");
  }

  if (s.length <= 12) {
    score -= 3;
    reasons.push("-3 too short");
  }
  if (isReporterNarration(s)) {
    score -= 2;
    reasons.push("-2 reporter narration");
  }
  if (isQuoteOnly(s)) {
    score -= 2;
    reasons.push("-2 quote only");
  }
  if (isAbstractOutlook(s)) {
    score -= 2;
    reasons.push("-2 abstract outlook");
  }
  if (isPromoSentence(s)) {
    score -= 3;
    reasons.push("-3 promo");
  }

  return {
    sentence: s,
    score,
    reasons,
    titleSimilarity: Number(sim.toFixed(3)),
    hasNumeric: hasNumericEvidence(s),
    position,
  };
}

function sentenceFingerprint(scored) {
  const sentence = scored?.sentence || "";
  const normalized = normalizeCompareText(sentence);
  const numbers = (sentence.match(/\d[\d.,]*/g) || []).join("|");
  const subject = tokenize(sentence).slice(0, 4).join("|");
  return `${subject}::${numbers}::${normalized.slice(0, 80)}`;
}

function chooseBetterSentence(a, b, title = "") {
  if (!a) return b;
  if (!b) return a;
  const aDigits = countDigits(a.sentence);
  const bDigits = countDigits(b.sentence);
  if (a.score !== b.score) return a.score > b.score ? a : b;
  if (aDigits !== bDigits) return aDigits > bDigits ? a : b;
  const aSim = titleSimilarity(a.sentence, title);
  const bSim = titleSimilarity(b.sentence, title);
  if (aSim !== bSim) return aSim > bSim ? a : b;
  return a.sentence.length >= b.sentence.length ? a : b;
}

export function dedupeSentences(scoredSentences, context = {}) {
  const title = context.title || "";
  const out = [];
  const seen = new Map();

  for (const scored of Array.isArray(scoredSentences) ? scoredSentences : []) {
    if (!scored?.sentence) continue;
    const fp = sentenceFingerprint(scored);
    if (!fp) continue;
    if (!seen.has(fp)) {
      seen.set(fp, scored);
      continue;
    }
    const current = seen.get(fp);
    seen.set(fp, chooseBetterSentence(current, scored, title));
  }

  const uniques = Array.from(seen.values());
  for (const candidate of uniques) {
    const isNearDup = out.some((picked) => {
      const sim = jaccardSimilarity(tokenize(candidate.sentence), tokenize(picked.sentence));
      if (sim >= 0.72) return true;
      const aNums = (candidate.sentence.match(/\d[\d.,]*/g) || []).join("|");
      const bNums = (picked.sentence.match(/\d[\d.,]*/g) || []).join("|");
      if (aNums && bNums && aNums === bNums && sim >= 0.55) return true;
      return false;
    });
    if (!isNearDup) out.push(candidate);
  }
  return out;
}

function orderSummarySentences(selected) {
  const arr = selected.slice();
  arr.sort((a, b) => {
    const aEvent = hasEventVerb(a.sentence) ? 1 : 0;
    const bEvent = hasEventVerb(b.sentence) ? 1 : 0;
    if (aEvent !== bEvent) return bEvent - aEvent;
    return a.position - b.position;
  });
  if (arr.length >= 2) {
    const secondCandidates = arr.slice(1).sort((a, b) => {
      const aNumeric = hasNumericEvidence(a.sentence) ? 1 : 0;
      const bNumeric = hasNumericEvidence(b.sentence) ? 1 : 0;
      if (aNumeric !== bNumeric) return bNumeric - aNumeric;
      return b.score - a.score;
    });
    return [arr[0], secondCandidates[0]];
  }
  return arr.slice(0, 1);
}

export function buildSummaryFromSentences(selectedSentences, title) {
  const selected = Array.isArray(selectedSentences) ? selectedSentences.filter(Boolean) : [];
  if (!selected.length) return "";
  const ordered = orderSummarySentences(selected).slice(0, 2);
  const normalizedTitle = normalizeCompareText(title || "");
  const lines = [];
  const seen = new Set();
  for (const item of ordered) {
    let sentence = normalizeSpaces(item.sentence || "");
    if (!sentence) continue;
    const sig = normalizeCompareText(sentence);
    if (!sig || seen.has(sig)) continue;
    if (normalizedTitle && sig === normalizedTitle && ordered.length > 1) continue;
    if (!/[.!?]$/.test(sentence)) sentence += ".";
    seen.add(sig);
    lines.push(sentence);
  }
  return lines.slice(0, 2).join(" ");
}

export function buildFallbackSummary(title, firstParagraph) {
  const cleanTitle = normalizeSpaces(title || "").replace(/[.!?]+$/g, "");
  const first = normalizeSpaces(firstParagraph || "");
  if (first && first.length >= 20) {
    const firstSentences = splitIntoSentences(first)
      .map((s) => s.text)
      .filter((s) => s.length >= 15)
      .slice(0, 2);
    const summary = firstSentences.join(" ").trim();
    if (summary) {
      return {
        summary: /[.!?]$/.test(summary) ? summary : `${summary}.`,
        level: "paragraph",
      };
    }
  }
  if (cleanTitle) {
    return {
      summary: `${cleanTitle}.`,
      level: "title",
    };
  }
  return {
    summary: "",
    level: "empty",
  };
}

function pickTopScored(scored, max = 6) {
  return scored
    .slice(0, Math.max(1, max))
    .map((item) => ({
      sentence: item.sentence,
      score: item.score,
      reasons: item.reasons,
      titleSimilarity: item.titleSimilarity,
    }));
}

function computeQualityScore({
  usedFallback,
  fallbackLevel,
  selected,
  cleanedLength,
  candidateCount,
  summary,
}) {
  let score = 18;
  const s0 = selected?.[0]?.score || 0;
  const s1 = selected?.[1]?.score || 0;
  const selectedCount = Array.isArray(selected) ? selected.length : 0;
  const summaryLength = String(summary || "").length;
  const selectedRows = Array.isArray(selected) ? selected : [];
  const negativeReasonCount = selectedRows.reduce((acc, row) => {
    const reasons = Array.isArray(row?.reasons) ? row.reasons : [];
    return acc + reasons.filter((reason) => String(reason || "").startsWith("-")).length;
  }, 0);
  const selectedScoreTotal = selectedRows.reduce((acc, row) => acc + Number(row?.score || 0), 0);
  const selectedScoreAvg = selectedCount ? selectedScoreTotal / selectedCount : 0;

  score += Math.max(0, Math.min(28, s0 * 4));
  score += Math.max(0, Math.min(24, s1 * 4));
  if (selectedCount >= 2) score += 10;
  else if (selectedCount === 1) score -= 8;

  if (!usedFallback) score += 12;

  if (cleanedLength >= 900) score += 10;
  else if (cleanedLength >= 500) score += 7;
  else if (cleanedLength >= 250) score += 4;
  else if (cleanedLength >= 120) score += 1;
  else score -= 10;

  if (candidateCount >= 10) score += 10;
  else if (candidateCount >= 6) score += 6;
  else if (candidateCount >= 3) score += 2;
  else score -= 10;

  if (summaryLength >= 140) score += 6;
  else if (summaryLength >= 90) score += 3;
  else if (summaryLength < 45) score -= 12;
  else if (summaryLength < 70) score -= 6;

  if (selectedScoreAvg < 4) score -= 14;
  else if (selectedScoreAvg < 6) score -= 8;
  else if (selectedScoreAvg < 7) score -= 4;

  if (negativeReasonCount > 0) score -= Math.min(24, negativeReasonCount * 6);

  if (!usedFallback && candidateCount <= 2 && selectedCount <= 1) {
    score = Math.min(score, 58);
  }

  if (usedFallback) {
    if (fallbackLevel === "paragraph") score = Math.min(score, 62);
    if (fallbackLevel === "title") score = Math.min(score, 35);
    if (fallbackLevel === "empty") score = Math.min(score, 20);
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

function selectCandidateSentences(scoredList, title) {
  const selected = [];
  for (const candidate of scoredList) {
    if (!candidate?.sentence) continue;
    if (selected.length >= 2) break;
    let adjustedScore = candidate.score;
    const isSimilar = selected.some((picked) => {
      const sim = jaccardSimilarity(tokenize(candidate.sentence), tokenize(picked.sentence));
      return sim >= 0.66;
    });
    if (isSimilar) {
      adjustedScore -= 4;
    }
    if (adjustedScore < 1 && selected.length > 0) continue;
    selected.push({ ...candidate, score: adjustedScore });
  }
  return selected;
}

export function summarizeArticleRuleBased(input = {}) {
  const title = normalizeSpaces(input.title || "");
  const rawText = normalizeSpaces(input.rawText || "");
  const cleaned = cleanArticleText(rawText);
  const cleanedLength = cleaned.length;
  const sentenceRows = splitIntoSentences(cleaned);
  const titleKeywords = extractTitleKeywords(title);
  const candidates = sentenceRows
    .map((row, idx) => scoreSentence(row.text, { title, titleKeywords, position: idx }))
    .filter((row) => row.sentence && row.sentence.length >= 10);

  const deduped = dedupeSentences(
    candidates.sort((a, b) => b.score - a.score),
    { title },
  );

  const topScored = pickTopScored(deduped, 6);
  const selected = selectCandidateSentences(deduped, title);
  let summary = buildSummaryFromSentences(selected, title);
  let usedFallback = false;
  let fallbackLevel = "none";

  if (!summary || summary.length < 20) {
    const fallback = buildFallbackSummary(title, sentenceRows.slice(0, 3).map((x) => x.text).join(" "));
    summary = fallback.summary;
    usedFallback = true;
    fallbackLevel = fallback.level;
  }

  const qualityScore = computeQualityScore({
    usedFallback,
    fallbackLevel,
    selected,
    cleanedLength,
    candidateCount: deduped.length,
    summary,
  });

  const shouldSkip = qualityScore <= 39 || !summary;
  return {
    summary,
    qualityScore,
    usedFallback,
    shouldSkip,
    debug: {
      cleanedLength,
      candidateCount: deduped.length,
      selectedSentences: selected.map((x) => x.sentence),
      topScored,
      titleKeywords,
    },
  };
}
