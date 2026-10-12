import { mkdir, readFile, writeFile } from "node:fs/promises";

const headers = { "User-Agent": "Mozilla/5.0 VAIMEA/1.0", Accept: "application/json, application/rss+xml, application/xml, text/xml" };
const outputUrl = new URL("../public/data/news.json", import.meta.url);

const sourceWeights = new Map([
  ["eia.gov", 12], ["opec.org", 11], ["iea.org", 10], ["reuters.com", 10],
  ["reuters", 10], ["bloomberg", 9], ["financial times", 8], ["ap news", 8],
  ["bloomberg.com", 9], ["spglobal.com", 9], ["ft.com", 8], ["cnbc.com", 7],
  ["cnbc", 7], ["argus media", 9], ["s&p global", 9], ["cme group", 7],
  ["argusmedia.com", 9], ["cmegroup.com", 7], ["marketwatch.com", 6], ["oilprice.com", 5],
  ["rigzone", 6], ["investing.com", 5], ["fxstreet", 5], ["oil & gas journal", 7],
]);

const rules = [
  {
    tag: "GEOPOLITIIKKA", score: 10,
    words: ["war", "attack", "missile", "sanction", "hormuz", "shipping", "tanker", "pipeline", "embargo", "russia", "iran", "venezuela", "middle east"],
    why: "Toimitus- tai kuljetusriski voi nostaa öljyn riskipreemiota nopeasti. Vaikutus näkyy usein ensin Brentissä ja Brent–WTI-spreadissa.",
  },
  {
    tag: "TARJONTA", score: 9,
    words: ["opec", "production cut", "output cut", "production increase", "output increase", "supply", "quota", "barrels per day", "drilling", "rig count"],
    why: "Tuotantomäärien muutos vaikuttaa suoraan maailman öljytarjontaan, hintoihin ja futuurikäyrän backwardation–contango-rakenteeseen.",
  },
  {
    tag: "VARASTOT", score: 9,
    words: ["inventory", "inventories", "stockpile", "stockpiles", "crude stocks", "petroleum status", "eia"],
    why: "Varastojen muutos kertoo tarjonnan ja kysynnän tasapainosta Yhdysvalloissa ja liikuttaa usein erityisesti WTI-hintaa.",
  },
  {
    tag: "KYSYNTÄ", score: 10,
    words: ["oil demand", "fuel demand", "china demand", "consumption", "economic growth", "recession", "forecast", "outlook"],
    why: "Kysyntäodotusten muutos vaikuttaa molempiin viiteöljyihin ja siihen, hinnoitellaanko lähikuukausille niukkuutta vai ylitarjontaa.",
  },
  {
    tag: "JALOSTUS", score: 6,
    words: ["refinery", "refineries", "outage", "maintenance", "gasoline", "diesel", "jet fuel", "crack spread"],
    why: "Jalostamojen käyttöaste ja häiriöt muuttavat raakaöljyn kysyntää sekä polttoainemarkkinoiden tasapainoa.",
  },
  {
    tag: "MAKRO", score: 5,
    words: ["federal reserve", "interest rate", "dollar", "inflation", "gdp", "jobs report", "central bank"],
    why: "Dollari, korot ja kasvuodotukset vaikuttavat raaka-aineiden kysyntään ja siihen, kuinka kallista dollarimääräinen öljy on muille ostajille.",
  },
];

function decode(value = "") {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ").trim();
}

function field(block, name) {
  return decode(block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"))?.[1] || "");
}

function sourceWeight(domain = "") {
  const clean = domain.toLowerCase().replace(/^www\./, "");
  for (const [known, weight] of sourceWeights) if (clean === known || clean.endsWith("." + known)) return weight;
  return 2;
}

function classify(title) {
  const text = title.toLowerCase();
  let best = null;
  for (const rule of rules) {
    const hits = rule.words.filter(word => text.includes(word)).length;
    if (hits && (!best || rule.score + hits > best.score)) best = { ...rule, score: rule.score + hits };
  }
  return best || {
    tag: "MARKKINA", score: 3,
    why: "Uutinen voi muuttaa odotuksia öljyn tarjonnasta, kysynnästä tai markkinan riskipreemiosta.",
  };
}

function normalize(article) {
  let domain = article.domain || article.source || "";
  if (domain.includes("|")) domain = domain.split("|").at(-1).trim();
  try { domain ||= new URL(article.url).hostname.replace(/^www\./, ""); } catch {}
  const rule = classify(article.title);
  const rawDate = article.seen || article.date || "";
  const gdeltDate = String(rawDate).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  const seen = gdeltDate
    ? Date.UTC(+gdeltDate[1], +gdeltDate[2] - 1, +gdeltDate[3], +gdeltDate[4], +gdeltDate[5], +gdeltDate[6])
    : Date.parse(rawDate) || Date.now();
  const ageHours = Math.max(0, (Date.now() - seen) / 36e5);
  const recency = Math.max(0, 8 - ageHours / 6);
  return {
    title: decode(article.title), url: article.url, source: domain || article.source || "Lähde",
    publishedAt: new Date(seen).toISOString(), tag: rule.tag, why: rule.why,
    score: sourceWeight(domain) + rule.score + recency,
  };
}

async function googleNews() {
  const url = new URL("https://news.google.com/rss/search");
  url.search = new URLSearchParams({
    q: '(WTI OR Brent OR OPEC OR "crude oil") when:2d', hl: "en-US", gl: "US", ceid: "US:en",
  });
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error("Google News returned " + response.status);
  const xml = await response.text();
  return [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map(match => {
    const block = match[1];
    const rawTitle = field(block, "title");
    const source = field(block, "source") || rawTitle.split(" - ").at(-1) || "Google News";
    const title = rawTitle.endsWith(" - " + source) ? rawTitle.slice(0, -(source.length + 3)) : rawTitle;
    return { title, url: field(block, "link"), source, date: field(block, "pubDate") };
  });
}

async function gdelt() {
  const query = '("crude oil" OR Brent OR WTI OR OPEC) sourcelang:english';
  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  url.search = new URLSearchParams({ query, mode: "artlist", maxrecords: "75", timespan: "48h", format: "json", sort: "hybridrel" });
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error("GDELT returned " + response.status);
  const data = await response.json();
  return (data.articles || []).map(a => ({ title: a.title, url: a.url, domain: a.domain, seen: a.seendate }));
}

async function rss(url, source) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(source + " returned " + response.status);
  const xml = await response.text();
  return [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map(match => {
    const block = match[1];
    return { title: field(block, "title"), url: field(block, "link"), source, date: field(block, "pubDate") };
  });
}

const sources = await Promise.allSettled([
  gdelt(),
  googleNews(),
  rss("https://www.eia.gov/rss/todayinenergy.xml", "eia.gov"),
  rss("https://www.eia.gov/rss/press_rss.xml", "eia.gov"),
]);

const rejected = /(palm oil|olive oil|cooking oil|essential oil|hair oil|engine oil|motor oil)/i;
const candidates = sources.flatMap(result => result.status === "fulfilled" ? result.value : [])
  .filter(a => a.title && /^https?:\/\//i.test(a.url || "") && !rejected.test(a.title))
  .map(normalize)
  .filter(a => sourceWeight(a.source) > 2)
  .filter(a => /(oil|crude|brent|wti|opec|petroleum|refiner|gasoline|diesel|fuel|inventory|pipeline|tanker|hormuz)/i.test(a.title));

const seen = new Set();
const tagCounts = new Map();
const sourceCounts = new Map();
const items = candidates.sort((a, b) => b.score - a.score).filter(item => {
  const key = item.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 90);
  if (seen.has(key)) return false;
  if ((tagCounts.get(item.tag) || 0) >= 2) return false;
  if ((sourceCounts.get(item.source) || 0) >= 1) return false;
  seen.add(key);
  tagCounts.set(item.tag, (tagCounts.get(item.tag) || 0) + 1);
  sourceCounts.set(item.source, (sourceCounts.get(item.source) || 0) + 1);
  return true;
}).slice(0, 6).map(({ score, ...item }) => item);

let news = { asOf: Math.floor(Date.now() / 1000), items };
if (!items.length) {
  try { news = JSON.parse(await readFile(outputUrl, "utf8")); }
  catch { news = { asOf: Math.floor(Date.now() / 1000), items: [] }; }
}

await mkdir(new URL("../public/data/", import.meta.url), { recursive: true });
await writeFile(outputUrl, JSON.stringify(news), "utf8");
console.log("VAIMEA news updated", news.items.length, "items");
