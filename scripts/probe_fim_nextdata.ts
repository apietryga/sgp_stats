// Temporary reverse-engineering probe #3: probe_fim_dom.ts confirmed the
// per-round results page embeds full heat data in __NEXT_DATA__ (rankings,
// colorId, rider names all present). Two things left to learn: (1) does a
// plain HTTP fetch (no browser) already return the same HTML — i.e. is
// Playwright even necessary — and (2) the exact JSON shape under pageProps,
// to know whether the existing extractRound()/parseNextData() in
// fimspeedway.ts already matches it.
import { chromium } from "playwright";

const UA =
  "sgp-stats/0.1 (personal speedway statistics; contact: antoni.pietryga@linkhouse.co)";
const url =
  process.argv[2] ?? "https://fimspeedway.com/results/2026-dewalt-fim-speedway-gp-of-latvia-riga";

function extractNextData(html: string): any {
  const m = html.match(
    /<script id="__NEXT_DATA__"[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (!m) return null;
  try {
    return JSON.parse(m[1]!);
  } catch {
    return null;
  }
}

console.log("=== plain fetch (no browser) ===");
try {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  const html = await res.text();
  console.log("STATUS:", res.status, "HTML_LENGTH:", html.length);
  const nd = extractNextData(html);
  console.log("PLAIN_FETCH_HAS_NEXT_DATA:", !!nd);
  if (nd) {
    const pageProps = nd?.props?.pageProps;
    console.log("PLAIN_FETCH_PAGEPROPS_KEYS:", JSON.stringify(Object.keys(pageProps ?? {})));
  }
} catch (e) {
  console.log("PLAIN_FETCH_ERROR:", String(e));
}

console.log("\n=== Playwright render ===");
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ userAgent: UA });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(2000);
const html = await page.content();
const nd = extractNextData(html);
console.log("PLAYWRIGHT_HAS_NEXT_DATA:", !!nd);
if (nd) {
  const pageProps = nd?.props?.pageProps;
  console.log("PAGEPROPS_KEYS:", JSON.stringify(Object.keys(pageProps ?? {})));
  // walk a few likely candidate keys for the event/round object
  for (const key of ["event", "round", "results", "data"]) {
    const val = pageProps?.[key];
    if (val && typeof val === "object") {
      console.log(`pageProps.${key} KEYS:`, JSON.stringify(Object.keys(val)));
    }
  }
  const event = pageProps?.event ?? pageProps?.round ?? pageProps?.data;
  console.log("EVENT_CANDIDATE_KEYS:", JSON.stringify(Object.keys(event ?? {})));
  for (const key of ["heats", "races", "runs"]) {
    const arr = event?.[key];
    if (Array.isArray(arr)) {
      console.log(`event.${key}: array length ${arr.length}`);
      console.log(`event.${key}[0]:`, JSON.stringify(arr[0]).slice(0, 2000));
    }
  }
}
await browser.close();
