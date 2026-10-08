/**
 * Find every JS/HTML module specifier in the repo, group by the file it
 * points at, and report targets imported with MORE THAN ONE distinct URL
 * (e.g. "./auth/login.js?v=login3" vs "./login.js?v=login2").
 * Those are the duplicate-module-instance bugs.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SKIP = new Set(["node_modules", ".git", "backup", "dist"]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

const SPEC = /(?:from\s+|import\s+|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;

// Group by the resolved FILE. A conflict exists only when the same file is
// reached through URLs that differ in query string — "./x.js" and "../a/x.js"
// resolve to one absolute URL (same instance, not a conflict), but
// "./x.js?v=1" and "./x.js?v=2" are two live copies.
const map = new Map();

for (const file of walk(ROOT)) {
  const src = fs.readFileSync(file, "utf8");
  let m;
  while ((m = SPEC.exec(src))) {
    const spec = m[1];
    const [clean, query] = spec.split("?");
    let target;
    try {
      target = path.resolve(path.dirname(file), clean);
    } catch (_) { continue; }
    if (!fs.existsSync(target)) continue;
    if (!map.has(target)) map.set(target, new Map());
    const entry = map.get(target);
    const url = path.relative(ROOT, target).split(path.sep).join("/") + (query ? "?" + query : "");
    if (!entry.has(url)) entry.set(url, new Map());
    const users = entry.get(url);
    users.set(path.relative(ROOT, file), true);
  }
}

const conflicts = [...map.entries()]
  .filter(([, variants]) => variants.size > 1)
  .sort((a, b) => b[1].size - a[1].size);

if (!conflicts.length) {
  console.log("No duplicate-module conflicts found.");
  process.exit(0);
}

console.log(`DUPLICATE MODULE INSTANCES: ${conflicts.length}\n`);
for (const [target, variants] of conflicts) {
  console.log(`* ${path.relative(ROOT, target)}`);
  for (const [url, users] of variants) {
    console.log(`    ${url}`);
    console.log(`       <- ${[...users.keys()].join(", ")}`);
  }
  console.log("");
}
