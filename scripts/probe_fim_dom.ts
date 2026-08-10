// Temporary reverse-engineering probe #2: dump the *rendered* page instead
// of XHR traffic. probe_fim.ts found zero JSON XHRs while loading a 2026
// round results page, so the heat data — if present at all — must be
// server-rendered into the HTML rather than fetched client-side. This checks
// __NEXT_DATA__ first (structured, easy to parse if present) and falls back
// to a plain-text scan of the rendered body.
import { chromium } from "playwright";

const UA =
  "sgp-stats/0.1 (personal speedway statistics; contact: antoni.pietryga@linkhouse.co)";

const url =
  process.argv[2] ?? "https://fimspeedway.com/results/2026-dewalt-fim-speedway-gp-of-latvia-riga";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ userAgent: UA });
const page = await ctx.newPage();

console.log("NAV", url);
await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(3000);

console.log("TITLE:", await page.title());

const html = await page.content();
console.log("HTML_LENGTH:", html.length);
console.log("HAS_ZMARZLIK:", html.includes("Zmarzlik"));
console.log("HAS_HEAT1_TEXT:", /heat\s*1/i.test(html));
console.log("HAS_NEXT_DATA_SCRIPT:", html.includes('id="__NEXT_DATA__"'));

const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
if (m) {
  const blob = m[1]!;
  console.log("NEXT_DATA_LENGTH:", blob.length);
  console.log("NEXT_DATA_HAS_RANKINGS:", blob.includes("rankings"));
  console.log("NEXT_DATA_HAS_COLORID:", blob.includes("colorId"));
  console.log("NEXT_DATA_HAS_ZMARZLIK:", blob.includes("Zmarzlik"));
  console.log("NEXT_DATA_SNIPPET:", blob.slice(0, 2000));
} else {
  console.log("NO __NEXT_DATA__ SCRIPT FOUND");
}

const bodyText = await page.locator("body").innerText();
console.log("BODY_TEXT_LENGTH:", bodyText.length);
const idx = bodyText.search(/heat\s*1/i);
console.log(
  "BODY_TEXT_AROUND_HEAT1:",
  idx >= 0 ? bodyText.slice(Math.max(0, idx - 200), idx + 900) : "(not found)",
);
console.log("BODY_TEXT_SNIPPET_START:", bodyText.slice(0, 1500));

// how many table-like structures rendered at all
console.log("TABLE_COUNT:", await page.locator("table").count());
console.log("ROLE_TABLE_COUNT:", await page.locator("[role=table]").count());

await browser.close();
