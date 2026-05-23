#!/usr/bin/env node
/**
 * Build the static site that gets published to GitHub Pages (or any static
 * host). Run AFTER `npm run daily` has produced today's report.
 *
 * Writes into daily_reports/ (already the publish dir):
 *   - index.html      copy of the latest <date>/<date>.html
 *   - archive.html    table of every <date>/<date>.html, newest first
 *   - feed.xml        Main RSS feed for daily reading
 *   - feeds/*.xml     Layered RSS feeds for category-specific readers
 *
 * Existing per-date subdirs are left untouched. Idempotent — safe to re-run.
 *
 * Usage:
 *   node scripts/build-site.mjs
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = "daily_reports";
const DEFAULT_RSS_CATEGORIES = ["tech", "finance", "politics"];
const DEFAULT_RSS_DAYS = 3;
const SOURCE_CONFIG = JSON.parse(fs.readFileSync("sources.config.json", "utf8"));
const SOURCE_BY_ID = new Map(SOURCE_CONFIG.map((s) => [s.id, s]));
const COMMUNITY_SUBCATEGORIES = new Set(["cn-community", "overseas-community"]);
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
  "msclkid",
]);
const FEED_LIMITS = {
  main: 50,
  tech: 100,
  community: 100,
  markets: 80,
  politics: 80,
  all: 300,
};

if (!fs.existsSync(ROOT)) {
  console.error(`[build-site] ${ROOT}/ doesn't exist — run \`npm run daily\` first.`);
  process.exit(1);
}

// Pick up every <YYYY-MM-DD>/<YYYY-MM-DD>.html, newest first.
const dates = fs
  .readdirSync(ROOT)
  .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
  .filter((d) => fs.existsSync(path.join(ROOT, d, `${d}.html`)))
  .sort((a, b) => b.localeCompare(a));

if (dates.length === 0) {
  console.error(`[build-site] no <YYYY-MM-DD>/<YYYY-MM-DD>.html found in ${ROOT}/`);
  process.exit(1);
}

// --- index.html = latest report ---
const latest = dates[0];
const latestPath = path.join(ROOT, latest, `${latest}.html`);
fs.copyFileSync(latestPath, path.join(ROOT, "index.html"));
console.log(`[build-site] index.html  ← ${latest}/${latest}.html`);

// --- archive.html = list of all reports ---
const rows = dates
  .map((d) => {
    const size = (fs.statSync(path.join(ROOT, d, `${d}.html`)).size / 1024).toFixed(0);
    return `      <li><a href="./${d}/${d}.html">${d}</a> <span class="size">${size} KB</span></li>`;
  })
  .join("\n");

const archiveHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>daily-brief — archive</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    max-width: 720px;
    margin: 3rem auto;
    padding: 0 1.5rem;
    line-height: 1.5;
  }
  h1 { margin-bottom: 0.2rem; font-size: 1.5rem; }
  .meta { color: #888; font-size: 0.9rem; margin-bottom: 1.5rem; }
  ul { list-style: none; padding: 0; }
  li {
    padding: 0.5rem 0;
    border-bottom: 1px solid #eee;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  @media (prefers-color-scheme: dark) {
    li { border-bottom-color: #2a2a2a; }
  }
  li a { text-decoration: none; }
  li a:hover { text-decoration: underline; }
  .size { color: #999; font-size: 0.85rem; }
  .top {
    margin-bottom: 2rem;
    padding: 0.75rem 1rem;
    background: #f6f6f6;
    border-radius: 6px;
  }
  @media (prefers-color-scheme: dark) {
    .top { background: #1e1e1e; }
  }
</style>
</head>
<body>
  <h1>daily-brief — archive</h1>
  <p class="meta">${dates.length} report${dates.length === 1 ? "" : "s"} · newest first · generated ${new Date().toISOString().slice(0, 10)}</p>
  <div class="top">
    <a href="./index.html">→ Latest report (${latest})</a>
  </div>
  <ul>
${rows}
  </ul>
</body>
</html>
`;
fs.writeFileSync(path.join(ROOT, "archive.html"), archiveHtml, "utf8");
console.log(`[build-site] archive.html (${dates.length} dates)`);

// --- RSS feeds = Miniflux-friendly rolling feeds ---
const rssEnabled = (process.env.RSS_ENABLED ?? "true").toLowerCase() !== "false";
if (rssEnabled) {
  const siteUrl = inferSiteUrl();
  const rssCategories = new Set(
    (envValue("RSS_CATEGORIES") ?? DEFAULT_RSS_CATEGORIES.join(","))
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean),
  );
  const rssDays = parsePositiveInt(process.env.RSS_DAYS, DEFAULT_RSS_DAYS);
  const feeds = buildRssFeeds({ dates, siteUrl, rssCategories, rssDays });
  fs.mkdirSync(path.join(ROOT, "feeds"), { recursive: true });
  for (const feed of feeds) {
    fs.writeFileSync(path.join(ROOT, feed.path), feed.xml, "utf8");
    console.log(`[build-site] ${feed.path} (${feed.count} items, ${rssDays} days)`);
  }
} else {
  console.log(`[build-site] RSS skipped (RSS_ENABLED=false)`);
}

// .nojekyll prevents GitHub Pages from running Jekyll, which would otherwise
// strip directories whose names start with "_". We don't have any today but
// it's cheap insurance and standard practice for static-site GH Pages.
fs.writeFileSync(path.join(ROOT, ".nojekyll"), "", "utf8");
console.log(`[build-site] .nojekyll`);

function buildRssFeeds({ dates, siteUrl, rssCategories, rssDays }) {
  const bundles = dates.slice(0, rssDays).map((date) => loadBundle(date, siteUrl)).filter(Boolean);
  const communityPerDay = parsePositiveInt(process.env.RSS_MAIN_COMMUNITY_LIMIT, 5);
  const feedDefs = [
    {
      name: "main",
      path: "feed.xml",
      title: envValue("RSS_TITLE") || "daily-brief",
      description:
        envValue("RSS_DESCRIPTION") ||
        "Personal DailyBrief feed: selected briefs plus a few community discussions.",
      limit: parsePositiveInt(process.env.RSS_ITEM_LIMIT, FEED_LIMITS.main),
      items: bundles.flatMap((bundle) => [
        ...collectBriefItems(bundle.report, rssCategories).map((item) => ({ ...item, ...bundle.meta })),
        ...collectRawItems(bundle, { feedName: "community" }).slice(0, communityPerDay),
      ]),
    },
    {
      name: "tech",
      path: "feeds/tech.xml",
      title: "daily-brief tech",
      description: "Technology, AI, GitHub Trending, and developer ecosystem items.",
      limit: parsePositiveInt(process.env.RSS_TECH_LIMIT, FEED_LIMITS.tech),
      items: bundles.flatMap((bundle) => collectRawItems(bundle, { feedName: "tech" })),
    },
    {
      name: "community",
      path: "feeds/community.xml",
      title: "daily-brief community",
      description: "Developer community discussions from sources such as V2EX, LinuxDo, and HN.",
      limit: parsePositiveInt(process.env.RSS_COMMUNITY_LIMIT, FEED_LIMITS.community),
      items: bundles.flatMap((bundle) => collectRawItems(bundle, { feedName: "community" })),
    },
    {
      name: "markets",
      path: "feeds/markets.xml",
      title: "daily-brief markets",
      description: "Finance, markets, and macro news items.",
      limit: parsePositiveInt(process.env.RSS_MARKETS_LIMIT, FEED_LIMITS.markets),
      items: bundles.flatMap((bundle) => collectRawItems(bundle, { feedName: "markets" })),
    },
    {
      name: "politics",
      path: "feeds/politics.xml",
      title: "daily-brief politics",
      description: "Politics, policy, and international affairs items.",
      limit: parsePositiveInt(process.env.RSS_POLITICS_LIMIT, FEED_LIMITS.politics),
      items: bundles.flatMap((bundle) => collectRawItems(bundle, { feedName: "politics" })),
    },
    {
      name: "all",
      path: "feeds/all.xml",
      title: "daily-brief all",
      description: "All recent DailyBrief items for feed readers such as Miniflux.",
      limit: parsePositiveInt(process.env.RSS_ALL_LIMIT, FEED_LIMITS.all),
      items: bundles.flatMap((bundle) => collectRawItems(bundle, { feedName: "all" })),
    },
  ];

  return feedDefs.map((feed) => {
    const items = dedupeByGuid(sortFeedItems(feed.items)).slice(0, feed.limit);
    return {
      path: feed.path,
      count: items.length,
      xml: renderRssChannel({ ...feed, items, siteUrl }),
    };
  });
}

function loadBundle(date, siteUrl) {
  const reportPath = path.join(ROOT, date, `${date}.json`);
  if (!fs.existsSync(reportPath)) return null;
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const articlesPath = path.join(ROOT, date, `${date}-articles.json`);
  const articles = fs.existsSync(articlesPath)
    ? JSON.parse(fs.readFileSync(articlesPath, "utf8")).articles ?? []
    : [];
  return {
    report,
    articles: articles.map(normalizeArticle),
    meta: {
      date,
      reportUrl: new URL(`${date}/${date}.html`, siteUrl).toString(),
    },
  };
}

function renderRssChannel({ name, path: feedPath, title, description, items, siteUrl }) {
  const channelLink = siteUrl.toString();
  const selfLink = new URL(feedPath, siteUrl).toString();
  const lastBuildDate = new Date().toUTCString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xml(title)}</title>
    <link>${xml(channelLink)}</link>
    <description>${xml(description)}</description>
    <language>${xml(process.env.REPORT_LOCALE === "en" ? "en" : "zh-CN")}</language>
    <lastBuildDate>${xml(lastBuildDate)}</lastBuildDate>
    <atom:link href="${xml(selfLink)}" rel="self" type="application/rss+xml" />
    <docs>https://www.rssboard.org/rss-specification</docs>
    <generator>daily-brief</generator>
    <ttl>60</ttl>
${items.map((item) => renderRssItem(item, name)).join("\n")}
  </channel>
</rss>
`;
}

function collectBriefItems(report, rssCategories) {
  const groups = [
    ["tech", "tech_briefs"],
    ["finance", "finance_briefs"],
    ["politics", "politics_briefs"],
  ];
  return groups.flatMap(([category, key]) => {
    if (!rssCategories.has(category)) return [];
    const items = Array.isArray(report[key]) ? report[key] : [];
    return items.map((item) => ({ ...item, category, type: "brief" }));
  });
}

function collectRawItems(bundle, { feedName }) {
  return bundle.articles
    .filter((item) => rawItemBelongsToFeed(item, feedName))
    .map((item) => ({ ...item, ...bundle.meta, type: "raw" }));
}

function rawItemBelongsToFeed(item, feedName) {
  if (feedName === "all") return true;
  if (feedName === "community") return COMMUNITY_SUBCATEGORIES.has(item.subcategory);
  if (feedName === "tech") {
    return item.category === "tech" && !COMMUNITY_SUBCATEGORIES.has(item.subcategory);
  }
  if (feedName === "markets") return item.category === "finance";
  if (feedName === "politics") return item.category === "politics";
  return false;
}

function normalizeArticle(item) {
  const source = SOURCE_BY_ID.get(item.sourceId);
  return {
    ...item,
    source: item.source || source?.name || item.sourceId || "unknown",
    subcategory: source?.subcategory,
    publishedAt: item.publishedAt ? new Date(item.publishedAt) : undefined,
  };
}

function renderRssItem(item, feedName) {
  const link = item.url || item.reportUrl;
  const title = `[${categoryLabel(item)}] ${item.title}`;
  const guid = item.url
    ? canonicalUrl(item.url)
    : `dailybrief:${feedName}:${item.date}:${hashText(item.title)}`;
  const description = renderItemCard(item);
  return `    <item>
      <title>${xml(title)}</title>
      <link>${xml(link)}</link>
      <guid isPermaLink="false">${xml(guid)}</guid>
      <pubDate>${xml(reportDateToRfc822(item.date))}</pubDate>
      <category>${xml(categoryLabel(item))}</category>
      <description>${xml(description)}</description>
    </item>`;
}

function renderItemCard(item) {
  const summary = item.summary || item.excerpt || item.meta || "暂无摘要。";
  const why = whyWorthReading(item);
  const meta = item.meta ? `<p><strong>补充：</strong>${html(item.meta)}</p>` : "";
  return `<p><strong>来源：</strong>${html(item.source || "unknown")}</p>
<p><strong>分类：</strong>${html(categoryLabel(item))}</p>
<p><strong>摘要：</strong>${html(summary)}</p>
${meta}
<p><strong>为什么值得看：</strong>${html(why)}</p>
<p><a href="${html(item.reportUrl)}">查看当日 DailyBrief</a></p>`;
}

function whyWorthReading(item) {
  if (item.type === "brief") {
    return item.importance
      ? `入选今日 LLM 精选，重要性评分 ${item.importance}/10。`
      : "入选今日 LLM 精选。";
  }
  if (COMMUNITY_SUBCATEGORIES.has(item.subcategory)) {
    return "来自开发者社区热帖，适合观察真实讨论、踩坑反馈和工具趋势。";
  }
  if (item.category === "tech") return "有助于跟踪 AI、技术产品和开发者生态的最新变化。";
  if (item.category === "finance") return "有助于判断市场、公司和宏观环境的当日变化。";
  if (item.category === "politics") return "有助于把握政策、国际关系和地缘风险信号。";
  return "近期 DailyBrief 收录条目。";
}

function categoryLabel(item) {
  if (COMMUNITY_SUBCATEGORIES.has(item.subcategory)) return "社区";
  if (item.category === "tech") return "技术";
  if (item.category === "finance") return "市场";
  if (item.category === "politics") return "时政";
  return item.category || "DailyBrief";
}

function dedupeByGuid(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const guid = item.url ? canonicalUrl(item.url) : `${item.date}:${hashText(item.title)}`;
    if (seen.has(guid)) continue;
    seen.add(guid);
    out.push(item);
  }
  return out;
}

function sortFeedItems(items) {
  return [...items].sort((a, b) => {
    const dateOrder = b.date.localeCompare(a.date);
    if (dateOrder !== 0) return dateOrder;
    if (a.type === "brief" && b.type !== "brief") return -1;
    if (a.type !== "brief" && b.type === "brief") return 1;
    return (b.publishedAt?.getTime?.() ?? 0) - (a.publishedAt?.getTime?.() ?? 0);
  });
}

function canonicalUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString();
  } catch {
    return value;
  }
}

function hashText(value) {
  let hash = 5381;
  for (const ch of String(value ?? "")) hash = (hash * 33) ^ ch.charCodeAt(0);
  return (hash >>> 0).toString(36);
}

function inferSiteUrl() {
  const configured = envValue("RSS_SITE_URL") || envValue("SITE_URL");
  if (configured) return ensureTrailingSlash(configured);

  const repo = process.env.GITHUB_REPOSITORY;
  if (repo?.includes("/")) {
    const [owner, name] = repo.split("/");
    return ensureTrailingSlash(`https://${owner.toLowerCase()}.github.io/${name}/`);
  }

  return ensureTrailingSlash("https://example.com/daily-brief/");
}

function ensureTrailingSlash(url) {
  return new URL(url.endsWith("/") ? url : `${url}/`);
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envValue(name) {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function reportDateToRfc822(date) {
  return zonedDateTimeToUtc(date, 12, envValue("REPORT_TZ") || "UTC").toUTCString();
}

function zonedDateTimeToUtc(date, hour, timeZone) {
  const candidate = new Date(`${date}T${String(hour).padStart(2, "0")}:00:00.000Z`);
  return new Date(candidate.getTime() - timeZoneOffsetMs(candidate, timeZone));
}

function timeZoneOffsetMs(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const got = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    const asUtc = Date.UTC(
      Number(got.year),
      Number(got.month) - 1,
      Number(got.day),
      Number(got.hour),
      Number(got.minute),
      Number(got.second),
    );
    return asUtc - date.getTime();
  } catch {
    return 0;
  }
}

function xml(value) {
  return stripInvalidXmlChars(String(value ?? ""))
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function html(value) {
  return stripInvalidXmlChars(String(value ?? ""))
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function stripInvalidXmlChars(value) {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "");
}
