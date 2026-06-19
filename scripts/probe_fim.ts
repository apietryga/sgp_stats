// Temporary reverse-engineering probe: drive fimspeedway with Playwright and
// log every JSON/XHR response so we can learn the events + heats API contract.
import { chromium } from "playwright";

const UA =
  "sgp-stats/0.1 (personal speedway statistics; contact: antoni.pietryga@linkhouse.co)";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ userAgent: UA });
const page = await ctx.newPage();

const seen: { url: string; status: number; ctype: string; bytes: number; preview: string }[] = [];
page.on("response", async (res) => {
  const ct = res.headers()["content-type"] ?? "";
  if (!ct.includes("json")) return;
  try {
    const txt = await res.text();
    seen.push({
      url: res.url(),
      status: res.status(),
      ctype: ct,
      bytes: txt.length,
      preview: txt.slice(0, 240).replace(/\s+/g, " "),
    });
  } catch {
    /* ignore */
  }
});

const target = process.argv[2] ?? "https://fimspeedway.com/sgp/results";
console.log("NAV", target);
await page.goto(target, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(3500);

// try clicking around results to trigger event/heat loads
console.log("URL after load:", page.url());
for (const r of seen) {
  console.log(`\n[${r.status}] ${r.bytes}b ${r.url}`);
  console.log("   ", r.preview);
}
await browser.close();
