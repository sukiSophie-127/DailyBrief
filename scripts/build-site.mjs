#!/usr/bin/env node
/**
 * Build the static site that gets published to GitHub Pages (or any static
 * host). Run AFTER `npm run daily` has produced today's report.
 *
 * Writes into daily_reports/ (already the publish dir):
 *   - index.html      copy of the latest <date>/<date>.html
 *   - archive.html    table of every <date>/<date>.html, newest first
 *   - feed.xml        RSS feed of selected LLM-picked brief items
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

// --- feed.xml = public RSS feed of selected brief items ---
const rssEnabled = (process.env.RSS_ENABLED ?? "true").toLowerCase() !== "false";
if (rssEnabled) {
  const siteUrl = inferSiteUrl();
  const rssCategories = new Set(
    (envValue("RSS_CATEGORIES") ?? DEFAULT_RSS_CATEGORIES.join(","))
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean),
  );
  const rssLimit = parsePositiveInt(process.env.RSS_ITEM_LIMIT, 30);
  const rssDays = parsePositiveInt(process.env.RSS_DAYS, 7);
  const feedXml = buildRssFeed({ dates, siteUrl, rssCategories, rssLimit, rssDays });
  fs.writeFileSync(path.join(ROOT, "feed.xml"), feedXml, "utf8");
  console.log(
    `[build-site] feed.xml (${rssCategories.size} categories, ${rssLimit} items, ${rssDays} days)`,
  );
} else {
  console.log(`[build-site] feed.xml skipped (RSS_ENABLED=false)`);
}

// .nojekyll prevents GitHub Pages from running Jekyll, which would otherwise
// strip directories whose names start with "_". We don't have any today but
// it's cheap insurance and standard practice for static-site GH Pages.
fs.writeFileSync(path.join(ROOT, ".nojekyll"), "", "utf8");
console.log(`[build-site] .nojekyll`);

function buildRssFeed({ dates, siteUrl, rssCategories, rssLimit, rssDays }) {
  const items = [];
  const selectedDates = dates.slice(0, rssDays);
  for (const date of selectedDates) {
    const reportPath = path.join(ROOT, date, `${date}.json`);
    if (!fs.existsSync(reportPath)) continue;

    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    const reportUrl = new URL(`${date}/${date}.html`, siteUrl).toString();
    for (const item of collectBriefItems(report, rssCategories)) {
      items.push({ ...item, date, reportUrl });
      if (items.length >= rssLimit) break;
    }
    if (items.length >= rssLimit) break;
  }

  const latest = dates[0];
  const channelLink = siteUrl.toString();
  const selfLink = new URL("feed.xml", siteUrl).toString();
  const archiveLink = new URL("archive.html", siteUrl).toString();
  const lastBuildDate = new Date().toUTCString();
  const channelTitle = envValue("RSS_TITLE") || "daily-brief selected items";
  const channelDescription =
    envValue("RSS_DESCRIPTION") ||
    "Selected AI daily brief items generated by daily-brief.";

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xml(channelTitle)}</title>
    <link>${xml(channelLink)}</link>
    <description>${xml(channelDescription)}</description>
    <language>${xml(process.env.REPORT_LOCALE === "en" ? "en" : "zh-CN")}</language>
    <lastBuildDate>${xml(lastBuildDate)}</lastBuildDate>
    <atom:link href="${xml(selfLink)}" rel="self" type="application/rss+xml" />
    <docs>https://www.rssboard.org/rss-specification</docs>
    <generator>daily-brief</generator>
    <ttl>60</ttl>
    <item>
      <title>${xml(`Latest daily brief (${latest})`)}</title>
      <link>${xml(channelLink)}</link>
      <guid isPermaLink="false">${xml(`daily-brief:${latest}:index`)}</guid>
      <pubDate>${xml(dateToRfc822(latest))}</pubDate>
      <description>${xml(`Latest full report. Archive: ${archiveLink}`)}</description>
    </item>
${items.map(renderRssItem).join("\n")}
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
    return items.map((item) => ({ ...item, category }));
  });
}

function renderRssItem(item) {
  const title = `[${item.category}] ${item.title}`;
  const source = item.source ? `Source: ${item.source}. ` : "";
  const summary = item.summary || "No summary available.";
  const description = `${summary}\n\n${source}Daily report: ${item.reportUrl}`;
  const link = item.url || item.reportUrl;
  return `    <item>
      <title>${xml(title)}</title>
      <link>${xml(link)}</link>
      <guid isPermaLink="false">${xml(`daily-brief:${item.date}:${link}`)}</guid>
      <pubDate>${xml(dateToRfc822(item.date))}</pubDate>
      <category>${xml(item.category)}</category>
      <description>${xml(description)}</description>
    </item>`;
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

function dateToRfc822(date) {
  return new Date(`${date}T00:00:00.000Z`).toUTCString();
}

function xml(value) {
  return stripInvalidXmlChars(String(value ?? ""))
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function stripInvalidXmlChars(value) {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "");
}
