/**
 * Smoke-test the DEPLOYED portals in a real browser.
 *
 *   node scripts/smoke-live.mjs [url ...]
 *
 * Asserts what a person would actually see: page loads, no console errors,
 * the primary control is present and clickable. This is the "don't tell me
 * it's fine again unless you actually looked at it" check.
 */
import { chromium } from "playwright-core";

const TARGETS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "https://studyhaus-crm-student.web.app/login.html",
      "https://studyhaus-crm-admin.web.app/login.html",
      "https://studyhaus-crm-admin.web.app/admin/dashboard.html",
    ];

/** [url, selector that must exist] */
const EXPECT = [
  [/student\.shreejilibrary|studyhaus-crm-student/, "input, form, .login-container, #login-form, button"],
  [/admin\.shreejilibrary|studyhaus-crm-admin/, "input, form, button"],
];

let pass = 0;
const failures = [];

const expect = async (label, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  PASS  ${label}`);
  } catch (e) {
    failures.push(label);
    console.log(`  FAIL  ${label}\n        ${e && e.message ? e.message : e}`);
  }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

const browser = await chromium.launch({ channel: "msedge", headless: true });

for (const url of TARGETS) {
  console.log(`\n=== ${url} ===`);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("requestfailed", (r) => errors.push(`REQ FAIL ${r.url()} ${r.failure()?.errorText || ""}`));

  let resp = null;
  await expect("HTTP 200", async () => {
    resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    assert(resp && resp.status() === 200, `status ${resp && resp.status()}`);
  });

  await expect("document rendered (body has content)", async () => {
    const len = await page.evaluate(() => document.body ? document.body.innerHTML.length : 0);
    assert(len > 500, `body innerHTML only ${len} chars`);
  });

  await expect("primary interactive control present", async () => {
    const selector = /dashboard\.html/.test(url)
      ? "nav, .sidebar, .main-content, [id^=page-], button"
      : "input, form, button";
    await page.waitForSelector(selector, { timeout: 15000 });
    const n = await page.locator(selector).count();
    assert(n > 0, `0 matches for ${selector}`);
  });

  await expect("no console/page/request errors", async () => {
    await page.waitForTimeout(2500);
    const ignorable = (s) =>
      /favicon|ERR_ABORTED|net::ERR_FAILED.*google-analytics|gtag|doubleclick/i.test(s);
    const bad = errors.filter((s) => !ignorable(s));
    assert(bad.length === 0, bad.slice(0, 6).join(" | "));
  });

  await expect("Cache-Control is no-cache (no stale-UI risk)", async () => {
    const cc = resp.headers()["cache-control"] || "";
    assert(/no-cache|must-revalidate/i.test(cc), `got "${cc}"`);
  });

  const shot = `C:\\Users\\Asus\\AppData\\Local\\Temp\\opencode\\smoke-${new URL(url).hostname}.png`;
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
  console.log(`  shot  ${shot}`);
  await page.close();
}

await browser.close();
console.log(`\n=== ${pass} passed, ${failures.length} failed ===`);
failures.forEach((f) => console.log("  - " + f));
process.exit(failures.length ? 1 : 0);
