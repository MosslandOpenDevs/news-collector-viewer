import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { XMLParser } from "fast-xml-parser";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { summarizeArticleRuleBased } from "./utils/articleSummary.js";

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

function parseBooleanEnv(value, defaultValue = false) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return !!defaultValue;
  if (["1", "true", "yes", "y", "on"].includes(raw)) return true;
  if (["0", "false", "no", "n", "off"].includes(raw)) return false;
  return !!defaultValue;
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
      if (!key) return;
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
  {
    key: "aitimes_industry",
    label: "AI Times - AI Industry",
    url: "https://www.aitimes.com/news/articleList.html?view_type=sm",
    parser: "aitimes_list",
  },
  { key: "tc_ai", label: "TechCrunch AI", url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
  { key: "rundown_ai", label: "The Rundown AI", url: "https://www.therundown.ai/", parser: "rundown_ai" },
  { key: "superhuman_ai", label: "Superhuman", url: "https://www.superhuman.ai/", parser: "superhuman_ai" },
  { key: "decoder_ai", label: "The Decoder", url: "https://the-decoder.com/feed/", parser: "rss" },
  { key: "tldr_ai", label: "TLDR AI", url: "https://tldr.tech/api/latest/ai", parser: "tldr_ai_digest" },
  { key: "theverge_ai", label: "The Verge AI", url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml" },
  { key: "mittr_ai", label: "MIT Technology Review AI", url: "https://www.technologyreview.com/topic/artificial-intelligence/feed/" },

  // Official / research blogs
  { key: "openai_news", label: "OpenAI News", url: "https://openai.com/news/rss.xml" },
  { key: "google_ai", label: "Google AI", url: "https://blog.google/technology/ai/rss/" },
  { key: "deepmind_blog", label: "deepmind.google", url: "https://deepmind.google/blog/rss.xml" },
  { key: "anthropic_news", label: "anthropic.com", url: "https://www.anthropic.com/news", parser: "anthropic_news" },
  { key: "meta_ai_blog", label: "ai.meta.com", url: "https://ai.meta.com/blog/", parser: "meta_ai_blog" },
  { key: "huggingface_blog", label: "huggingface.com", url: "https://huggingface.co/blog/feed.xml" },
  { key: "anandtech_ai", label: "anandtech.com", url: "https://www.anandtech.com/tag/artificial-intelligence", parser: "anandtech_ai" },
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
const AITIMES_MAX_PAGES = Math.max(1, Number(process.env.AITIMES_MAX_PAGES || 8));
const ENABLE_GEMINI_PROVIDER = parseBooleanEnv(process.env.ENABLE_GEMINI_PROVIDER, false);
const ENABLE_GROQ_PROVIDER = parseBooleanEnv(process.env.ENABLE_GROQ_PROVIDER, true);
const USE_AI_SUMMARY = parseBooleanEnv(process.env.USE_AI_SUMMARY, true);
const INSIGHT_PROVIDER_DEFAULT = normalizeInsightProvider(process.env.INSIGHT_PROVIDER || "auto");
const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || "").trim();
const OPENAI_INSIGHT_MODEL = String(process.env.OPENAI_INSIGHT_MODEL || process.env.OPENAI_MODEL || "").trim();
const OPENAI_SUMMARY_MODEL = String(process.env.OPENAI_SUMMARY_MODEL || process.env.OPENAI_MODEL || OPENAI_INSIGHT_MODEL || "").trim();
const OPENAI_RESPONSES_URL = String(process.env.OPENAI_RESPONSES_URL || "https://api.openai.com/v1/responses").trim();
const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_KEY || "").trim();
const GEMINI_INSIGHT_MODEL = String(process.env.GEMINI_INSIGHT_MODEL || process.env.GEMINI_MODEL || process.env.GOOGLE_MODEL || "").trim();
const GEMINI_SUMMARY_MODEL = String(process.env.GEMINI_SUMMARY_MODEL || process.env.GEMINI_MODEL || GEMINI_INSIGHT_MODEL || "").trim();
const GEMINI_API_BASE_URL = String(process.env.GEMINI_API_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/models").trim();
const GROQ_API_KEY = String(process.env.GROQ_API_KEY || "").trim();
const GROQ_MODEL = String(process.env.GROQ_MODEL || process.env.GROQ_INSIGHT_MODEL || process.env.GROQ_SUMMARY_MODEL || "").trim();
const GROQ_SUMMARY_MODEL = String(process.env.GROQ_SUMMARY_MODEL || GROQ_MODEL || "").trim();
const GROQ_SUMMARY_FALLBACK_MODELS = String(
  process.env.GROQ_SUMMARY_FALLBACK_MODELS || "llama-3.1-8b-instant,llama-3.3-70b-versatile",
)
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean);
const GROQ_API_URL = String(process.env.GROQ_API_URL || "https://api.groq.com/openai/v1/chat/completions").trim();
const AI_REQUEST_TIMEOUT_MS = Math.max(4000, Number(process.env.AI_REQUEST_TIMEOUT_MS || 20000));
const CARD_TEXT_SCHEMA_VERSION = "card_text_v2_groq_throttle";
const CARD_TEXT_CACHE_TTL_MS = 1000 * 60 * 20;

const feedCache = new Map();
const ogCache = new Map();
const articleCache = new Map();
const snapshotCache = new Map();
const translateCache = new Map();
const cardTextCache = new Map();
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
  if (raw === "openai") return "openai";
  if (raw === "gemini") return ENABLE_GEMINI_PROVIDER ? "gemini" : "auto";
  if (raw === "groq") return ENABLE_GROQ_PROVIDER ? "groq" : "auto";
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

function extractGroqResponseText(payload) {
  const choices = Array.isArray(payload?.choices) ? payload.choices : [];
  const parts = [];
  for (const choice of choices) {
    const content = typeof choice?.message?.content === "string" ? choice.message.content : "";
    if (content) parts.push(content.trim());
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function normalizeInsightText(input, lang = "ko") {
  const out = decodeHtmlEntities(String(input || ""))
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;!?])/g, "$1")
    .trim();
  if (!out) return "";
  let clean = out.replace(/^["']|["']$/g, "").trim();
  if (!clean) return "";
  clean = clean
    .replace(/^\*{0,2}\s*dev\s*insight\s*\*{0,2}\s*[:\-]?\s*/i, "")
    .replace(/^\[?\s*dev\s*insight\s*\]?\s*[:\-]?\s*/i, "")
    .replace(/^개발\s*인사이트\s*[:\-]?\s*/i, "")
    .replace(/^인사이트\s*[:\-]?\s*/i, "")
    .trim();
  if (!clean) return "";
  return /[.?!。！？]$/.test(clean) ? clean : `${clean}.`;
}

function normalizeSummaryText(input, lang = "ko") {
  let out = decodeHtmlEntities(String(input || ""))
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;!?])/g, "$1")
    .trim();
  if (!out) return "";
  out = out
    .replace(/^Here(?:'s| is)\s+(?:a\s+)?(?:rewritten|revised|stronger|concise|card[- ]news|news)?[^:：]{0,120}[:：]\s*/i, "")
    .replace(/^다음은\s*[^:：]{0,120}[:：]\s*/i, "")
    .replace(/^(?:요약|Summary|News summary)\s*[:：]\s*/i, "")
    .replace(/^["']|["']$/g, "")
    .trim();
  if (!out) return "";
  if (lang === "ko") {
    return out
      .replace(/\s*\n\s*/g, "\n")
      .replace(/\s{2,}/g, " ")
      .trim();
  }
  return out.trim();
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

function buildInsightAnchorTokenSet(title, summary, articleBody = "", lang = "ko") {
  const minLen = lang === "ko" ? 2 : 3;
  const genericStops = new Set([
    "ai",
    "news",
    "weekly",
    "week",
    "update",
    "updates",
    "release",
    "releases",
    "launch",
    "launches",
    "announced",
    "announcement",
    "announces",
    "model",
    "models",
    "product",
    "products",
    "platform",
    "technology",
    "tech",
    "service",
    "services",
    "feature",
    "features",
    "article",
    "today",
    "industry",
    "insight",
    "dev",
    "report",
    "reports",
    "개발",
    "뉴스",
    "요약",
    "업데이트",
    "출시",
    "발표",
    "서비스",
    "기능",
    "플랫폼",
    "기술",
    "모델",
    "제품",
    "이번",
    "관련",
    "통해",
    "대한",
    "있는",
    "했다",
    "한다",
  ]);

  const scoreMap = new Map();
  const addTokens = (text, weight = 1) => {
    normalizeAiCompareText(text)
      .split(/\s+/)
      .forEach((token) => {
        if (!token || token.length < minLen) return;
        if (genericStops.has(token)) return;
        scoreMap.set(token, (scoreMap.get(token) || 0) + weight);
      });
  };

  const summaryLead = normalizeTranslateText(summary || "")
    .split(/(?<=[.!?。！？])\s+|[\r\n]+/)
    .slice(0, 3)
    .join(" ");
  const bodyLead = normalizeArticleBodyText(articleBody || "", 1400)
    .split(/(?<=[.!?。！？])\s+|[\r\n]+/)
    .slice(0, 4)
    .join(" ");

  addTokens(title || "", 4);
  addTokens(summaryLead, 3);
  addTokens(bodyLead, 2);

  return new Set(
    Array.from(scoreMap.entries())
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return b[0].length - a[0].length;
      })
      .slice(0, 20)
      .map(([token]) => token),
  );
}

function hasInsightContextAnchor(insight, title, summary, articleBody = "", lang = "ko") {
  const insightTokens = buildAiTokenSet(insight, lang);
  if (!insightTokens.size) return false;

  const anchorTokens = buildInsightAnchorTokenSet(title, summary, articleBody, lang);
  if (!anchorTokens.size) return true;

  const titleTokens = buildAiTokenSet(title, lang);
  let overlap = 0;
  let titleOverlap = 0;
  insightTokens.forEach((token) => {
    if (anchorTokens.has(token)) overlap++;
    if (titleTokens.has(token)) titleOverlap++;
  });

  const minOverlap = lang === "ko" ? 1 : 2;
  const overlapRatio = overlap / Math.max(1, insightTokens.size);
  const anchorCoverage = overlap / Math.max(1, Math.min(anchorTokens.size, insightTokens.size));
  if (overlap < minOverlap) return false;
  if (titleTokens.size >= 3 && titleOverlap < 1) return false;
  return overlapRatio >= 0.18 || anchorCoverage >= 0.2;
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
        ? "You write DEV INSIGHT for AI news cards. Output exactly 2 complete sentences in the requested language as plain text. Do not use labels, markdown, bullets, or prefixes. Ground both sentences in explicit terms from the input title, summary, or body (company, product, model, benchmark, API, chip, partnership, policy, or metric). Sentence 1 should state the core technical or strategic implication. Sentence 2 should explain practical impact on deployment, cost, reliability, workflow, adoption, or competition. Do not speculate beyond supplied facts."
        : "You write DEV INSIGHT for AI news cards. Output exactly 2 complete sentences in the requested language as plain text. Do not use labels, markdown, bullets, or prefixes. Use at least one concrete anchor term from the input (company, product, model, benchmark, API, chip, policy, partnership, metric), connect it to a technical implication, then connect that implication to practical impact. Avoid generic market commentary and avoid repeating headline wording.",
    userPrompt: [
      `Language: ${languageName}`,
      strict
        ? `Target length: ${lang === "ko" ? "110-190 Korean characters" : "170-290 English characters"}`
        : `Target length: ${lang === "ko" ? "90-170 Korean characters" : "150-250 English characters"}`,
      "Avoid repeating the article summary. Surface the deeper technical implication instead.",
      "Prefer specific technical consequences over generic market commentary.",
      "Include at least one concrete anchor term copied from the title or summary.",
      "Do not start with DEV INSIGHT or any label.",
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
  const bodyExcerpt = normalizeArticleBodyText(articleBody, 520);
  return {
    systemPrompt:
      strict
        ? "You rewrite AI news summaries for ranked cards. Output only the finished summary text, with no introduction, label, markdown, bullet, or phrase like 'Here is'. Write 2 to 3 complete sentences in the requested language. If the requested language is English, write natural native newsroom English, not a literal translation. Mention who announced or released what, what changed in the product, model, benchmark, platform, or deployment, and why it matters in practice. Use only the provided title, source summary, and article body excerpt. Do not invent facts. Never answer with fragments."
        : "You rewrite AI news summaries for ranked cards. Output only the finished summary text, with no introduction, label, markdown, bullet, or phrase like 'Here is'. Write 2 to 3 complete sentences in the requested language. If the requested language is English, write natural native newsroom English, not a literal translation. Cover the company or product, the concrete update or release, and the practical technical or product impact. Use only the provided title, source summary, and article body excerpt. Do not invent facts. Do not answer with fragments.",
    userPrompt: [
      `Language: ${languageName}`,
      strict
        ? `Target length: ${lang === "ko" ? "120-210 Korean characters" : "180-300 English characters"}`
        : `Target length: ${lang === "ko" ? "100-190 Korean characters" : "160-260 English characters"}`,
      lang === "en"
        ? "English style: concise technology-news prose for a native reader. Avoid translationese, filler such as 'recently' unless needed for timing, and awkward phrases such as 'is a strategy to'. Prefer active verbs like unveiled, launched, added, expanded, integrated, or tested."
        : "Korean style: 바로 기사 요약 본문만 쓰세요. '다음은', '요약:', 'Here is' 같은 머리말을 절대 쓰지 마세요.",
      "Do not change tense. If the source says launched, released, announced, introduced, or added, do not rewrite it as a future plan.",
      `Title: ${normalizeTranslateText(title).slice(0, 240)}`,
      `Source summary: ${normalizeTranslateText(summary).slice(0, 420)}`,
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
  if (/(openai|gemini|groq)_(api_key|summary_model|insight_model)_missing/i.test(text)) return 503;
  if (/(openai|gemini|groq)_(network_error|timeout_)/i.test(text)) return 502;
  if (/(openai|gemini|groq)_http_4\d\d/i.test(text)) return 502;
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
  return ENABLE_GEMINI_PROVIDER && !!GEMINI_API_KEY && !!GEMINI_INSIGHT_MODEL;
}

function hasOpenAiSummaryConfig() {
  return !!OPENAI_API_KEY && !!OPENAI_SUMMARY_MODEL;
}

function hasGeminiSummaryConfig() {
  return ENABLE_GEMINI_PROVIDER && !!GEMINI_API_KEY && !!GEMINI_SUMMARY_MODEL;
}

function hasGroqInsightConfig() {
  return ENABLE_GROQ_PROVIDER && !!GROQ_API_KEY && !!GROQ_MODEL;
}

function hasGroqSummaryConfig() {
  return ENABLE_GROQ_PROVIDER && !!GROQ_API_KEY && !!(GROQ_SUMMARY_MODEL || GROQ_MODEL);
}

function resolveInsightProvider(requestedProvider = "") {
  const requested = normalizeInsightProvider(requestedProvider);
  if (requested === "openai" || requested === "gemini" || requested === "groq") return requested;
  if (INSIGHT_PROVIDER_DEFAULT === "openai" && hasOpenAiInsightConfig()) return "openai";
  if (INSIGHT_PROVIDER_DEFAULT === "gemini" && hasGeminiInsightConfig()) return "gemini";
  if (INSIGHT_PROVIDER_DEFAULT === "groq" && hasGroqInsightConfig()) return "groq";
  if (hasGroqInsightConfig()) return "groq";
  if (hasOpenAiInsightConfig()) return "openai";
  if (hasGeminiInsightConfig()) return "gemini";
  if (INSIGHT_PROVIDER_DEFAULT === "groq") return "groq";
  return INSIGHT_PROVIDER_DEFAULT === "gemini" ? "gemini" : "openai";
}

function buildInsightProviderCandidates(requestedProvider = "") {
  const requested = normalizeInsightProvider(requestedProvider);
  if (requested === "openai" || requested === "gemini" || requested === "groq") return [requested];

  const preferred = normalizeInsightProvider(INSIGHT_PROVIDER_DEFAULT);
  const candidates = [];
  const push = (provider) => {
    if ((provider === "openai" || provider === "gemini" || provider === "groq") && !candidates.includes(provider))
      candidates.push(provider);
  };

  push(preferred);
  if (hasGroqInsightConfig()) push("groq");
  if (hasGeminiInsightConfig()) push("gemini");
  if (hasOpenAiInsightConfig()) push("openai");
  if (!candidates.length) push(preferred || "openai");
  return candidates;
}

function getInsightModelForProvider(provider, kind = "insight") {
  const resolvedKind = kind === "summary" ? "summary" : "insight";
  if (provider === "groq") return resolvedKind === "summary" ? GROQ_SUMMARY_MODEL || GROQ_MODEL || "" : GROQ_MODEL || "";
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
            : provider === "groq"
              ? await generateGroqSummary(title, summary, lang, articleBody)
              : await generateOpenAiSummary(title, summary, lang, articleBody)
          : provider === "gemini"
            ? await generateGeminiInsight(title, summary, lang, articleBody)
            : provider === "groq"
              ? await generateGroqInsight(title, summary, lang, articleBody)
              : await generateOpenAiInsightStable(title, summary, lang, articleBody);
      return {
        text,
        provider,
        model: getInsightModelForProvider(provider, resolvedKind),
      };
    } catch (e) {
      errors.push(`${provider}:${String(e?.message || e)}`);
      if (requested === "openai" || requested === "gemini" || requested === "groq") break;
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
  }, (text) => !hasRedundantInsight(text, summary, title, lang) && hasInsightContextAnchor(text, title, summary, articleBody, lang));
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
  }, (text) => !hasRedundantInsight(text, summary, title, lang) && hasInsightContextAnchor(text, title, summary, articleBody, lang));
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
        max_output_tokens: strict ? 220 : 180,
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
          maxOutputTokens: strict ? 220 : 180,
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

async function generateGroqInsight(title, summary, lang = "ko", articleBody = "") {
  if (!GROQ_API_KEY) throw new Error("groq_api_key_missing");
  if (!GROQ_MODEL) throw new Error("groq_insight_model_missing");

  return generateRichAiText(
    "insight",
    lang,
    async (strict) => {
      const { systemPrompt, userPrompt } = buildInsightPrompts(title, summary, articleBody, lang, strict);
      const res = await fetchAiJsonWithTimeout(
        GROQ_API_URL,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${GROQ_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: GROQ_MODEL,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            temperature: strict ? 0.15 : 0.2,
            max_tokens: strict ? 180 : 140,
          }),
        },
        "groq",
      );
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`groq_http_${res.status}:${errText.slice(0, 200)}`);
      }
      const json = await res.json();
      return normalizeInsightText(extractGroqResponseText(json), lang);
    },
    (text) => !hasRedundantInsight(text, summary, title, lang) && hasInsightContextAnchor(text, title, summary, articleBody, lang),
  );
}

async function generateGroqSummary(title, summary, lang = "ko", articleBody = "") {
  if (!GROQ_API_KEY) throw new Error("groq_api_key_missing");
  const modelCandidates = Array.from(new Set([GROQ_SUMMARY_MODEL || GROQ_MODEL, ...GROQ_SUMMARY_FALLBACK_MODELS].filter(Boolean)));
  if (!modelCandidates.length) throw new Error("groq_summary_model_missing");

  return generateRichAiText("summary", lang, async (strict) => {
    const { systemPrompt, userPrompt } = buildSummaryPrompts(title, summary, articleBody, lang, strict);
    const errors = [];
    for (const model of modelCandidates) {
      const res = await fetchAiJsonWithTimeout(
        GROQ_API_URL,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${GROQ_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            temperature: strict ? 0.15 : 0.2,
            max_tokens: strict ? 160 : 130,
          }),
        },
        "groq",
      );
      if (res.ok) {
        const json = await res.json();
        return normalizeSummaryText(extractGroqResponseText(json), lang);
      }
      const errText = await res.text().catch(() => "");
      const message = `groq_http_${res.status}:${errText.slice(0, 200)}`;
      errors.push(`${model}:${message}`);
      if (!/groq_http_(?:429|5\d\d)/i.test(message)) break;
    }
    throw new Error(errors.join(" | ") || "groq_summary_generation_failed");
  });
}

function buildCardBundlePrompts(ruleDraft, lang = "ko") {
  const languageName = lang === "ko" ? "Korean" : "English";
  const extraction = ruleDraft?.extraction || {};
  const keyFacts = Array.isArray(extraction.keySentences) ? extraction.keySentences.slice(0, 8) : [];
  const firstParagraphs = Array.isArray(extraction.firstParagraphs) ? extraction.firstParagraphs.slice(0, 3) : [];
  const numericFacts = Array.isArray(extraction.numericSentences) ? extraction.numericSentences.slice(0, 3) : [];
  const quoteFacts = Array.isArray(extraction.quoteSentences) ? extraction.quoteSentences.slice(0, 2) : [];

  const systemPrompt =
    "You are a newsroom editor generating AI card copy. Output ONLY strict JSON with keys headline, summary, insight. " +
    "Do not output markdown, labels, or code fences. Use only provided facts and do not invent details. " +
    "headline: one sentence. summary: 3 to 4 full sentences. insight: 1 to 2 full sentences with practical implication.";

  const userPrompt = [
    `Language: ${languageName}`,
    `Rule headline seed: ${normalizeArticleBodyText(ruleDraft?.headline || "", 220)}`,
    `Rule summary seed: ${normalizeArticleBodyText(ruleDraft?.summary || "", 1200)}`,
    `Rule insight seed: ${normalizeArticleBodyText(ruleDraft?.insight || "", 400)}`,
    keyFacts.length ? `Key sentences: ${keyFacts.join(" | ")}` : "",
    firstParagraphs.length ? `First paragraphs: ${firstParagraphs.join(" | ")}` : "",
    numericFacts.length ? `Numeric facts: ${numericFacts.join(" | ")}` : "",
    quoteFacts.length ? `Quote facts: ${quoteFacts.join(" | ")}` : "",
    extraction?.conclusion ? `Conclusion: ${normalizeArticleBodyText(extraction.conclusion, 280)}` : "",
    'Output JSON example: {"headline":"...","summary":"...","insight":"..."}',
  ]
    .filter(Boolean)
    .join("\n");

  return { systemPrompt, userPrompt };
}

function extractJsonObjectText(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return "";
  if (text.startsWith("{") && text.endsWith("}")) return text;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return "";
  return text.slice(start, end + 1).trim();
}

function parseAiCardBundle(rawText, lang = "ko") {
  const jsonText = extractJsonObjectText(rawText);
  if (!jsonText) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(jsonText);
  } catch (_e) {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const headline = normalizeArticleBodyText(parsed.headline || parsed.title || "", 220);
  const summary = normalizeSummaryText(parsed.summary || "", lang);
  const insight = normalizeInsightText(parsed.insight || "", lang);
  if (!headline && !summary && !insight) return null;
  return {
    headline: headline || "",
    summary: summary || "",
    insight: insight || "",
  };
}

function resolveBundleProvider(requestedProvider = "") {
  const requested = normalizeInsightProvider(requestedProvider);
  if (requested === "openai") return hasOpenAiSummaryConfig() ? "openai" : "";
  if (requested === "gemini") return hasGeminiSummaryConfig() ? "gemini" : "";
  if (requested === "groq") return hasGroqSummaryConfig() ? "groq" : "";
  const preferred = resolveInsightProvider(requestedProvider);
  if (preferred === "openai" && hasOpenAiSummaryConfig()) return "openai";
  if (preferred === "gemini" && hasGeminiSummaryConfig()) return "gemini";
  if (preferred === "groq" && hasGroqSummaryConfig()) return "groq";
  if (hasGroqSummaryConfig()) return "groq";
  if (hasOpenAiSummaryConfig()) return "openai";
  if (hasGeminiSummaryConfig()) return "gemini";
  return "";
}

async function generateAiCardBundleSinglePass(ruleDraft, lang = "ko", requestedProvider = "auto") {
  const provider = resolveBundleProvider(requestedProvider);
  if (!provider) throw new Error("ai_provider_unavailable");

  const { systemPrompt, userPrompt } = buildCardBundlePrompts(ruleDraft, lang);
  if (provider === "openai") {
    const model = OPENAI_SUMMARY_MODEL || OPENAI_INSIGHT_MODEL;
    if (!OPENAI_API_KEY || !model) throw new Error("openai_summary_model_missing");
    const res = await fetchAiJsonWithTimeout(
      OPENAI_RESPONSES_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: [
            { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
            { role: "user", content: [{ type: "input_text", text: userPrompt }] },
          ],
          max_output_tokens: 420,
          temperature: 0.2,
        }),
      },
      "openai",
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`openai_http_${res.status}:${errText.slice(0, 200)}`);
    }
    const json = await res.json();
    const parsed = parseAiCardBundle(extractOpenAiResponseText(json), lang);
    if (!parsed) throw new Error("openai_invalid_card_json");
    return { ...parsed, provider: "openai", model };
  }

  if (provider === "groq") {
    const model = GROQ_MODEL;
    if (!GROQ_API_KEY || !model) throw new Error("groq_summary_model_missing");
    const res = await fetchAiJsonWithTimeout(
      GROQ_API_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.2,
          max_tokens: 460,
          response_format: { type: "json_object" },
        }),
      },
      "groq",
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`groq_http_${res.status}:${errText.slice(0, 200)}`);
    }
    const json = await res.json();
    const parsed = parseAiCardBundle(extractGroqResponseText(json), lang);
    if (!parsed) throw new Error("groq_invalid_card_json");
    return { ...parsed, provider: "groq", model };
  }

  const model = GEMINI_SUMMARY_MODEL || GEMINI_INSIGHT_MODEL;
  if (!GEMINI_API_KEY || !model) throw new Error("gemini_summary_model_missing");
  const baseUrl = GEMINI_API_BASE_URL.replace(/\/+$/g, "");
  const apiUrl = `${baseUrl}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const res = await fetchAiJsonWithTimeout(
    apiUrl,
    {
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
          temperature: 0.2,
          maxOutputTokens: 460,
          thinkingConfig: {
            thinkingBudget: 0,
          },
        },
      }),
    },
    "gemini",
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`gemini_http_${res.status}:${errText.slice(0, 200)}`);
  }
  const json = await res.json();
  const parsed = parseAiCardBundle(extractGeminiResponseText(json), lang);
  if (!parsed) throw new Error("gemini_invalid_card_json");
  return { ...parsed, provider: "gemini", model };
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

function stripNewsNoiseText(text) {
  let out = decodeHtmlEntities(String(text || ""));
  if (!out) return "";

  const cutMarkers = [
    /MostPopular/i,
    /Most Popular/i,
    /Top Stories/i,
    /Trending/i,
    /Related Articles/i,
    /인기기사/,
    /많이 본 기사/,
    /많이 본 뉴스/,
    /관련기사/,
    /추천기사/,
    /무단전재/,
    /재배포 금지/,
    /Copyright/i,
  ];

  for (const marker of cutMarkers) {
    const idx = out.search(marker);
    if (idx > 0) {
      out = out.slice(0, idx);
      break;
    }
  }

  out = out
    .replace(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[A-Za-z]{2,}\b/g, " ")
    .replace(/(?:^|\s)(?:AI\s*Times|AITimes|AI타임스)\s*[^\n.!?]{0,120}\b기자\b[^\n.!?]*[.!?]?/gi, " ")
    .replace(/(?:^|\s)[가-힣]{2,6}\s*기자(?:\s*[^\n.!?]{0,80})?[.!?]?/g, " ")
    .replace(/\b(?:입력|수정)\s*\d{4}\.\s*\d{1,2}\.\s*\d{1,2}[^.!?]*[.!?]?/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return out;
}

function isNoisyNewsText(text) {
  const normalized = decodeHtmlEntities(String(text || ""))
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return false;

  const hasSidebarKeyword = /(?:MostPopular|Most Popular|Top Stories|Trending|Related Articles|인기기사|많이 본 기사|많이 본 뉴스|관련기사|추천기사)/i.test(
    normalized,
  );
  const startsWithSidebar = /^(?:MostPopular|Most Popular|인기기사|많이 본 기사|많이 본 뉴스)\b/i.test(normalized);
  const rankMarkerCount = (normalized.match(/(?:^|\s)(?:[1-9]|1[0-5])\s+(?=[^0-9])/g) || []).length;
  const hasReporterByline =
    /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[A-Za-z]{2,}\b/.test(normalized) ||
    /(?:^|\s)(?:AI\s*Times|AITimes|AI타임스)\s*[^\n.!?]{0,120}\b기자\b/i.test(normalized) ||
    /(?:^|\s)[가-힣]{2,6}\s*기자(?:\s|$)/.test(normalized);

  if (startsWithSidebar) return true;
  if (hasSidebarKeyword && /\b1\b.*\b2\b.*\b3\b/.test(normalized)) return true;
  if (rankMarkerCount >= 6) return true;
  if (hasReporterByline && (hasSidebarKeyword || rankMarkerCount >= 2)) return true;
  return false;
}

function cleanSummaryText(text) {
  if (!text) return "";
  const cleaned = stripNewsNoiseText(String(text))
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\b\S+\.(png|jpe?g|gif|webp|svg)\b/gi, " ")
    .replace(/\b\d{2,4}x\d{2,4}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || isNoisyNewsText(cleaned)) return "";
  return cleaned;
}

function normalizeArticleBodyText(text, maxLen = ARTICLE_BODY_MAX_TEXT) {
  if (!text) return "";
  const cleaned = stripNewsNoiseText(String(text))
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || isNoisyNewsText(cleaned)) return "";
  return cleaned.slice(0, Math.max(1, maxLen));
}

function takeLeadSentences(text, maxSentences = 2, maxChars = 360) {
  const normalized = normalizeArticleBodyText(text || "", ARTICLE_BODY_MAX_TEXT);
  if (!normalized) return "";
  const parts = normalized
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((part) => normalizeArticleBodyText(part, 260))
    .filter((part) => part && part.length >= 20 && !isNoisyNewsText(part));
  if (!parts.length) return "";
  const picked = [];
  for (const sentence of parts) {
    if (picked.length >= Math.max(1, maxSentences)) break;
    const joined = [...picked, sentence].join(" ");
    if (joined.length > Math.max(80, maxChars) && picked.length) break;
    picked.push(sentence);
  }
  const out = picked.join(" ").replace(/\s+/g, " ").trim();
  return cleanSummaryText(out);
}

function getRequestField(req, key, fallback = "") {
  const bodyValue = req?.body && typeof req.body === "object" ? req.body[key] : undefined;
  const queryValue = req?.query ? req.query[key] : undefined;
  const value = bodyValue != null && bodyValue !== "" ? bodyValue : queryValue;
  return value == null ? fallback : value;
}

function splitTextIntoSentences(text, maxLen = 420) {
  const normalized = normalizeArticleBodyText(text || "", ARTICLE_BODY_MAX_TEXT);
  if (!normalized) return [];
  return normalized
    .split(/(?<=[.!?。！？])\s+|(?<=다\.)\s+|(?<=니다\.)\s+|(?<=했다\.)\s+/)
    .map((part) => normalizeArticleBodyText(part, maxLen))
    .filter((part) => part && part.length >= 20);
}

function dedupeSentences(sentences = []) {
  const out = [];
  const seen = new Set();
  for (const sentence of Array.isArray(sentences) ? sentences : []) {
    const clean = normalizeArticleBodyText(sentence, 420);
    if (!clean) continue;
    const sig = normalizeAiCompareText(clean);
    if (!sig || seen.has(sig)) continue;
    seen.add(sig);
    out.push(clean);
  }
  return out;
}

function ensureSentenceEnding(text = "", lang = "ko") {
  const clean = normalizeArticleBodyText(text, 420);
  if (!clean) return "";
  if (/[.!?]$/.test(clean)) return clean;
  if (lang === "ko" && /[가-힣]$/.test(clean)) return `${clean}.`;
  return `${clean}.`;
}

function buildRuleBasedExtraction(title, summary, articleBody) {
  const titleText = normalizeArticleBodyText(title || "", 220);
  const summaryText = normalizeArticleBodyText(summary || "", 1200);
  const bodyText = normalizeArticleBodyText(articleBody || "", ARTICLE_BODY_MAX_TEXT);
  const bodySentences = splitTextIntoSentences(bodyText, 420);
  const summarySentences = splitTextIntoSentences(summaryText, 320);
  const allSentences = dedupeSentences([...bodySentences, ...summarySentences]);

  const firstParagraphs = dedupeSentences(allSentences.slice(0, 3));
  const numericSentences = dedupeSentences(
    allSentences.filter((s) =>
      /(?:\d|%|퍼센트|억원|만명|건|달러|원|million|billion|trillion|ms|sec|seconds?|minutes?|hours?|days?|x|배|v\d+)/i.test(s),
    ),
  ).slice(0, 4);
  const quoteSentences = dedupeSentences(
    allSentences.filter((s) => /["“”'‘’]|(?:라고|라며|밝혔다|말했다|전했다|said|according to|stated|noted|wrote)/i.test(s)),
  ).slice(0, 3);
  const conclusion = allSentences.length ? allSentences[allSentences.length - 1] : "";

  const prioritized = [];
  const push = (value) => {
    const sentence = ensureSentenceEnding(value || "", "en");
    if (!sentence) return;
    const sig = normalizeAiCompareText(sentence);
    if (!sig || prioritized.some((x) => normalizeAiCompareText(x) === sig)) return;
    prioritized.push(sentence);
  };

  push(titleText);
  firstParagraphs.forEach(push);
  numericSentences.forEach(push);
  quoteSentences.forEach(push);
  push(conclusion);
  summarySentences.forEach(push);

  return {
    title: titleText,
    firstParagraphs,
    numericSentences,
    quoteSentences,
    conclusion,
    keySentences: prioritized.slice(0, 8),
    bodyText,
    summaryText,
  };
}

function composeRuleSummary(extraction, lang = "ko") {
  const minSentences = 3;
  const maxSentences = 4;
  const minChars = lang === "ko" ? 170 : 240;
  const genericTail =
    lang === "ko"
      ? [
          "핵심 업데이트의 의미는 기능 공개 자체보다 적용 범위와 운영 조건이 얼마나 구체적인지에 달려 있다.",
          "배포 대상과 통합 경로가 명확할수록 실제 서비스 전환 속도와 자동화 품질을 동시에 높일 수 있다.",
        ]
      : [
          "The practical impact depends less on the announcement itself and more on rollout scope and operating constraints.",
          "When target users and integration paths are explicit, teams can scale deployment with better reliability and automation quality.",
        ];

  const pool = dedupeSentences([
    ...(extraction?.keySentences || []),
    ...(extraction?.firstParagraphs || []),
    ...(extraction?.numericSentences || []),
    extraction?.conclusion || "",
  ]).map((s) => ensureSentenceEnding(s, lang));
  const picked = [];
  for (const sentence of pool) {
    if (picked.length >= maxSentences) break;
    picked.push(sentence);
    const joinedLen = normalizeAiCompareText(picked.join(" ")).length;
    if (picked.length >= minSentences && joinedLen >= minChars) break;
  }
  while (picked.length < minSentences) {
    const next = genericTail[picked.length % genericTail.length];
    picked.push(ensureSentenceEnding(next, lang));
  }
  const joined = picked.join(" ").replace(/\s+/g, " ").trim();
  return normalizeSummaryText(joined, lang) || joined;
}

function composeRuleInsight(extraction, lang = "ko") {
  const numericLead = extraction?.numericSentences?.[0] || "";
  const quoteLead = extraction?.quoteSentences?.[0] || "";
  const conclusionLead = extraction?.conclusion || extraction?.firstParagraphs?.[0] || "";

  let insight = "";
  if (numericLead) {
    insight =
      lang === "ko"
        ? `${numericLead} 이 수치는 홍보 지표를 넘어 실제 배포 규모, 비용 구조, 또는 성능 개선 폭을 판단하는 핵심 신호다.`
        : `${numericLead} This metric is more than publicity and acts as a concrete signal of deployment scale, cost profile, or performance gain.`;
  } else if (quoteLead) {
    insight =
      lang === "ko"
        ? `${quoteLead} 핵심은 발표 문구보다 실제 통합 방식과 운영 조건이 명확한지이며, 이 지점이 도입 속도를 결정한다.`
        : `${quoteLead} The key is not the announcement wording itself but whether integration and operating constraints are concrete enough for real adoption.`;
  } else if (conclusionLead) {
    insight =
      lang === "ko"
        ? `${conclusionLead} 결국 이번 이슈의 실효성은 기능 설명보다 배포 가능성과 재현 가능한 운영 시나리오에 달려 있다.`
        : `${conclusionLead} Ultimately, the real value depends less on feature claims and more on deployability and repeatable operating workflows.`;
  } else {
    insight =
      lang === "ko"
        ? "이번 이슈의 핵심은 기능 공개보다 실제 적용 범위와 운영 조건을 얼마나 구체적으로 제시했는지에 있다."
        : "The core signal is not the launch itself but how concretely the article defines real rollout scope and operating constraints.";
  }
  return normalizeInsightText(insight, lang) || ensureSentenceEnding(insight, lang);
}

function composeRuleHeadline(title, extraction, lang = "ko") {
  const titleText = normalizeArticleBodyText(title || extraction?.title || "", 200);
  if (titleText) return titleText;
  const lead = extraction?.firstParagraphs?.[0] || extraction?.keySentences?.[0] || "";
  const cleanLead = normalizeArticleBodyText(lead, 180).replace(/[.!?]+$/g, "").trim();
  if (cleanLead) return cleanLead;
  return lang === "ko" ? "AI 업데이트 요약" : "AI Update Brief";
}

function buildRuleBasedCardDraft(title, summary, articleBody, lang = "ko") {
  const extraction = buildRuleBasedExtraction(title, summary, articleBody);
  const headline = composeRuleHeadline(title, extraction, lang);
  const summaryText = composeRuleSummary(extraction, lang);
  const insight = composeRuleInsight(extraction, lang);
  return {
    headline: normalizeArticleBodyText(headline, 220),
    summary: normalizeArticleBodyText(summaryText, 1400),
    insight: normalizeArticleBodyText(insight, 600),
    extraction: {
      title: extraction.title || "",
      firstParagraphs: extraction.firstParagraphs || [],
      numericSentences: extraction.numericSentences || [],
      quoteSentences: extraction.quoteSentences || [],
      conclusion: extraction.conclusion || "",
      keySentences: extraction.keySentences || [],
    },
  };
}

function buildCardTextResponse({
  kind = "summary",
  lang = "ko",
  headline = "",
  summary = "",
  insight = "",
  source = "rule",
  provider = "rule",
  model = "rule",
  usedAi = false,
  fallback = true,
  extraction = null,
}) {
  return {
    schemaVersion: CARD_TEXT_SCHEMA_VERSION,
    ok: true,
    kind: kind === "insight" ? "insight" : "summary",
    lang: normalizeLangCode(lang, "ko").startsWith("en") ? "en" : "ko",
    source: source || "rule",
    usedAi: !!usedAi,
    fallback: !!fallback,
    provider: provider || "rule",
    model: model || "rule",
    headline: normalizeArticleBodyText(headline, 220),
    summary: normalizeArticleBodyText(summary, 1400),
    insight: normalizeArticleBodyText(insight, 600),
    extraction: extraction && typeof extraction === "object"
      ? {
          title: normalizeArticleBodyText(extraction.title || "", 220),
          firstParagraphs: Array.isArray(extraction.firstParagraphs) ? extraction.firstParagraphs.map((x) => normalizeArticleBodyText(x, 320)).filter(Boolean) : [],
          numericSentences: Array.isArray(extraction.numericSentences) ? extraction.numericSentences.map((x) => normalizeArticleBodyText(x, 320)).filter(Boolean) : [],
          quoteSentences: Array.isArray(extraction.quoteSentences) ? extraction.quoteSentences.map((x) => normalizeArticleBodyText(x, 320)).filter(Boolean) : [],
          conclusion: normalizeArticleBodyText(extraction.conclusion || "", 320),
          keySentences: Array.isArray(extraction.keySentences) ? extraction.keySentences.map((x) => normalizeArticleBodyText(x, 320)).filter(Boolean) : [],
        }
      : {
          title: "",
          firstParagraphs: [],
          numericSentences: [],
          quoteSentences: [],
          conclusion: "",
          keySentences: [],
        },
  };
}

function hashText32(input = "") {
  const text = String(input || "");
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function buildCardTextCacheKey({ title = "", summary = "", articleBody = "", lang = "ko", provider = "auto" }) {
  const raw = [
    normalizeLangCode(lang, "ko"),
    normalizeInsightProvider(provider || "auto"),
    normalizeArticleBodyText(title, 260),
    normalizeArticleBodyText(summary, 1200),
    normalizeArticleBodyText(articleBody, ARTICLE_BODY_MAX_TEXT),
  ].join("|");
  return `card:${hashText32(raw)}`;
}

function getCardTextCache(key) {
  const cached = cardTextCache.get(String(key || ""));
  if (!cached) return null;
  if (Date.now() - (cached.ts || 0) > CARD_TEXT_CACHE_TTL_MS) {
    cardTextCache.delete(String(key || ""));
    return null;
  }
  return cached.value || null;
}

function setCardTextCache(key, value) {
  if (!key || !value) return;
  cardTextCache.set(String(key), { value, ts: Date.now() });
}

function dedupeTextBlocks(blocks = []) {
  const out = [];
  const seen = new Set();
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const text = normalizeArticleBodyText(block, ARTICLE_BODY_MAX_TEXT);
    if (!text || text.length < 30) continue;
    if (isNoisyNewsText(text)) continue;
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
  clone.find("script, style, noscript, svg, iframe, form, button, figure, figcaption, aside, nav, footer, .ad, .ads, .advertisement, .related, .newsletter, .social-share, .share, .toolbar, .caption, .rank, .ranking, .popular, .most-popular, .article-list, .related-list, .news-list").remove();
  const blocks = [];
  clone.find("p, h2, h3, li").each((_, node) => {
    const text = normalizeArticleBodyText($(node).text(), 700);
    if (!text) return;
    if (/^(related|read more|recommended|subscribe|follow us|advertisement)$/i.test(text)) return;
    if (isNoisyNewsText(text)) return;
    blocks.push(text);
  });
  if (!blocks.length) {
    const raw = normalizeArticleBodyText(clone.text(), ARTICLE_BODY_MAX_TEXT);
    if (raw && !isNoisyNewsText(raw)) blocks.push(raw);
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

function toAbsoluteUrl(url, baseUrl = "") {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw, baseUrl || "https://localhost/").href;
  } catch (e) {
    return raw;
  }
}

function dedupeFeedItems(items = []) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const key = String(item?.guid || item?.link || item?.title || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function parseRssFeedText(xmlText) {
  const parsed = xmlParser.parse(xmlText);
  const channel = parsed?.rss?.channel || parsed?.channel || null;
  const atomFeed = parsed?.feed || null;
  const sourceRoot = channel || atomFeed;
  if (!sourceRoot) throw new Error("rss_parse_failed");

  const itemsRaw = channel?.item || atomFeed?.entry || [];
  const itemsArr = Array.isArray(itemsRaw) ? itemsRaw : [itemsRaw];
  const items = dedupeFeedItems(itemsArr.map(mapItem).filter(Boolean));

  return {
    meta: {
      title: toPlainText(sourceRoot?.title || ""),
      link: extractLink(sourceRoot?.link || "") || "",
      updated: toPlainText(sourceRoot?.lastBuildDate || sourceRoot?.updated || ""),
    },
    items,
  };
}

function normalizeAiTimesPubDate(rawDateText) {
  const raw = decodeHtmlEntities(rawDateText || "");
  if (!raw) return "";

  const full = raw.match(/^(\d{4})[.-](\d{2})[.-](\d{2})(?:\s+(\d{2}):(\d{2}))?$/);
  if (full) {
    const y = Number(full[1]);
    const m = Number(full[2]);
    const d = Number(full[3]);
    const hh = Number(full[4] || "0");
    const mm = Number(full[5] || "0");
    const utcMs = Date.UTC(y, m - 1, d, hh - 9, mm, 0);
    if (!Number.isNaN(utcMs)) return new Date(utcMs).toISOString();
    return "";
  }

  const md = raw.match(/^(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (md) {
    const now = new Date();
    let y = now.getFullYear();
    const m = Number(md[1]);
    const d = Number(md[2]);
    const hh = Number(md[3]);
    const mm = Number(md[4]);
    let utcMs = Date.UTC(y, m - 1, d, hh - 9, mm, 0);
    if (utcMs - Date.now() > 36 * 60 * 60 * 1000) {
      y -= 1;
      utcMs = Date.UTC(y, m - 1, d, hh - 9, mm, 0);
    }
    if (!Number.isNaN(utcMs)) return new Date(utcMs).toISOString();
  }
  return "";
}

function normalizeLooseHtmlPubDate(rawDateText) {
  const raw = decodeHtmlEntities(rawDateText || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString();
  const ymd = raw.match(/(\d{4})[./-](\d{1,2})[./-](\d{1,2})/);
  if (ymd) {
    const utcMs = Date.UTC(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]), 0, 0, 0);
    if (!Number.isNaN(utcMs)) return new Date(utcMs).toISOString();
  }
  return "";
}

function firstSrcsetUrl(srcset) {
  return String(srcset || "")
    .split(",")[0]
    ?.trim()
    ?.split(/\s+/)[0] || "";
}

function parseAiTimesList(htmlText, source) {
  const feedUrl = String(source?.url || "");
  const feedLabel = String(source?.label || "AI Times - AI Industry");
  const $ = cheerio.load(String(htmlText || ""));

  const titleRaw = $(".altlist-title").first().contents().first().text() || $(".altlist-title").first().text() || "";
  const meta = {
    title: decodeHtmlEntities(titleRaw).replace(/\s+/g, " ").trim() || feedLabel,
    link: feedUrl,
    updated: "",
  };

  const strictItems = $("li.altlist-webzine-item")
    .map((_idx, row) => {
      const $row = $(row);
      let $subjectLink = $row.find("h2.altlist-subject a").first();
      if (!$subjectLink.length) $subjectLink = $row.find(".altlist-subject a").first();
      if (!$subjectLink.length) $subjectLink = $row.find("a[href*='articleView.html']").first();
      const href = toAbsoluteUrl($subjectLink.attr("href") || "", feedUrl);
      const titleText = decodeHtmlEntities($subjectLink.text() || "").replace(/\s+/g, " ").trim();
      let summaryText = cleanSummaryText(decodeHtmlEntities($row.find(".altlist-summary").first().text() || ""));
      if (!summaryText || isNoisyNewsText(summaryText)) {
        const rowFallback = cleanSummaryText(decodeHtmlEntities($row.text() || "").replace(titleText, " "));
        summaryText = takeLeadSentences(rowFallback, 2, 340);
      }
      const $imgNode = $row.find("a.altlist-image img, .altlist-image img").first();
      const imgRaw = toAbsoluteUrl(
        $imgNode.attr("src") || $imgNode.attr("data-src") || $imgNode.attr("data-original") || "",
        feedUrl,
      );
      const info = $row
        .find(".altlist-info .altlist-info-item")
        .map((_infoIdx, node) => decodeHtmlEntities($(node).text() || "").replace(/\s+/g, " ").trim())
        .get();
      const category = info[0] || "AI Industry";
      const creator = info[1] || "AI Times";
      const pubDate = normalizeAiTimesPubDate(info[2] || "") || new Date().toISOString();
      const idxMatch = href.match(/[?&]idxno=(\d+)/i);
      const guid = idxMatch?.[1] ? `aitimes-${idxMatch[1]}` : href || titleText;
      if (!href || !titleText) return null;
      return {
        title: titleText,
        link: href,
        guid,
        pubDate,
        creator,
        categories: category ? [category] : ["AI Industry"],
        summaryText,
        imgUrl: normalizeUrl(imgRaw),
      };
    })
    .get()
    .filter(Boolean);

  const strictDeduped = dedupeFeedItems(strictItems);
  if (strictDeduped.length) {
    return { meta, items: strictDeduped };
  }

  // Fallback parser: recover items even when list classes/layout change.
  const seen = new Set();
  const fallbackItems = [];
  $("a[href*='articleView.html']").each((_idx, anchor) => {
    if (fallbackItems.length >= 120) return false;
    const $anchor = $(anchor);
    const href = toAbsoluteUrl($anchor.attr("href") || "", feedUrl);
    if (!href || !/[?&]idxno=\d+/i.test(href)) return;
    const idxMatch = href.match(/[?&]idxno=(\d+)/i);
    const guid = idxMatch?.[1] ? `aitimes-${idxMatch[1]}` : href;
    if (!guid || seen.has(guid)) return;

    const titleText = cleanSummaryText(decodeHtmlEntities($anchor.text() || ""));
    if (!titleText || titleText.length < 10) return;

    const $scope = $anchor.closest("li,article,section,div");
    const $block = $scope.length ? $scope.first() : $anchor.parent();

    const blockText = decodeHtmlEntities($block.text() || "").replace(/\s+/g, " ").trim();
    let summaryText = cleanSummaryText(
      decodeHtmlEntities(
        $block.find(".altlist-summary, .summary, .article-summary, .list-summary, p").first().text() || "",
      ),
    );
    if (!summaryText && blockText) {
      const fallbackRaw = cleanSummaryText(blockText.replace(titleText, " "));
      summaryText = takeLeadSentences(fallbackRaw, 2, 340);
    }
    if (isNoisyNewsText(summaryText)) summaryText = "";

    const $imgNode = $block.find("img").first();
    const imgRaw = toAbsoluteUrl(
      $imgNode.attr("src") || $imgNode.attr("data-src") || $imgNode.attr("data-original") || firstSrcsetUrl($imgNode.attr("srcset")),
      feedUrl,
    );

    const dateMatch = blockText.match(
      /(\d{4}[./-]\d{1,2}[./-]\d{1,2}\s+\d{1,2}:\d{2})|(\d{2}[./-]\d{2}\s+\d{1,2}:\d{2})/,
    );
    const creatorMatch = blockText.match(/([가-힣]{2,4}\s*기자)/);
    const categoryMatch = blockText.match(/(산업일반|메타버스|AI 기업|AI기업|영어뉴스|English News|기타|정책|AI산업)/i);

    const creator = cleanSummaryText(creatorMatch?.[1] || "AI Times");
    const category = cleanSummaryText(categoryMatch?.[1] || "AI Industry");
    const pubDate =
      normalizeAiTimesPubDate(dateMatch?.[0] || "") ||
      normalizeLooseHtmlPubDate(dateMatch?.[0] || "") ||
      new Date().toISOString();

    seen.add(guid);
    fallbackItems.push({
      title: titleText,
      link: href,
      guid,
      pubDate,
      creator,
      categories: category ? [category] : ["AI Industry"],
      summaryText,
      imgUrl: normalizeUrl(imgRaw),
    });
  });

  return { meta, items: dedupeFeedItems(fallbackItems) };
}

function parseGenericAnchorFeed(htmlText, source, options = {}) {
  const feedUrl = String(source?.url || "");
  const $ = cheerio.load(String(htmlText || ""));
  const meta = {
    title: decodeHtmlEntities($("title").first().text() || source?.label || source?.key || "").replace(/\s+/g, " ").trim(),
    link: feedUrl,
    updated: "",
  };

  const hrefPattern = options.hrefPattern instanceof RegExp ? options.hrefPattern : /.*/i;
  const items = [];
  const seen = new Set();

  $("a[href]").each((_idx, anchor) => {
    if (items.length >= 60) return false;
    const $anchor = $(anchor);
    const href = toAbsoluteUrl($anchor.attr("href") || "", feedUrl);
    const titleText = decodeHtmlEntities($anchor.text() || "").replace(/\s+/g, " ").trim();
    if (!href || !titleText || titleText.length < 14) return;
    if (!hrefPattern.test(href)) return;
    if (options.excludePattern && options.excludePattern.test(href)) return;

    const key = href.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    const $container = $anchor.closest("article, li, section, div");
    const $scope = $container.length ? $container.first() : $anchor.parent();
    const summaryText = cleanSummaryText(
      decodeHtmlEntities(
        $scope.find("p").first().text() ||
          $scope.find("[class*='summary'], [class*='excerpt'], [class*='dek']").first().text() ||
          "",
      )
        .replace(/\s+/g, " ")
        .trim(),
    );
    const $timeNode = $scope.find("time").first();
    const pubDate =
      normalizeLooseHtmlPubDate($timeNode.attr("datetime") || $timeNode.text() || "") || new Date().toISOString();
    const $imgNode = $scope.find("img").first();
    const imgRaw = toAbsoluteUrl(
      $imgNode.attr("src") || $imgNode.attr("data-src") || firstSrcsetUrl($imgNode.attr("srcset") || ""),
      feedUrl,
    );
    items.push({
      title: titleText,
      link: href,
      guid: href,
      pubDate,
      creator: source?.label || "",
      categories: options.category ? [options.category] : [],
      summaryText,
      imgUrl: normalizeUrl(imgRaw),
    });
  });

  return { meta, items: dedupeFeedItems(items) };
}

function collectTldrJsonEntries(value, out = []) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectTldrJsonEntries(entry, out));
    return out;
  }
  if (!value || typeof value !== "object") return out;

  const title =
    decodeHtmlEntities(value.title || value.headline || value.name || value.subject || "").replace(/\s+/g, " ").trim();
  const link = toAbsoluteUrl(value.url || value.link || value.href || value.article_url || "", "https://tldr.tech/");
  const summaryText = cleanSummaryText(
    decodeHtmlEntities(value.summary || value.description || value.body || value.text || value.content || "")
      .replace(/\s+/g, " ")
      .trim(),
  );
  const pubDate =
    normalizeLooseHtmlPubDate(value.pubDate || value.publishedAt || value.published_at || value.date || value.updatedAt || "") ||
    new Date().toISOString();
  const sectionTitle = decodeHtmlEntities(value.section || value.category || value.topic || value.tag || "").replace(/\s+/g, " ").trim();
  const imgUrl = normalizeUrl(
    toAbsoluteUrl(
      value.image || value.imageUrl || value.image_url || value.thumbnail || value.thumbnailUrl || "",
      "https://tldr.tech/",
    ),
  );

  if (title && link) {
    out.push({
      title,
      link,
      guid: `tldr:${link}`,
      pubDate,
      creator: "TLDR AI",
      categories: sectionTitle ? [sectionTitle] : ["Newsletter"],
      summaryText,
      imgUrl,
    });
  }

  Object.values(value).forEach((child) => {
    if (child && typeof child === "object") collectTldrJsonEntries(child, out);
  });
  return out;
}

function parseTldrAiDigest(payloadText, source) {
  const raw = String(payloadText || "").trim();
  if (raw.startsWith("{") || raw.startsWith("[")) {
    try {
      const json = JSON.parse(raw);
      const items = dedupeFeedItems(collectTldrJsonEntries(json)).slice(0, 60);
      return {
        meta: {
          title: String(source?.label || "TLDR AI"),
          link: "https://tldr.tech/ai",
          updated: normalizeLooseHtmlPubDate(json?.date || json?.updated || "") || "",
        },
        items,
      };
    } catch (e) {}
  }

  const feedUrl = String(source?.url || "https://tldr.tech/ai");
  const $ = cheerio.load(raw);
  const pageTitle = decodeHtmlEntities($("title").first().text() || source?.label || "TLDR AI")
    .replace(/\s+/g, " ")
    .trim();
  const headingText = decodeHtmlEntities($("h1").first().text() || "");
  const dateMatch = headingText.match(/(\d{4})-(\d{2})-(\d{2})/);
  const pubDate =
    dateMatch
      ? new Date(Date.UTC(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]), 0, 0, 0)).toISOString()
      : new Date().toISOString();

  const items = [];
  const seen = new Set();
  $("section").each((_sectionIdx, section) => {
    const $section = $(section);
    const sectionTitle = decodeHtmlEntities($section.find("header h3").first().text() || "")
      .replace(/\s+/g, " ")
      .trim();
    $section.find("article").each((_articleIdx, article) => {
      const $article = $(article);
      const $linkEl = $article.find("a[href]").first();
      const href = toAbsoluteUrl($linkEl.attr("href") || "", "https://tldr.tech/");
      const titleText = decodeHtmlEntities($linkEl.find("h3").first().text() || $linkEl.text() || "")
        .replace(/\s+/g, " ")
        .trim();
      const summaryText = cleanSummaryText(
        decodeHtmlEntities($article.find(".newsletter-html").first().text() || "")
          .replace(/\s+/g, " ")
          .trim(),
      );
      if (!href || !titleText) return;
      if (/sponsor/i.test(titleText) || /sponsor/i.test(sectionTitle)) return;
      const guid = `tldr:${href}`;
      if (seen.has(guid)) return;
      seen.add(guid);
      items.push({
        title: titleText,
        link: href,
        guid,
        pubDate,
        creator: "TLDR AI",
        categories: sectionTitle ? [sectionTitle] : ["Newsletter"],
        summaryText,
        imgUrl: "",
      });
    });
  });

  return {
    meta: {
      title: pageTitle || String(source?.label || "TLDR AI"),
      link: feedUrl,
      updated: pubDate,
    },
    items: dedupeFeedItems(items),
  };
}

function parseFeedPayloadForSource(source, payloadText) {
  const parserType = String(source?.parser || "");
  if (parserType === "aitimes_list" || source?.key === "aitimes_industry") {
    return parseAiTimesList(payloadText, source);
  }
  if (parserType === "rundown_ai") {
    return parseGenericAnchorFeed(payloadText, source, {
      hrefPattern: /\/p\/[^/?#]+/i,
      category: "Newsletter",
    });
  }
  if (parserType === "superhuman_ai") {
    return parseGenericAnchorFeed(payloadText, source, {
      hrefPattern: /\/p\/[^/?#]+/i,
      category: "Newsletter",
    });
  }
  if (parserType === "tldr_ai_digest") {
    return parseTldrAiDigest(payloadText, source);
  }
  if (parserType === "anthropic_news") {
    return parseGenericAnchorFeed(payloadText, source, {
      hrefPattern: /\/news\/[^/]+/i,
      category: "Company",
    });
  }
  if (parserType === "meta_ai_blog") {
    return parseGenericAnchorFeed(payloadText, source, {
      hrefPattern: /\/blog\/[^/]+/i,
      excludePattern: /\/blog\/?$/i,
      category: "Technology",
    });
  }
  if (parserType === "anandtech_ai") {
    return parseGenericAnchorFeed(payloadText, source, {
      hrefPattern: /\/show\/\d+/i,
      category: "Hardware",
    });
  }
  return parseRssFeedText(payloadText);
}

function buildAiTimesPagedUrl(baseUrl, page) {
  const safePage = Math.max(1, Number(page) || 1);
  try {
    const url = new URL(String(baseUrl || ""));
    if (safePage <= 1) {
      url.searchParams.delete("page");
      url.searchParams.delete("pageNo");
      return url.href;
    }
    url.searchParams.set("page", String(safePage));
    return url.href;
  } catch (e) {
    const raw = String(baseUrl || "").trim();
    if (!raw || safePage <= 1) return raw;
    return `${raw}${raw.includes("?") ? "&" : "?"}page=${safePage}`;
  }
}

async function fetchAiTimesPagedItems(source, maxPages = AITIMES_MAX_PAGES) {
  if (!source?.url) return { meta: { title: source?.label || "", link: "", updated: "" }, items: [] };
  const rawPages = Number(maxPages);
  const pages = Number.isFinite(rawPages) ? Math.max(1, rawPages) : Number.POSITIVE_INFINITY;
  const seen = new Set();
  const out = [];
  let meta = { title: String(source?.label || ""), link: String(source?.url || ""), updated: "" };

  for (let page = 1; page <= pages; page++) {
    const pageUrl = buildAiTimesPagedUrl(source.url, page);
    let payloadText = "";
    try {
      payloadText = await fetchText(pageUrl);
    } catch (e) {
      if (page === 1) throw e;
      break;
    }

    const parsed = parseAiTimesList(payloadText, { ...source, url: pageUrl });
    if (parsed?.meta?.title) meta = parsed.meta;
    if (!Array.isArray(parsed?.items) || !parsed.items.length) break;

    let added = 0;
    for (const item of parsed.items) {
      const key = String(item?.guid || item?.link || item?.title || "").trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
      added++;
    }
    if (page > 1 && added === 0) break;
  }

  return { meta, items: out };
}

async function fetchSourceItemsWithParser(source) {
  if (!source?.url) return { meta: { title: source?.label || "", link: "", updated: "" }, items: [] };
  const parserType = String(source?.parser || "");
  if (parserType === "aitimes_list" || source?.key === "aitimes_industry") {
    return await fetchAiTimesPagedItems(source);
  }
  const payloadText = await fetchText(source.url);
  return parseFeedPayloadForSource(source, payloadText);
}

function buildFeedCacheKey(feed) {
  if (feed && typeof feed === "object") {
    return `feed:${String(feed.key || feed.url || "default")}:${String(feed.parser || "rss")}`;
  }
  return String(feed || "");
}

async function fetchFeed(feedInput) {
  const feed =
    feedInput && typeof feedInput === "object"
      ? feedInput
      : { key: "", label: "", url: String(feedInput || ""), parser: "" };
  const cacheKey = buildFeedCacheKey(feed);
  const cached = feedCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < FEED_CACHE_TTL_MS) {
    console.log(`Feed cache hit: ${cacheKey}`);
    return cached.data;
  }

  if (!feed?.url) throw new Error("feed_url_invalid");

  console.log(`Feed fetch: ${feed.url}`);
  const data = feed?.parser ? await fetchSourceItemsWithParser(feed) : parseRssFeedText(await fetchText(feed.url));
  await enrichImages(data.items || []);

  feedCache.set(cacheKey, { data, ts: Date.now() });
  scheduleSaveCache();
  console.log(`Feed fetched: items=${data.items?.length || 0}`);
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

    const data = await fetchFeed(feed);
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
    const data = await fetchFeed(feed);
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
    const summary = normalizeTranslateText(getRequestField(req, "summary", "")).slice(0, 520);
    const articleBody = normalizeArticleBodyText(getRequestField(req, "bodyText", ""), 720);
    const lang = normalizeLangCode(getRequestField(req, "lang", "ko"), "ko").startsWith("en") ? "en" : "ko";
    const provider = String(getRequestField(req, "provider", "auto") || "auto");
    const summaryCacheKey = `summary:${buildCardTextCacheKey({ title, summary, articleBody, lang, provider })}`;
    const cachedSummary = getCardTextCache(summaryCacheKey);
    if (cachedSummary && cachedSummary.source === "ai") {
      res.json(cachedSummary);
      return;
    }
    const rawText = [articleBody, summary].filter(Boolean).join("\n\n");
    const result = summarizeArticleRuleBased({
      title,
      rawText,
      lang,
    });

    // Debug visibility for operations without exposing errors to users.
    console.log(
      `[summary-rule] quality=${result.qualityScore} fallback=${result.usedFallback} skip=${result.shouldSkip} selected=${JSON.stringify(result.debug?.selectedSentences || [])}`,
    );

    let finalSummary = result.summary || "";
    let qualityScore = Number(result.qualityScore || 0);
    let shouldSkip = Boolean(result.shouldSkip);
    let usedFallback = Boolean(result.usedFallback);
    let source = "rule";
    let providerName = "rule";
    let modelName = "extractive-v1";
    let aiSummaryFailed = false;

    if (USE_AI_SUMMARY) {
      try {
        const ai = await generateCardTextWithProvider(
          "summary",
          title,
          summary || result.summary || "",
          lang,
          provider,
          articleBody,
        );
        const aiText = normalizeSummaryText(ai?.text || "", lang);
        if (aiText && !isWeakAiText(aiText, "summary", lang)) {
          finalSummary = aiText;
          qualityScore = Math.max(72, Number(qualityScore || 0));
          shouldSkip = false;
          usedFallback = false;
          source = "ai";
          providerName = ai?.provider || "ai";
          modelName = ai?.model || "unknown";
        }
      } catch (e) {
        aiSummaryFailed = true;
        const message = String(e?.message || e);
        const status = getAiErrorStatus(message);
        logAiRouteError("summary_ai", {
          provider: provider || "auto",
          lang,
          title: normalizeTranslateText(title).slice(0, 120),
          status,
          error: message,
        });
      }
    }

    if (USE_AI_SUMMARY && source !== "ai") {
      shouldSkip = true;
      usedFallback = true;
      if (aiSummaryFailed) qualityScore = Math.min(Number(qualityScore || 0), 39);
    }

    const responsePayload = {
      schemaVersion: "summary_rule_v1",
      ok: true,
      kind: "summary",
      source,
      provider: providerName,
      model: modelName,
      lang,
      summary: finalSummary,
      qualityScore,
      usedFallback,
      shouldSkip,
      debug: {
        cleanedLength: Number(result.debug?.cleanedLength || 0),
        candidateCount: Number(result.debug?.candidateCount || 0),
        selectedSentences: Array.isArray(result.debug?.selectedSentences) ? result.debug.selectedSentences : [],
        topScored: Array.isArray(result.debug?.topScored) ? result.debug.topScored : [],
      },
    };
    if (source === "ai") setCardTextCache(summaryCacheKey, responsePayload);
    res.json(responsePayload);
  } catch (e) {
    const lang = normalizeLangCode(getRequestField(req, "lang", "ko"), "ko").startsWith("en") ? "en" : "ko";
    const title = normalizeTranslateText(getRequestField(req, "title", "")).slice(0, 260);
    const fallback = summarizeArticleRuleBased({
      title,
      rawText: "",
      lang,
    });
    // Never expose backend errors to end-user payload. Keep fixed schema.
    res.json({
      schemaVersion: "summary_rule_v1",
      ok: true,
      kind: "summary",
      source: "rule",
      provider: "rule",
      model: "extractive-v1",
      lang,
      summary: fallback.summary || (title ? `${title}.` : ""),
      qualityScore: Number(fallback.qualityScore || 0),
      usedFallback: true,
      shouldSkip: true,
      debug: {
        cleanedLength: Number(fallback.debug?.cleanedLength || 0),
        candidateCount: Number(fallback.debug?.candidateCount || 0),
        selectedSentences: Array.isArray(fallback.debug?.selectedSentences) ? fallback.debug.selectedSentences : [],
        topScored: Array.isArray(fallback.debug?.topScored) ? fallback.debug.topScored : [],
      },
    });
  }
}

async function handleInsightRoute(req, res) {
  try {
    const title = normalizeTranslateText(getRequestField(req, "title", "")).slice(0, 260);
    const summary = normalizeTranslateText(getRequestField(req, "summary", "")).slice(0, 1000);
    const articleBody = normalizeArticleBodyText(getRequestField(req, "bodyText", ""), ARTICLE_BODY_MAX_TEXT);
    const lang = normalizeLangCode(getRequestField(req, "lang", "ko"), "ko").startsWith("en") ? "en" : "ko";
    const provider = String(getRequestField(req, "provider", "auto") || "auto");

    const ruleDraft = buildRuleBasedCardDraft(title, summary, articleBody, lang);
    let finalHeadline = ruleDraft.headline;
    let finalSummary = ruleDraft.summary;
    let finalInsight = ruleDraft.insight;
    let usedAi = false;
    let source = "rule";
    let providerName = "rule";
    let modelName = "rule";

    if (USE_AI_SUMMARY) {
      const cacheKey = buildCardTextCacheKey({ title, summary, articleBody, lang, provider });
      let aiBundle = getCardTextCache(cacheKey);
      if (!aiBundle) {
        try {
          aiBundle = await generateAiCardBundleSinglePass(ruleDraft, lang, provider);
          setCardTextCache(cacheKey, aiBundle);
        } catch (e) {
          const message = String(e?.message || e);
          const status = getAiErrorStatus(message);
          logAiRouteError("insight_bundle", {
            provider: provider || "auto",
            lang,
            title: normalizeTranslateText(title).slice(0, 120),
            status,
            error: message,
          });
        }
      }

      if (aiBundle && typeof aiBundle === "object") {
        const aiHeadline = normalizeArticleBodyText(aiBundle.headline || "", 220);
        const aiSummary = normalizeSummaryText(aiBundle.summary || "", lang);
        const aiInsight = normalizeInsightText(aiBundle.insight || "", lang);
        if (aiHeadline && aiHeadline.length >= 8) finalHeadline = aiHeadline;
        if (aiSummary && !isWeakAiText(aiSummary, "summary", lang)) finalSummary = aiSummary;
        if (aiInsight && !isWeakAiText(aiInsight, "insight", lang)) {
          finalInsight = aiInsight;
          usedAi = true;
        }
        if (usedAi) {
          source = "ai";
          providerName = aiBundle.provider || "ai";
          modelName = aiBundle.model || "unknown";
        }
      }
    }

    const payload = buildCardTextResponse({
      kind: "insight",
      lang,
      headline: finalHeadline,
      summary: finalSummary,
      insight: finalInsight,
      source,
      provider: providerName,
      model: modelName,
      usedAi,
      fallback: !usedAi,
      extraction: ruleDraft.extraction,
    });
    res.json(payload);
  } catch (e) {
    const lang = normalizeLangCode(getRequestField(req, "lang", "ko"), "ko").startsWith("en") ? "en" : "ko";
    const fallbackDraft = buildRuleBasedCardDraft(
      normalizeTranslateText(getRequestField(req, "title", "")).slice(0, 260),
      normalizeTranslateText(getRequestField(req, "summary", "")).slice(0, 1200),
      normalizeArticleBodyText(getRequestField(req, "bodyText", ""), ARTICLE_BODY_MAX_TEXT),
      lang,
    );
    res.json(
      buildCardTextResponse({
        kind: "insight",
        lang,
        headline: fallbackDraft.headline,
        summary: fallbackDraft.summary,
        insight: fallbackDraft.insight,
        source: "rule",
        provider: "rule",
        model: "rule",
        usedAi: false,
        fallback: true,
        extraction: fallbackDraft.extraction,
      }),
    );
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
