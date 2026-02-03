import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { XMLParser } from "fast-xml-parser";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const USER_AGENT = "Mozilla/5.0 (compatible; MossCardBot/1.0)";

const FEEDS = [
  { key: "latest", label: "Latest", url: "https://techcrunch.com/feed/" },
  { key: "startups", label: "Startups", url: "https://techcrunch.com/category/startups/feed/" },
  { key: "venture", label: "Venture", url: "https://techcrunch.com/category/venture/feed/" },
  { key: "ai", label: "AI", url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
  { key: "apps", label: "Apps", url: "https://techcrunch.com/category/apps/feed/" },
  { key: "security", label: "Security", url: "https://techcrunch.com/category/security/feed/" }
];

const FEED_CACHE_TTL_MS = 1000 * 60 * 10;
const OG_CACHE_TTL_MS = 1000 * 60 * 60 * 24;
const OG_CONCURRENCY = 5;
const SNAPSHOT_TTL_MS = 1000 * 60 * 60 * 24;

const feedCache = new Map();
const ogCache = new Map();
const snapshotCache = new Map();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
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
    if (parsed?.snapshots) {
      Object.entries(parsed.snapshots).forEach(([feedKey, byDate]) => {
        const map = new Map();
        Object.entries(byDate || {}).forEach(([date, data]) => map.set(date, data));
        snapshotCache.set(feedKey, map);
      });
    }
    console.log(
      `Cache loaded: feeds=${feedCache.size}, og=${ogCache.size}, snapshots=${snapshotCache.size}`,
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
        snapshots: snapshotsObj,
      };
      fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), "utf-8");
      console.log(
        `Cache saved: feeds=${feedCache.size}, og=${ogCache.size}, snapshots=${snapshotCache.size}`,
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
  return String(html).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function firstImageUrlFromHtml(html) {
  if (!html) return "";
  const m =
    html.match(/<img[^>]+src=["']([^"']+)["']/i) ||
    html.match(/<img[^>]+data-src=["']([^"']+)["']/i) ||
    html.match(/<img[^>]+data-original=["']([^"']+)["']/i);
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

function mapItem(it) {
  const descHtml = it.description || "";
  const contentHtml = it["content:encoded"] || it.content || "";
  const summaryHtml = contentHtml || descHtml;
  const enclosureUrl = it.enclosure?.["@_url"] || "";
  const mediaUrl = it["media:content"]?.["@_url"] || it["media:thumbnail"]?.["@_url"] || "";
  const imgUrl = normalizeUrl(mediaUrl || enclosureUrl || firstImageUrlFromHtml(summaryHtml));
  return {
    title: it.title || "(No title)",
    link: it.link || "",
    guid: it.guid || it.link || it.title || "",
    pubDate: it.pubDate || "",
    creator: it["dc:creator"] || it.creator || it.author || "",
    categories: toArray(it.category),
    summaryText: stripHtml(summaryHtml),
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

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`RSS backend listening on http://localhost:${PORT}`);
});

loadCacheFromDisk();
