import { mkdir, writeFile } from "node:fs/promises";

const monthCodes = ["F", "G", "H", "J", "K", "M", "N", "Q", "U", "V", "X", "Z"];
const requestHeaders = { "User-Agent": "Mozilla/5.0 VAIMEA/1.0", Accept: "application/json" };

async function chart(symbol, range, interval) {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(symbol) + "?range=" + range + "&interval=" + interval + "&includePrePost=false";
  const response = await fetch(url, { headers: requestHeaders });
  if (!response.ok) throw new Error(symbol + " returned " + response.status);
  const body = await response.json();
  const result = body?.chart?.result?.[0];
  if (!result) throw new Error("No data for " + symbol);
  return result;
}

async function quote(symbol) {
  const result = await chart(symbol, "1mo", "1h");
  const q = result.indicators.quote[0];
  const points = result.timestamp.map((t, i) => [t, q.close[i]]).filter(p => Number.isFinite(p[1]));
  const latest = points.at(-1);
  const session = points.filter(p => p[0] >= latest[0] - 86400).map(p => p[1]);
  const month = points.map(p => p[1]);
  const prev = Number(result.meta.chartPreviousClose || result.meta.previousClose || points[Math.max(0, points.length - 24)][1]);
  return {
    price: latest[1], changePct: (latest[1] / prev - 1) * 100,
    dayLow: Math.min(...session), dayHigh: Math.max(...session),
    monthLow: Math.min(...month), monthHigh: Math.max(...month),
    monthChangePct: (latest[1] / points[0][1] - 1) * 100, points,
  };
}

async function contractQuote(symbol, monthDate) {
  const result = await chart(symbol, "5d", "1d");
  const closes = result.indicators.quote[0].close.filter(Number.isFinite);
  const price = Number(result.meta.regularMarketPrice || closes.at(-1));
  if (!Number.isFinite(price)) throw new Error("No price for " + symbol);
  return { symbol, price, name: result.meta.longName || symbol, month: monthDate.toISOString().slice(0, 7) };
}

async function forwardCurve(prefix) {
  const now = new Date();
  const candidates = Array.from({ length: 15 }, (_, i) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i + 1, 1));
    return { symbol: prefix + monthCodes[date.getUTCMonth()] + String(date.getUTCFullYear()).slice(-2) + ".NYM", date };
  });
  const results = await Promise.allSettled(candidates.map(c => contractQuote(c.symbol, c.date)));
  return results.filter(r => r.status === "fulfilled").map(r => r.value).slice(0, 12);
}

const [wti, brent, wtiCurve, brentCurve] = await Promise.all([
  quote("CL=F"), quote("BZ=F"), forwardCurve("CL"), forwardCurve("BZ"),
]);
if (wtiCurve.length < 12 || brentCurve.length < 12) throw new Error("Incomplete futures curve");

const data = { wti, brent, curve: { wti: wtiCurve, brent: brentCurve }, asOf: Math.max(wti.points.at(-1)[0], brent.points.at(-1)[0]) };
await mkdir(new URL("../public/data/", import.meta.url), { recursive: true });
await writeFile(new URL("../public/data/market.json", import.meta.url), JSON.stringify(data), "utf8");
console.log("VAIMEA market data updated", new Date(data.asOf * 1000).toISOString());

