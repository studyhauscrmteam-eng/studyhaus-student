/**
 * Seat map RENDER test — clicks the real map in a real browser.
 *
 *   node scripts/test-seatmap.mjs
 *
 * Why this exists: the seat map had already "passed" static checks once and
 * still did not work for a real user. Syntax checks, import resolution and
 * duplicate-module detection cannot see a DOM, a layout mismatch, or a silent
 * listener failure. This drives Chromium and asserts what a person would see.
 *
 * What it does NOT do: touch Firestore or the production project. The data
 * layer is stubbed with production-shaped rows (108 seats: A1-A68 + B1-B40),
 * so everything that can break — container lookup, layout arrays, name
 * normalisation, palette, click handling, hidden-input wiring — is the REAL
 * code, while the network is entirely offline.
 *
 * Assertions (each is a way the map has "looked broken" before):
 *   1. the grid renders at all (no silent early return on a missing container)
 *   2. Ground Floor resolves all 68 seats, none as grey "not available"
 *   3. First Floor resolves all 40
 *   4. no "No seats on this floor yet" and no "could not load" banner
 *   5. clicking an Available seat fills selectedSeatNumber + shows the label
 *   6. clicking an Occupied seat is refused (does not fill the input)
 *
 * Exit code 0 = all passed.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

let pass = 0;
const failures = [];
const ok = (l) => { pass++; console.log(`  PASS  ${l}`); };
const bad = (l, e) => { failures.push(l); console.log(`  FAIL  ${l}\n        ${e}`); };
const expect = async (label, fn) => {
  try { await fn(); ok(label); } catch (e) { bad(label, e && e.message ? e.message : e); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

/** Static server that swaps the data layer for stubs and nothing else. */
function serve() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);

    // Harness chrome: no real favicon, so don't let it pollute the error log.
    if (url === "/favicon.ico") {
      res.writeHead(204).end();
      return;
    }

    // Redirect the two modules that would otherwise touch production Firebase.
    let file;
    if (url === "/" || url === "/index.html") file = path.join(HERE, "seatmap-harness.html");
    else if (url.endsWith("/services/seatService.js")) file = path.join(HERE, "stubs", "seatService.js");
    else if (url.endsWith("/firebase/firebase.js")) file = path.join(HERE, "stubs", "firebase.js");
    else if (url === "/scripts/stubs/firestore.js") file = path.join(HERE, "stubs", "firestore.js");
    else file = path.join(ROOT, url.replace(/^\/+/, ""));

    // Refuse anything that escapes the repo.
    if (!file.startsWith(ROOT)) { res.writeHead(403).end("forbidden"); return; }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found: " + url);
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** Resolved seat buttons: placeholders have no onclick, real seats do. */
const countResolved = (page) =>
  page.locator('#signup-seat-grid [onclick*="_signupSelectSeat"]').count();

const seatButton = (page, name) =>
  page.locator(`#signup-seat-grid [onclick*="_signupSelectSeat"]`)
        .filter({ hasText: new RegExp(`^\\s*(?:✓\\s*)?${name}\\s*$`) });

async function main() {
  const server = await serve();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  console.log(`\n=== seat map render test · ${base} ===\n`);

  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  const consoleErrors = [];
  const failedRequests = [];
  page.on("requestfailed", (r) => failedRequests.push(r.url()));
  page.on("response", (r) => { if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`); });
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const loc = m.location() && m.location().url ? ` @ ${m.location().url}` : "";
    consoleErrors.push(m.text() + loc);
  });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  await page.goto(base + "/", { waitUntil: "domcontentloaded" });

  /* 1 — the module loads and the map paints at all. */
  await expect("harness boots without a JS error", async () => {
    await page.waitForFunction(() => window.__harness && (window.__harness.ready || window.__harness.error), null, { timeout: 10000 });
    const h = await page.evaluate(() => window.__harness);
    assert(!h.error, "initSeatMapUI threw: " + h.error);
    assert(h.ready, "initSeatMapUI did not report ready");
  });

  await expect("grid container is present and populated", async () => {
    await page.waitForSelector("#signup-seat-grid", { timeout: 5000 });
    const html = await page.innerHTML("#signup-seat-grid");
    assert(html.trim().length > 0, "grid is empty");
  });

  /* 4 — the two silent-failure messages must never appear. */
  await expect("no 'No seats on this floor yet' placeholder", async () => {
    const t = await page.textContent("#signup-seat-grid");
    assert(!/No seats on this floor yet/.test(t), "grid shows the empty placeholder");
  });
  await expect("no 'could not load' error banner", async () => {
    const t = await page.textContent("#onb-seat");
    assert(!/could not load|failed to load/i.test(t), "error banner is showing: " + t.trim().slice(0, 200));
  });

  /* 2 — every Ground Floor seat resolves against the hardcoded layout. */
  await expect("Ground Floor resolves all 68 seats", async () => {
    const n = await countResolved(page);
    assert(n === 68, `expected 68 resolved seats, got ${n}`);
  });
  await expect("Ground Floor has no grey 'not available' placeholders", async () => {
    const placeholders = await page.locator("#signup-seat-grid [title='Seat not available']").count();
    assert(placeholders === 0, `${placeholders} seats failed name lookup (layout/data mismatch)`);
  });

  /* 3 — switch floors and do it again. */
  await expect("First Floor resolves all 40 seats", async () => {
    await page.click("#signup-tab-first");
    await page.waitForTimeout(200);
    const n = await countResolved(page);
    assert(n === 40, `expected 40 resolved seats, got ${n}`);
    const placeholders = await page.locator("#signup-seat-grid [title='Seat not available']").count();
    assert(placeholders === 0, `${placeholders} seats failed name lookup on First Floor`);
  });

  /* 5 — selecting an Available seat writes the hidden inputs. */
  await expect("clicking an Available seat selects it", async () => {
    await seatButton(page, "B1").first().click();
    const num = await page.inputValue("#selectedSeatNumber");
    const id = await page.inputValue("#selectedSeatId");
    assert(num === "B1", `selectedSeatNumber was "${num}", expected "B1"`);
    assert(id === "B1", `selectedSeatId was "${id}", expected "B1"`);
    const label = await page.textContent("#signup-selected-label");
    assert(/B1/.test(label), "selection label did not update: " + label);
  });

  /* 6 — an Occupied seat must be refused. B7 is Occupied in the stub data. */
  await expect("clicking an Occupied seat is refused", async () => {
    await seatButton(page, "B7").first().click();
    const num = await page.inputValue("#selectedSeatNumber");
    assert(num === "B1", `occupied seat overwrote the selection (got "${num}")`);
  });

  /* Back to Ground Floor — re-render must keep working after a floor switch. */
  await expect("Ground Floor still renders after switching back", async () => {
    await page.click("#signup-tab-ground");
    await page.waitForTimeout(200);
    const n = await countResolved(page);
    assert(n === 68, `expected 68 after returning, got ${n}`);
  });

  await expect("no unexpected console errors", async () => {
    // /favicon.ico 404 is the harness, not the app.
    const ignored = (s) => /favicon\.ico/i.test(s);
    const errs = [...consoleErrors, ...failedRequests].filter((s) => !ignored(s));
    assert(errs.length === 0, errs.join(" | "));
  });

  await browser.close();
  server.close();

  console.log(`\n=== ${pass} passed, ${failures.length} failed ===`);
  if (failures.length) {
    console.log("failing assertions:");
    failures.forEach((f) => console.log("  - " + f));
    process.exit(1);
  }
  console.log("\nSEAT MAP RENDERS AND RESPONDS");
  process.exit(0);
}

main().catch((e) => {
  console.error("\nHarness error:", e);
  process.exit(2);
});
