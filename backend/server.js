import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { XMLParser } from "fast-xml-parser";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function stripEnvWrappingQuotes(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function loadEnvFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, "utf-8");
    if (!raw) return;
    raw.split(/\r?\n/).forEach((line) => {
      const trimmed = String(line || "").trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) return;
      const key = match[1];
      const value = stripEnvWrappingQuotes(match[2]);
      if (!key || process.env[key]) return;
      process.env[key] = value;
    });
  } catch (e) {
    console.warn(`Failed to load env file: ${filePath}`, e?.message || e);
  }
}

loadEnvFile(path.join(__dirname, "..", ".env"));
loadEnvFile(path.join(__dirname, ".env"));

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const USER_AGENT = "Mozilla/5.0 (compatible; MossCardBot/1.0)";

const FEEDS = [
  // Tech media
  { key: "tc_ai", label: "TechCrunch AI", url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
  { key: "theverge_ai", label: "The Verge AI", url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml" },
  { key: "mittr_ai", label: "MIT Technology Review AI", url: "https://www.technologyreview.com/topic/artificial-intelligence/feed/" },

  // Official / research blogs
  { key: "openai_news", label: "OpenAI News", url: "https://openai.com/news/rss.xml" },
  { key: "google_ai", label: "Google AI", url: "https://blog.google/technology/ai/rss/" },
  { key: "deepmind_blog", label: "deepmind.google", url: "https://deepmind.google/blog/rss.xml" },
  { key: "huggingface_blog", label: "huggingface.com", url: "https://huggingface.co/blog/feed.xml" },
  { key: "ms_research", label: "Microsoft Research", url: "https://www.microsoft.com/en-us/research/feed/" },
  { key: "nvidia_ai", label: "NVIDIA AI Blog", url: "https://blogs.nvidia.com/feed/" },

  // Backward-compatible TechCrunch keys
  { key: "latest", label: "Latest", url: "https://techcrunch.com/feed/" },
  { key: "startups", label: "Startups", url: "https://techcrunch.com/category/startups/feed/" },
  { key: "venture", label: "Venture", url: "https://techcrunch.com/category/venture/feed/" },
  { key: "ai", label: "AI", url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
  { key: "apps", label: "Apps", url: "https://techcrunch.com/category/apps/feed/" },
  { key: "security", label: "Security", url: "https://techcrunch.com/category/security/feed/" },
];

const FEED_CACHE_TTL_MS = 1000 * 60 * 10;
const OG_CACHE_TTL_MS = 1000 * 60 * 60 * 24;
const ARTICLE_CACHE_TTL_MS = 1000 * 60 * 60 * 24;
const OG_CONCURRENCY = 5;
const SNAPSHOT_TTL_MS = 1000 * 60 * 60 * 24;
const TRANSLATE_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 14;
const TRANSLATE_MAX_TEXT = 1200;
const ARTICLE_BODY_MAX_TEXT = 5000;
const TRANSLATE_DEFAULT_TARGET = "ko";
const TRANSLATE_CACHE_VERSION = "v2";
const INSIGHT_PROVIDER_DEFAULT = normalizeInsightProvider(process.env.INSIGHT_PROVIDER || "auto");
const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || "").trim();
const OPENAI_INSIGHT_MODEL = String(process.env.OPENAI_INSIGHT_MODEL || process.env.OPENAI_MODEL || "").trim();
const OPENAI_SUMMARY_MODEL = String(process.env.OPENAI_SUMMARY_MODEL || process.env.OPENAI_MODEL || OPENAI_INSIGHT_MODEL || "").trim();
const OPENAI_RESPONSES_URL = String(process.env.OPENAI_RESPONSES_URL || "https://api.openai.com/v1/responses").trim();
const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_KEY || "").trim();
const GEMINI_INSIGHT_MODEL = String(process.env.GEMINI_INSIGHT_MODEL || process.env.GEMINI_MODEL || process.env.GOOGLE_MODEL || "").trim();
const GEMINI_SUMMARY_MODEL = String(process.env.GEMINI_SUMMARY_MODEL || process.env.GEMINI_MODEL || GEMINI_INSIGHT_MODEL || "").trim();
const GEMINI_API_BASE_URL = String(process.env.GEMINI_API_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/models").trim();
const AI_REQUEST_TIMEOUT_MS = Math.max(4000, Number(process.env.AI_REQUEST_TIMEOUT_MS || 20000));

const feedCache = new Map();
const ogCache = new Map();
const articleCache = new Map();
const snapshotCache = new Map();
const translateCache = new Map();
const CACHE_FILE = path.join(__dirname, "cache.json");
let saveTimer = null;

function loadCacheFromDisk() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const raw = fs.readFileSync(CACHE_FILE, "utf-8");
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed?.feedCache) {
      Object.entries(parsed.feedCache).forEach(([k, v]) => feedCache.set(k, v));
    }
    if (parsed?.ogCache) {
      Object.entries(parsed.ogCache).forEach(([k, v]) => ogCache.set(k, v));
    }
    if (parsed?.articleCache) {
      Object.entries(parsed.articleCache).forEach(([k, v]) => articleCache.set(k, v));
    }
    if (parsed?.snapshots) {
      Object.entries(parsed.snapshots).forEach(([feedKey, byDate]) => {
        const map = new Map();
        Object.entries(byDate || {}).forEach(([date, data]) => map.set(date, data));
        snapshotCache.set(feedKey, map);
      });
    }
    if (parsed?.translateCache) {
      Object.entries(parsed.translateCache).forEach(([k, v]) => translateCache.set(k, v));
    }
    console.log(
      `Cache loaded: feeds=${feedCache.size}, og=${ogCache.size}, article=${articleCache.size}, snapshots=${snapshotCache.size}, translate=${translateCache.size}`,
    );
  } catch (e) {
    console.warn("Failed to load cache.json:", e?.message || e);
  }
}

function scheduleSaveCache() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const snapshotsObj = {};
      snapshotCache.forEach((map, feedKey) => {
        snapshotsObj[feedKey] = Object.fromEntries(map.entries());
      });
      const data = {
        feedCache: Object.fromEntries(feedCache.entries()),
        ogCache: Object.fromEntries(ogCache.entries()),
        articleCache: Object.fromEntries(articleCache.entries()),
        snapshots: snapshotsObj,
        translateCache: Object.fromEntries(translateCache.entries()),
      };
      fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), "utf-8");
      console.log(
        `Cache saved: feeds=${feedCache.size}, og=${ogCache.size}, article=${articleCache.size}, snapshots=${snapshotCache.size}, translate=${translateCache.size}`,
      );
    } catch (e) {
      console.warn("Failed to save cache.json:", e?.message || e);
    }
  }, 500);
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
});

function getFeedByKey(key) {
  return FEEDS.find((f) => f.key === key) || FEEDS[0];
}

function stripHtml(html) {
  if (!html) return "";
  return decodeHtmlEntities(String(html).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

function decodeHtmlEntities(input) {
  if (!input) return "";
  let out = String(input);
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  for (let i = 0; i < 2; i++) {
    out = out
      .replace(/&#(\d+);/g, (_m, dec) => {
        const n = Number(dec);
        return Number.isFinite(n) ? String.fromCodePoint(n) : _m;
      })
      .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
        const n = Number.parseInt(hex, 16);
        return Number.isFinite(n) ? String.fromCodePoint(n) : _m;
      })
      .replace(/&([a-zA-Z]+);/g, (m, name) => named[name] ?? m);
  }
  return out;
}

function firstImageUrlFromHtml(html) {
  if (!html) return "";
  const text = typeof html === "string" ? html : JSON.stringify(html);
  if (!text) return "";
  const m =
    text.match(/<img[^>]+src=["']([^"']+)["']/i) ||
    text.match(/<img[^>]+data-src=["']([^"']+)["']/i) ||
    text.match(/<img[^>]+data-original=["']([^"']+)["']/i);
  return m && m[1] ? m[1] : "";
}

function normalizeUrl(url) {
  if (!url) return "";
  let u = String(url).trim();
  if (u.startsWith("//")) u = "https:" + u;
  if (!/^https?:\/\//i.test(u)) return "";
  return u;
}

function utcDateString(d) {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.valueOf())) return "";
  return date.toISOString().slice(0, 10);
}

function normalizeLangCode(input, fallback) {
  const raw = String(input || fallback || "").trim().toLowerCase();
  if (!raw) return fallback || "auto";
  if (raw === "auto") return "auto";
  if (/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(raw)) return raw;
  return fallback || "auto";
}

function normalizeInsightProvider(input) {
  const raw = String(input || "").trim().toLowerCase();
  if (raw === "openai" || raw === "gemini") return raw;
  return "auto";
}

function normalizeTranslateText(input) {
  return String(input || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TRANSLATE_MAX_TEXT);
}

function _polishKoreanTextLegacy(input, kind = "summary") {
  let out = decodeHtmlEntities(input || "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;!?])/g, "$1")
    .replace(/([([{])\s+/g, "$1")
    .replace(/\s+([)\]}])/g, "$1")
    .replace(/`/g, "")
    .trim();

  if (!out) return out;

  const replacements = [
    [/생성 인공 지능/gi, "생성형 AI"],
    [/생성형 인공지능/gi, "생성형 AI"],
    [/인공 지능/gi, "AI"],
    [/오픈 에이아이/gi, "OpenAI"],
    [/구글 딥마인드/gi, "Google DeepMind"],
    [/딥 마인드/gi, "DeepMind"],
    [/마이크로 소프트/gi, "Microsoft"],
    [/마이크로소프트/gi, "Microsoft"],
    [/엔비디아/gi, "NVIDIA"],
    [/구글 클라우드/gi, "Google Cloud"],
    [/체크 엔진 라이트/gi, "경고등"],
    [/푸시\b/gi, "확대"],
    [/딜\b/gi, "제휴"],
    [/인디아\b/gi, "인도"],
    [/추진 강화/gi, "확장 가속"],
    [/그 어느 때보다 빠르게/gi, "이전보다 훨씬 빠르게"],
    [/움직이도록 압력을 받고 있습니다/gi, "더 빠르게 움직여야 하는 압박을 받고 있습니다"],
    [/자금 조달이 부족하고/gi, "자금 사정이 빠듯하고"],
    [/AI를 사용하여/gi, "AI를 활용하면서"],
  ];
  for (const [re, value] of replacements) out = out.replace(re, value);

  out = out.replace(/이전보다 훨씬 빠르게 더 빠르게/gi, "이전보다 훨씬 빠르게");

  // Quotes and punctuation for Korean readability.
  out = out
    .replace(/'([^']+)'/g, "‘$1’")
    .replace(/"([^"]+)"/g, "“$1”")
    .replace(/\s*:\s*/g, ": ");

  if (kind === "title") {
    out = out.replace(/\.$/, "").trim();
  } else {
    if (!/[.!?。！？]$/.test(out)) out += ".";
  }

  return out;
}

function polishKoreanText(input, kind = "summary") {
  let out = decodeHtmlEntities(input || "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;!?])/g, "$1")
    .replace(/([([{])\s+/g, "$1")
    .replace(/\s+([)\]}])/g, "$1")
    .replace(/`/g, "")
    .trim();

  if (!out) return out;

  const replacements = [
    [/\b오픈\s*에이아이\b/gi, "OpenAI"],
    [/\b구글\s*딥마인드\b/gi, "Google DeepMind"],
    [/\b구글\s*클라우드\b/gi, "Google Cloud"],
    [/\b마이크로\s*소프트\b/gi, "Microsoft"],
    [/\b엔비디아\b/gi, "NVIDIA"],
    [/\b워드프레스\.?컴\b/gi, "WordPress.com"],
    [/\b챗\s*GPT\b/gi, "ChatGPT"],
    [/\b제미나이\b/gi, "Gemini"],
  ];
  for (const [re, value] of replacements) out = out.replace(re, value);

  out = out
    .replace(/'([^']+)'/g, '"$1"')
    .replace(/"([^"]+)"/g, '"$1"')
    .replace(/\s*:\s*/g, ": ")
    .replace(/\s+,/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (kind === "title") {
    out = out.replace(/[.?!]+$/g, "").trim();
  } else if (out && !/[.!?]$/.test(out)) {
    out += ".";
  }

  return out;
}

function translateCacheKey(from, to, text) {
  return `${TRANSLATE_CACHE_VERSION}|${from}|${to}|${text}`;
}

function polishKoreanTextSafe(input, kind = "summary") {
  let out = decodeHtmlEntities(input || "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;!?])/g, "$1")
    .replace(/([([{])\s+/g, "$1")
    .replace(/\s+([)\]}])/g, "$1")
    .replace(/`/g, "")
    .trim();

  if (!out) return out;

  const replacements = [
    [/\bopen\s*ai\b/gi, "OpenAI"],
    [/\bgoogle\s*deepmind\b/gi, "Google DeepMind"],
    [/\bgoogle\s*cloud\b/gi, "Google Cloud"],
    [/\bmicrosoft\b/gi, "Microsoft"],
    [/\bnvidia\b/gi, "NVIDIA"],
    [/\bword\s*press\.?com\b/gi, "WordPress.com"],
    [/\bchat\s*gpt\b/gi, "ChatGPT"],
    [/\bgemini\b/gi, "Gemini"],
  ];
  for (const [re, value] of replacements) out = out.replace(re, value);

  out = out
    .replace(/'([^']+)'/g, '"$1"')
    .replace(/"([^"]+)"/g, '"$1"')
    .replace(/\s*:\s*/g, ": ")
    .replace(/\s+,/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (kind === "title") {
    out = out.replace(/[.?!]+$/g, "").trim();
  } else if (out && !/[.!?]$/.test(out)) {
    out += ".";
  }

  return out;
}

async function translateText(text, toLang = TRANSLATE_DEFAULT_TARGET, fromLang = "auto") {
  const normalizedText = normalizeTranslateText(text);
  if (!normalizedText) return "";

  const to = normalizeLangCode(toLang, TRANSLATE_DEFAULT_TARGET);
  const from = normalizeLangCode(fromLang, "auto");
  const key = translateCacheKey(from, to, normalizedText);
  const cached = translateCache.get(key);
  if (cached && Date.now() - (cached.ts || 0) < TRANSLATE_CACHE_TTL_MS) {
    return cached.val || normalizedText;
  }

  const params = new URLSearchParams({
    client: "gtx",
    sl: from,
    tl: to,
    dt: "t",
    q: normalizedText,
  });
  const url = `https://translate.googleapis.com/translate_a/single?${params.toString()}`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`translate_http_${res.status}`);

  const json = await res.json();
  let translated = "";
  if (Array.isArray(json) && Array.isArray(json[0])) {
    translated = json[0]
      .map((part) => (Array.isArray(part) && typeof part[0] === "string" ? part[0] : ""))
      .join("")
      .trim();
  }
  if (!translated) translated = normalizedText;

  translateCache.set(key, { val: translated, ts: Date.now() });
  scheduleSaveCache();
  return translated;
}

function extractOpenAiResponseText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) return payload.output_text.trim();
  const outputs = Array.isArray(payload?.output) ? payload.output : [];
  const parts = [];
  for (const output of outputs) {
    const content = Array.isArray(output?.content) ? output.content : [];
    for (const item of content) {
      const text = typeof item?.text === "string" ? item.text : typeof item?.output_text === "string" ? item.output_text : "";
      if (text) parts.push(text.trim());
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function extractGeminiResponseText(payload) {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  const parts = [];
  for (const candidate of candidates) {
    const contentParts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    for (const part of contentParts) {
      const text = typeof part?.text === "string" ? part.text : "";
      if (text) parts.push(text.trim());
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function normalizeInsightText(input, lang = "ko") {
  const out = decodeHtmlEntities(String(input || ""))
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;!?])/g, "$1")
    .trim();
  if (!out) return "";
  const clean = out.replace(/^["']|["']$/g, "").trim();
  if (!clean) return "";
  return /[.?!。！？]$/.test(clean) ? clean : `${clean}.`;
}

function normalizeSummaryText(input, lang = "ko") {
  const out = decodeHtmlEntities(String(input || ""))
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;!?])/g, "$1")
    .trim();
  if (!out) return "";
  if (lang === "ko") {
    return out
      .replace(/^["']|["']$/g, "")
      .replace(/\s*\n\s*/g, "\n")
      .replace(/\s{2,}/g, " ")
      .trim();
  }
  return out.replace(/^["']|["']$/g, "").trim();
}

function countTextSentences(input) {
  return String(input || "")
    .split(/(?<=[.!?。！？])\s+/)
    .map((part) => part.trim())
    .filter(Boolean).length;
}

function normalizeAiCompareText(input) {
  return decodeHtmlEntities(String(input || ""))
    .toLowerCase()
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[^0-9a-z\u00C0-\u024F\uAC00-\uD7A3]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildAiTokenSet(input, lang = "ko") {
  const stopwordsCommon = new Set(["update", "launch", "released", "announced", "news", "today", "week", "article"]);
  const stopwordsKo = new Set(["이번", "관련", "통해", "대한", "있는", "했다", "한다", "하며", "위해", "에서", "으로", "에게"]);
  const stopwordsEn = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "about", "over", "under", "their"]);
  const langStops = lang === "ko" ? stopwordsKo : stopwordsEn;
  return new Set(
    normalizeAiCompareText(input)
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => {
        if (!token) return false;
        if (stopwordsCommon.has(token) || langStops.has(token)) return false;
        return /[0-9a-z\uAC00-\uD7A3]/i.test(token) && token.length >= (lang === "ko" ? 2 : 3);
      }),
  );
}

function hasRedundantInsight(insight, summary, title, lang = "ko") {
  const insightText = decodeHtmlEntities(String(insight || "")).replace(/\s+/g, " ").trim();
  const summaryText = decodeHtmlEntities(String(summary || "")).replace(/\s+/g, " ").trim();
  const titleText = decodeHtmlEntities(String(title || "")).replace(/\s+/g, " ").trim();
  if (!insightText || !summaryText) return false;

  const insightNorm = normalizeAiCompareText(insightText);
  const summaryNorm = normalizeAiCompareText(summaryText);
  const titleNorm = normalizeAiCompareText(titleText);
  if (!insightNorm) return true;
  if (summaryNorm.includes(insightNorm)) return true;

  const insightTokens = buildAiTokenSet(insightText, lang);
  const summaryTokens = buildAiTokenSet(summaryText, lang);
  const titleTokens = buildAiTokenSet(titleText, lang);
  if (!insightTokens.size) return true;

  let overlap = 0;
  insightTokens.forEach((token) => {
    if (summaryTokens.has(token) || titleTokens.has(token)) overlap++;
  });
  const overlapRatio = overlap / Math.max(1, insightTokens.size);
  return overlapRatio >= 0.78;
}

function isWeakAiText(input, kind = "summary", lang = "ko") {
  const clean = decodeHtmlEntities(String(input || ""))
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return true;
  const charLen = clean.length;
  const sentenceCount = countTextSentences(clean);
  if (kind === "insight") {
    return lang === "ko" ? charLen < 42 || sentenceCount < 2 : charLen < 80 || sentenceCount < 2;
  }
  return lang === "ko" ? charLen < 70 || sentenceCount < 2 : charLen < 120 || sentenceCount < 2;
}

function buildInsightPrompts(title, summary, articleBody = "", lang = "ko", strict = false) {
  const languageName = lang === "ko" ? "Korean" : "English";
  const bodyExcerpt = normalizeArticleBodyText(articleBody, 2600);
  return {
    systemPrompt:
      strict
        ? "You are an editor writing DEV INSIGHT for AI industry cards. Write exactly 2 complete sentences in the requested language. Do not restate the headline or summarize the article in generic words. Infer the deeper technical angle from the title keywords and summary: architecture, benchmark meaning, deployment consequence, inference cost, workflow change, ecosystem leverage, data advantage, product moat, or infrastructure requirement. The first sentence should identify the most meaningful technical or strategic signal behind the update. The second sentence should explain why that signal matters for developers, users, enterprise adoption, deployment, or competition. Avoid repeating company announcement phrasing. Use only the supplied title and summary. Do not speculate. Never answer with fragments."
        : "You are an editor writing DEV INSIGHT for AI industry cards. Write exactly 2 complete sentences in the requested language. Do not repeat the headline or the first clause of the summary. Infer the technical implication from title keywords and the supplied summary, then explain why it matters. Focus on architecture, benchmark interpretation, deployment impact, inference cost, workflow integration, ecosystem leverage, data advantage, product moat, or infrastructure requirement. Avoid repeating company announcement phrasing. Use only the supplied title and summary. Do not speculate. Do not answer with fragments.",
    userPrompt: [
      `Language: ${languageName}`,
      strict
        ? `Target length: ${lang === "ko" ? "110-190 Korean characters" : "170-290 English characters"}`
        : `Target length: ${lang === "ko" ? "90-170 Korean characters" : "150-250 English characters"}`,
      "Avoid repeating the article summary. Surface the deeper technical implication instead.",
      "Prefer specific technical consequences over generic market commentary.",
      `Title: ${normalizeTranslateText(title).slice(0, 240)}`,
      `Summary: ${normalizeTranslateText(summary).slice(0, 900)}`,
      bodyExcerpt ? `Article body excerpt: ${bodyExcerpt}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function buildSummaryPrompts(title, summary, articleBody = "", lang = "ko", strict = false) {
  const languageName = lang === "ko" ? "Korean" : "English";
  const bodyExcerpt = normalizeArticleBodyText(articleBody, 3200);
  return {
    systemPrompt:
      strict
        ? "You rewrite AI news summaries for ranked cards. Write 2 to 3 complete sentences in the requested language. Mention who announced or released what, what changed in the product, model, benchmark, platform, or deployment, and why it matters in practice. Use only the provided title and summary. Do not invent facts. Never answer with fragments."
        : "You rewrite AI news summaries for ranked cards. Write 2 to 3 complete sentences in the requested language. Cover the company or product, the concrete update or release, and the practical technical or product impact. Use only the provided title and summary. Do not invent facts. Do not answer with fragments.",
    userPrompt: [
      `Language: ${languageName}`,
      strict
        ? `Target length: ${lang === "ko" ? "140-260 Korean characters" : "220-380 English characters"}`
        : `Target length: ${lang === "ko" ? "110-220 Korean characters" : "180-320 English characters"}`,
      `Title: ${normalizeTranslateText(title).slice(0, 240)}`,
      `Source summary: ${normalizeTranslateText(summary).slice(0, 1100)}`,
      bodyExcerpt ? `Article body excerpt: ${bodyExcerpt}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

async function fetchAiJsonWithTimeout(url, options = {}, provider = "ai") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...(options || {}), signal: controller.signal });
    return res;
  } catch (e) {
    const message = String(e?.message || e || "").trim();
    if (e?.name === "AbortError") {
      throw new Error(`${provider}_timeout_${AI_REQUEST_TIMEOUT_MS}`);
    }
    throw new Error(`${provider}_network_error:${message || "request_failed"}`);
  } finally {
    clearTimeout(timer);
  }
}

function getAiErrorStatus(message) {
  const text = String(message || "");
  if (/(openai|gemini)_(api_key|summary_model|insight_model)_missing/i.test(text)) return 503;
  if (/(openai|gemini)_(network_error|timeout_)/i.test(text)) return 502;
  if (/(openai|gemini)_http_4\d\d/i.test(text)) return 502;
  return 500;
}

function logAiRouteError(kind, details) {
  try {
    console.error(`[AI ${kind}]`, JSON.stringify(details));
  } catch (e) {
    console.error(`[AI ${kind}]`, details);
  }
}

function hasOpenAiInsightConfig() {
  return !!OPENAI_API_KEY && !!OPENAI_INSIGHT_MODEL;
}

function hasGeminiInsightConfig() {
  return !!GEMINI_API_KEY && !!GEMINI_INSIGHT_MODEL;
}

function resolveInsightProvider(requestedProvider = "") {
  const requested = normalizeInsightProvider(requestedProvider);
  if (requested === "openai" || requested === "gemini") return requested;
  if (INSIGHT_PROVIDER_DEFAULT === "openai" && hasOpenAiInsightConfig()) return "openai";
  if (INSIGHT_PROVIDER_DEFAULT === "gemini" && hasGeminiInsightConfig()) return "gemini";
  if (hasOpenAiInsightConfig()) return "openai";
  if (hasGeminiInsightConfig()) return "gemini";
  return INSIGHT_PROVIDER_DEFAULT === "gemini" ? "gemini" : "openai";
}

function buildInsightProviderCandidates(requestedProvider = "") {
  const requested = normalizeInsightProvider(requestedProvider);
  if (requested === "openai" || requested === "gemini") return [requested];

  const preferred = normalizeInsightProvider(INSIGHT_PROVIDER_DEFAULT);
  const candidates = [];
  const push = (provider) => {
    if ((provider === "openai" || provider === "gemini") && !candidates.includes(provider)) candidates.push(provider);
  };

  push(preferred);
  if (hasGeminiInsightConfig()) push("gemini");
  if (hasOpenAiInsightConfig()) push("openai");
  if (!candidates.length) push(preferred || "openai");
  return candidates;
}

function getInsightModelForProvider(provider, kind = "insight") {
  const resolvedKind = kind === "summary" ? "summary" : "insight";
  if (provider === "gemini") return resolvedKind === "summary" ? GEMINI_SUMMARY_MODEL || "" : GEMINI_INSIGHT_MODEL || "";
  return resolvedKind === "summary" ? OPENAI_SUMMARY_MODEL || "" : OPENAI_INSIGHT_MODEL || "";
}

async function generateRichAiText(kind, lang, generator, validator = null) {
  const first = await generator(false);
  if (!isWeakAiText(first, kind, lang) && (!validator || validator(first))) return first;
  const second = await generator(true);
  if (!isWeakAiText(second, kind, lang) && (!validator || validator(second))) return second;
  return second || first || "";
}

async function generateCardTextWithProvider(kind, title, summary, lang = "ko", requestedProvider = "", articleBody = "") {
  const resolvedKind = kind === "summary" ? "summary" : "insight";
  const requested = normalizeInsightProvider(requestedProvider);
  const candidates = buildInsightProviderCandidates(requestedProvider);
  const errors = [];

  for (const provider of candidates) {
    try {
        const text =
        resolvedKind === "summary"
          ? provider === "gemini"
            ? await generateGeminiSummary(title, summary, lang, articleBody)
            : await generateOpenAiSummary(title, summary, lang, articleBody)
          : provider === "gemini"
            ? await generateGeminiInsight(title, summary, lang, articleBody)
            : await generateOpenAiInsightStable(title, summary, lang, articleBody);
      return {
        text,
        provider,
        model: getInsightModelForProvider(provider, resolvedKind),
      };
    } catch (e) {
      errors.push(`${provider}:${String(e?.message || e)}`);
      if (requested === "openai" || requested === "gemini") break;
    }
  }

  throw new Error(errors.join(" | ") || `${resolvedKind}_generation_failed`);
}

async function generateOpenAiInsight(title, summary, lang = "ko", articleBody = "") {
  if (!OPENAI_API_KEY) throw new Error("openai_api_key_missing");
  if (!OPENAI_INSIGHT_MODEL) throw new Error("openai_insight_model_missing");

  const languageName = lang === "ko" ? "Korean" : "English";
  const systemPrompt =
    lang === "ko"
      ? "당신은 AI 산업 카드뉴스 편집자입니다. 제목과 요약을 읽고 한 줄짜리 DEV INSIGHT를 작성하세요. 제품, 기술, 아키텍처, 배포 관점에서 핵심 함의를 짚고, 추측이나 과장은 금지합니다. 설명 없이 문장 하나만 반환하세요."
      : "You are an editor writing one-line DEV INSIGHT copy for AI industry cards. Read the title and summary, then produce exactly one concise insight about product, technology, architecture, or deployment impact. Do not speculate. Return one sentence only.";

  const userPrompt = [
    `Language: ${languageName}`,
    `Title: ${normalizeTranslateText(title).slice(0, 240)}`,
    `Summary: ${normalizeTranslateText(summary).slice(0, 900)}`,
    normalizeArticleBodyText(articleBody, 2200) ? `Article body excerpt: ${normalizeArticleBodyText(articleBody, 2200)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const res = await fetchAiJsonWithTimeout(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_INSIGHT_MODEL,
      input: [
        { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
        { role: "user", content: [{ type: "input_text", text: userPrompt }] },
      ],
      max_output_tokens: 90,
    }),
  }, "openai");
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`openai_http_${res.status}:${errText.slice(0, 200)}`);
  }
  const json = await res.json();
  return normalizeInsightText(extractOpenAiResponseText(json), lang);
}

async function generateOpenAiInsightStable(title, summary, lang = "ko", articleBody = "") {
  if (!OPENAI_API_KEY) throw new Error("openai_api_key_missing");
  if (!OPENAI_INSIGHT_MODEL) throw new Error("openai_insight_model_missing");

  return generateRichAiText("insight", lang, async (strict) => {
    const { systemPrompt, userPrompt } = buildInsightPrompts(title, summary, articleBody, lang, strict);
    const res = await fetchAiJsonWithTimeout(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_INSIGHT_MODEL,
        input: [
          { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
          { role: "user", content: [{ type: "input_text", text: userPrompt }] },
        ],
        max_output_tokens: strict ? 180 : 140,
      }),
    }, "openai");
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`openai_http_${res.status}:${errText.slice(0, 200)}`);
    }
    const json = await res.json();
    return normalizeInsightText(extractOpenAiResponseText(json), lang);
  }, (text) => !hasRedundantInsight(text, summary, title, lang));
}

async function generateGeminiInsight(title, summary, lang = "ko", articleBody = "") {
  if (!GEMINI_API_KEY) throw new Error("gemini_api_key_missing");
  if (!GEMINI_INSIGHT_MODEL) throw new Error("gemini_insight_model_missing");

  return generateRichAiText("insight", lang, async (strict) => {
    const { systemPrompt, userPrompt } = buildInsightPrompts(title, summary, articleBody, lang, strict);
    const baseUrl = GEMINI_API_BASE_URL.replace(/\/+$/g, "");
    const apiUrl = `${baseUrl}/${encodeURIComponent(GEMINI_INSIGHT_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
    const res = await fetchAiJsonWithTimeout(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemPrompt }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: userPrompt }],
          },
        ],
        generationConfig: {
          temperature: strict ? 0.15 : 0.2,
          maxOutputTokens: strict ? 180 : 140,
          thinkingConfig: {
            thinkingBudget: 0,
          },
        },
      }),
    }, "gemini");
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`gemini_http_${res.status}:${errText.slice(0, 200)}`);
    }
    const json = await res.json();
    return normalizeInsightText(extractGeminiResponseText(json), lang);
  }, (text) => !hasRedundantInsight(text, summary, title, lang));
}

async function generateOpenAiSummary(title, summary, lang = "ko", articleBody = "") {
  if (!OPENAI_API_KEY) throw new Error("openai_api_key_missing");
  if (!OPENAI_SUMMARY_MODEL) throw new Error("openai_summary_model_missing");

  return generateRichAiText("summary", lang, async (strict) => {
    const { systemPrompt, userPrompt } = buildSummaryPrompts(title, summary, articleBody, lang, strict);
    const res = await fetchAiJsonWithTimeout(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_SUMMARY_MODEL,
        input: [
          { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
          { role: "user", content: [{ type: "input_text", text: userPrompt }] },
        ],
        max_output_tokens: strict ? 320 : 260,
      }),
    }, "openai");
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`openai_http_${res.status}:${errText.slice(0, 200)}`);
    }
    const json = await res.json();
    return normalizeSummaryText(extractOpenAiResponseText(json), lang);
  });
}

async function generateGeminiSummary(title, summary, lang = "ko", articleBody = "") {
  if (!GEMINI_API_KEY) throw new Error("gemini_api_key_missing");
  if (!GEMINI_SUMMARY_MODEL) throw new Error("gemini_summary_model_missing");

  return generateRichAiText("summary", lang, async (strict) => {
    const { systemPrompt, userPrompt } = buildSummaryPrompts(title, summary, articleBody, lang, strict);
    const baseUrl = GEMINI_API_BASE_URL.replace(/\/+$/g, "");
    const apiUrl = `${baseUrl}/${encodeURIComponent(GEMINI_SUMMARY_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
    const res = await fetchAiJsonWithTimeout(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemPrompt }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: userPrompt }],
          },
        ],
        generationConfig: {
          temperature: strict ? 0.15 : 0.2,
          maxOutputTokens: strict ? 320 : 260,
          thinkingConfig: {
            thinkingBudget: 0,
          },
        },
      }),
    }, "gemini");
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`gemini_http_${res.status}:${errText.slice(0, 200)}`);
    }
    const json = await res.json();
    return normalizeSummaryText(extractGeminiResponseText(json), lang);
  });
}

function getSnapshot(feedKey, date) {
  const map = snapshotCache.get(feedKey);
  if (!map) return null;
  return map.get(date) || null;
}

function setSnapshot(feedKey, date, data, force = false) {
  if (!feedKey || !date || !data) return;
  if (!snapshotCache.has(feedKey)) snapshotCache.set(feedKey, new Map());
  const map = snapshotCache.get(feedKey);
  if (!map.has(date)) {
    map.set(date, data);
    scheduleSaveCache();
    return;
  }
  if (force) {
    map.set(date, data);
    scheduleSaveCache();
  }
}

function ensureSnapshotsFromItems(feedKey, items, datesToEnsure = []) {
  if (!feedKey || !Array.isArray(items)) return;
  const dateSet = new Set(datesToEnsure.filter(Boolean));
  if (!dateSet.size) {
    items.forEach((it) => {
      const d = utcDateString(it.pubDate);
      if (d) dateSet.add(d);
    });
  }

  dateSet.forEach((date) => {
    const existing = getSnapshot(feedKey, date);
    if (existing && Date.now() - (existing.ts || 0) < SNAPSHOT_TTL_MS) return;
    const dayItemsRaw = items.filter((it) => utcDateString(it.pubDate) === date);
    const seen = new Set();
    const dayItems = [];
    for (const it of dayItemsRaw) {
      const key = it.guid || it.link || it.title;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      dayItems.push(it);
    }
    if (!dayItems.length) return;
    setSnapshot(
      feedKey,
      date,
      {
        meta: { date, feedKey },
        items: dayItems,
        ts: Date.now(),
      },
      true,
    );
  });
}


async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

async function fetchOgImage(url) {
  if (!url) return "";
  const cached = ogCache.get(url);
  if (cached && Date.now() - cached.ts < OG_CACHE_TTL_MS) return cached.val;

  try {
    console.log(`OG fetch: ${url}`);
    const html = await fetchText(url);
    const $ = cheerio.load(html);
    const og =
      $('meta[property="og:image"]').attr("content") ||
      $('meta[name="og:image"]').attr("content");
    const val = normalizeUrl(og);
    ogCache.set(url, { val, ts: Date.now() });
    scheduleSaveCache();
    console.log(`OG fetched: ${val ? "ok" : "empty"} (${url})`);
    return val;
  } catch {
    ogCache.set(url, { val: "", ts: Date.now() });
    scheduleSaveCache();
    console.log(`OG fetch failed: ${url}`);
    return "";
  }
}

async function enrichImages(items) {
  const queue = items.slice();
  let inFlight = 0;

  return new Promise((resolve) => {
    const next = () => {
      if (!queue.length && inFlight === 0) {
        resolve(items);
        return;
      }
      while (queue.length && inFlight < OG_CONCURRENCY) {
        const item = queue.shift();
        inFlight++;
        (async () => {
          if (!item.imgUrl && item.link) {
            item.imgUrl = await fetchOgImage(item.link);
          }
        })()
          .catch(() => {})
          .finally(() => {
            inFlight--;
            next();
          });
      }
    };
    next();
  });
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function toPlainText(value) {
  if (value == null) return "";
  if (typeof value === "string") return decodeHtmlEntities(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((v) => toPlainText(v)).filter(Boolean).join(" ");
  if (typeof value === "object") {
    if (typeof value["#text"] === "string") return decodeHtmlEntities(value["#text"]);
    if (typeof value.__cdata === "string") return decodeHtmlEntities(value.__cdata);
    return Object.entries(value)
      .filter(([k]) => !String(k).startsWith("@_"))
      .map(([, v]) => toPlainText(v))
      .filter(Boolean)
      .join(" ");
  }
  return decodeHtmlEntities(String(value));
}

function extractLink(linkField) {
  if (!linkField) return "";
  if (typeof linkField === "string") return normalizeUrl(linkField) || linkField.trim();
  if (Array.isArray(linkField)) {
    for (const v of linkField) {
      const url = extractLink(v);
      if (url) return url;
    }
    return "";
  }
  if (typeof linkField === "object") {
    const href = linkField["@_href"] || linkField.href || linkField.url;
    if (typeof href === "string" && href.trim()) return normalizeUrl(href) || href.trim();
    const text = toPlainText(linkField).trim();
    return normalizeUrl(text) || text;
  }
  return "";
}

function cleanSummaryText(text) {
  if (!text) return "";
  return String(text)
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\b\S+\.(png|jpe?g|gif|webp|svg)\b/gi, " ")
    .replace(/\b\d{2,4}x\d{2,4}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeArticleBodyText(text, maxLen = ARTICLE_BODY_MAX_TEXT) {
  if (!text) return "";
  return decodeHtmlEntities(String(text))
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, Math.max(1, maxLen));
}

function getRequestField(req, key, fallback = "") {
  const bodyValue = req?.body && typeof req.body === "object" ? req.body[key] : undefined;
  const queryValue = req?.query ? req.query[key] : undefined;
  const value = bodyValue != null && bodyValue !== "" ? bodyValue : queryValue;
  return value == null ? fallback : value;
}

function dedupeTextBlocks(blocks = []) {
  const out = [];
  const seen = new Set();
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const text = normalizeArticleBodyText(block, ARTICLE_BODY_MAX_TEXT);
    if (!text || text.length < 30) continue;
    const sig = text.toLowerCase();
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(text);
  }
  return out;
}

function extractTextBlocksFromRoot($, root) {
  if (!root || !root.length) return [];
  const clone = root.clone();
  clone.find("script, style, noscript, svg, iframe, form, button, figure, figcaption, aside, nav, footer, .ad, .ads, .advertisement, .related, .newsletter, .social-share, .share, .toolbar, .caption").remove();
  const blocks = [];
  clone.find("p, h2, h3, li").each((_, node) => {
    const text = normalizeArticleBodyText($(node).text(), 700);
    if (!text) return;
    if (/^(related|read more|recommended|subscribe|follow us|advertisement)$/i.test(text)) return;
    blocks.push(text);
  });
  if (!blocks.length) {
    const raw = normalizeArticleBodyText(clone.text(), ARTICLE_BODY_MAX_TEXT);
    if (raw) blocks.push(raw);
  }
  return dedupeTextBlocks(blocks);
}

function pickBestArticleText(candidates = []) {
  let best = "";
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const text = normalizeArticleBodyText(candidate, ARTICLE_BODY_MAX_TEXT);
    if (text.length > best.length) best = text;
  }
  return best;
}

function extractAiTimesArticleBody(html) {
  const $ = cheerio.load(html || "");
  const selectors = [
    "#article-view-content-div",
    ".article-view-content-div",
    ".article-veiw-body",
    ".article-view-body",
    ".view-content",
    ".user-content",
    ".article_txt",
    "article",
  ];
  const candidates = [];
  selectors.forEach((selector) => {
    $(selector).each((_, node) => {
      const blocks = extractTextBlocksFromRoot($, $(node));
      if (blocks.length) candidates.push(blocks.join(" "));
    });
  });
  return pickBestArticleText(candidates);
}

function extractTechCrunchArticleBody(html) {
  const $ = cheerio.load(html || "");
  const selectors = [
    "article .entry-content",
    "article .wp-block-post-content",
    ".entry-content",
    ".wp-block-post-content",
    "article",
  ];
  const candidates = [];
  selectors.forEach((selector) => {
    $(selector).each((_, node) => {
      const blocks = extractTextBlocksFromRoot($, $(node));
      if (blocks.length) candidates.push(blocks.join(" "));
    });
  });
  return pickBestArticleText(candidates);
}

function extractGenericArticleBody(html) {
  const $ = cheerio.load(html || "");
  const selectors = ["article", "main article", ".post-content", ".article-content", ".content"];
  const candidates = [];
  selectors.forEach((selector) => {
    $(selector).each((_, node) => {
      const blocks = extractTextBlocksFromRoot($, $(node));
      if (blocks.length) candidates.push(blocks.join(" "));
    });
  });
  return pickBestArticleText(candidates);
}

function resolveArticleBodyExtractor(url) {
  let host = "";
  try {
    host = new URL(String(url || "")).hostname.replace(/^www\./i, "").toLowerCase();
  } catch (e) {
    host = "";
  }
  if (/aitimes\.com$/i.test(host)) return extractAiTimesArticleBody;
  if (/techcrunch\.com$/i.test(host)) return extractTechCrunchArticleBody;
  return extractGenericArticleBody;
}

async function fetchArticleBody(url) {
  const normalizedUrl = normalizeUrl(url);
  if (!normalizedUrl) throw new Error("article_url_invalid");

  const cached = articleCache.get(normalizedUrl);
  if (cached && Date.now() - (cached.ts || 0) < ARTICLE_CACHE_TTL_MS) return cached;

  const html = await fetchText(normalizedUrl);
  const $ = cheerio.load(html || "");
  const extractor = resolveArticleBodyExtractor(normalizedUrl);
  const bodyText = normalizeArticleBodyText(extractor(html), ARTICLE_BODY_MAX_TEXT);
  const title =
    normalizeArticleBodyText(
      $('meta[property="og:title"]').attr("content") ||
        $("title").first().text() ||
        $("h1").first().text(),
      240,
    ) || "";

  const summary =
    normalizeArticleBodyText(
      $('meta[property="og:description"]').attr("content") ||
        $('meta[name="description"]').attr("content") ||
        "",
      600,
    ) || "";

  const payload = {
    url: normalizedUrl,
    title,
    summary,
    bodyText,
    ts: Date.now(),
  };
  articleCache.set(normalizedUrl, payload);
  scheduleSaveCache();
  return payload;
}

function mapItem(it) {
  const descHtml = toPlainText(it.description || it.summary || "");
  const contentHtml = toPlainText(it["content:encoded"] || it.content || "");
  const summaryHtml = contentHtml || descHtml;
  const enclosureUrl = it.enclosure?.["@_url"] || "";
  const mediaUrl = it["media:content"]?.["@_url"] || it["media:thumbnail"]?.["@_url"] || "";
  const imgUrl = normalizeUrl(mediaUrl || enclosureUrl || firstImageUrlFromHtml(summaryHtml));
  const link = extractLink(it.link || it.id || "");
  const guid = toPlainText(it.guid) || link || toPlainText(it.title);
  const pubDate = toPlainText(it.pubDate || it.published || it.updated || "");
  const title = stripHtml(toPlainText(it.title || "(No title)")) || "(No title)";
  const creator = stripHtml(toPlainText(it["dc:creator"] || it.creator || it.author || ""));
  const categories = toArray(it.category || it.categories)
    .map((c) => stripHtml(toPlainText(c)))
    .filter(Boolean);

  return {
    title,
    link,
    guid,
    pubDate,
    creator,
    categories,
    summaryText: cleanSummaryText(stripHtml(summaryHtml)),
    imgUrl,
  };
}

async function fetchFeed(url) {
  const cached = feedCache.get(url);
  if (cached && Date.now() - cached.ts < FEED_CACHE_TTL_MS) {
    console.log(`Feed cache hit: ${url}`);
    return cached.data;
  }

  console.log(`Feed fetch: ${url}`);
  const xmlText = await fetchText(url);
  const parsed = xmlParser.parse(xmlText);
  const channel = parsed?.rss?.channel || parsed?.channel;
  const itemsRaw = channel?.item || [];
  const itemsArr = Array.isArray(itemsRaw) ? itemsRaw : [itemsRaw];

  const items = itemsArr.map(mapItem);

  await enrichImages(items);
  const data = {
    meta: {
      title: channel?.title || "",
      link: channel?.link || "",
      updated: channel?.lastBuildDate || "",
    },
    items,
  };

  feedCache.set(url, { data, ts: Date.now() });
  scheduleSaveCache();
  console.log(`Feed fetched: items=${items.length}`);
  return data;
}

app.get("/api/feed", async (req, res) => {
  try {
    const cat = String(req.query.cat || req.query.category || "latest").toLowerCase();
    const feed = getFeedByKey(cat);
    console.log(`API /api/feed cat=${feed.key}`);
    const date = String(req.query.date || "").trim();
    if (date) {
      const cachedSnap = getSnapshot(feed.key, date);
      if (cachedSnap) {
        res.json({ ...cachedSnap, feedKey: feed.key, date });
        return;
      }
    }

    const data = await fetchFeed(feed.url);
    // Ensure snapshots from latest items (UTC date buckets)
    ensureSnapshotsFromItems(feed.key, data.items);

    if (date) {
      const snap = getSnapshot(feed.key, date);
      if (snap) {
        res.json({ ...snap, feedKey: feed.key, date });
        return;
      }
      res.status(404).json({ error: "snapshot_not_found", date });
      return;
    }

    res.json({ ...data, feedKey: feed.key });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get("/api/backfill", async (req, res) => {
  try {
    const cat = String(req.query.cat || "latest").toLowerCase();
    const days = Math.max(1, Math.min(30, Number(req.query.days || 7)));
    const feed = getFeedByKey(cat);
    console.log(`API /api/backfill cat=${feed.key} days=${days}`);
    const data = await fetchFeed(feed.url);
    const dates = [];
    const now = new Date();
    for (let i = 0; i < days; i++) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      dates.push(utcDateString(d));
    }
    ensureSnapshotsFromItems(feed.key, data.items, dates);
    res.json({ ok: true, feedKey: feed.key, dates });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get("/api/translate", async (req, res) => {
  try {
    const text = normalizeTranslateText(req.query.text || "");
    if (!text) {
      res.status(400).json({ error: "text_required" });
      return;
    }
    const to = normalizeLangCode(req.query.to, TRANSLATE_DEFAULT_TARGET);
    const from = normalizeLangCode(req.query.from, "auto");
    const kind = String(req.query.kind || "summary").toLowerCase() === "title" ? "title" : "summary";
    const translatedRaw = await translateText(text, to, from);
    const translated = to.startsWith("ko") ? polishKoreanTextSafe(translatedRaw, kind) : translatedRaw;
    res.json({ translated, from, to, kind });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get("/api/article-body", async (req, res) => {
  try {
    const url = normalizeUrl(getRequestField(req, "url", ""));
    if (!url) {
      res.status(400).json({ error: "url_required" });
      return;
    }
    const article = await fetchArticleBody(url);
    res.json({
      url: article.url,
      title: article.title || "",
      summary: article.summary || "",
      bodyText: article.bodyText || "",
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

async function handleSummaryRoute(req, res) {
  try {
    const title = normalizeTranslateText(getRequestField(req, "title", "")).slice(0, 260);
    const summary = normalizeTranslateText(getRequestField(req, "summary", "")).slice(0, 1200);
    const articleBody = normalizeArticleBodyText(getRequestField(req, "bodyText", ""), ARTICLE_BODY_MAX_TEXT);
    const lang = normalizeLangCode(getRequestField(req, "lang", "ko"), "ko").startsWith("en") ? "en" : "ko";
    const provider = getRequestField(req, "provider", "");
    if (!title && !summary && !articleBody) {
      res.status(400).json({ error: "title_or_summary_required" });
      return;
    }
    const result = await generateCardTextWithProvider("summary", title, summary, lang, provider, articleBody);
    res.json({ summary: result.text, lang, model: result.model, provider: result.provider });
  } catch (e) {
    const message = String(e?.message || e);
    const status = getAiErrorStatus(message);
    logAiRouteError("summary", {
      provider: String(getRequestField(req, "provider", "auto") || "auto"),
      lang: normalizeLangCode(getRequestField(req, "lang", "ko"), "ko"),
      title: normalizeTranslateText(getRequestField(req, "title", "")).slice(0, 120),
      status,
      error: message,
    });
    res.status(status).json({ error: message });
  }
}

async function handleInsightRoute(req, res) {
  try {
    const title = normalizeTranslateText(getRequestField(req, "title", "")).slice(0, 260);
    const summary = normalizeTranslateText(getRequestField(req, "summary", "")).slice(0, 1000);
    const articleBody = normalizeArticleBodyText(getRequestField(req, "bodyText", ""), ARTICLE_BODY_MAX_TEXT);
    const lang = normalizeLangCode(getRequestField(req, "lang", "ko"), "ko").startsWith("en") ? "en" : "ko";
    const provider = getRequestField(req, "provider", "");
    if (!title && !summary && !articleBody) {
      res.status(400).json({ error: "title_or_summary_required" });
      return;
    }
    const result = await generateCardTextWithProvider("insight", title, summary, lang, provider, articleBody);
    res.json({ insight: result.text, lang, model: result.model, provider: result.provider });
  } catch (e) {
    const message = String(e?.message || e);
    const status = getAiErrorStatus(message);
    logAiRouteError("insight", {
      provider: String(getRequestField(req, "provider", "auto") || "auto"),
      lang: normalizeLangCode(getRequestField(req, "lang", "ko"), "ko"),
      title: normalizeTranslateText(getRequestField(req, "title", "")).slice(0, 120),
      status,
      error: message,
    });
    res.status(status).json({ error: message });
  }
}

app.get("/api/summary", handleSummaryRoute);
app.post("/api/summary", handleSummaryRoute);

app.get("/api/insight", handleInsightRoute);
app.post("/api/insight", handleInsightRoute);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`RSS backend listening on http://localhost:${PORT}`);
});

loadCacheFromDisk();
