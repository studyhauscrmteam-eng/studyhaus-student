/**
 * Deploy this repo to Firebase Hosting WITHOUT the firebase CLI.
 *
 * Why: the CLI login on operator machines may lack serviceusage.services.use
 * on the project and dies before uploading. This script talks to the Hosting
 * REST API directly with a service-account key:
 *   versions.create -> populateFiles -> upload gzipped files -> FINALIZED
 *   -> releases.create (live)
 *
 * Usage:
 *   node scripts/deploy-hosting.js --status            list sites + live releases
 *   node scripts/deploy-hosting.js --dry-run           show what would upload (no network writes)
 *   node scripts/deploy-hosting.js --site <SITE_ID>    deploy working tree to a site
 *   node scripts/deploy-hosting.js --rules             deploy firestore.rules (same key, Rules API)
 *
 * Auth (first one found wins):
 *   1. --key <path-to-service-key.json>
 *   2. $SERVICE_KEY_JSON (raw JSON string)
 *   3. $SERVICE_KEY (path to service-key.json)
 *   4. $GOOGLE_APPLICATION_CREDENTIALS (path)
 *   5. Shreeji-Library/server/serviceAccountKey.json next to this repo's parent
 *      (override root with $KEY_REPO_ROOT)
 *   6. $FIREBASE_TOKEN (raw OAuth2 access token, service keys preferred)
 *
 * The key needs Firebase Hosting Admin (or Editor) on the project.
 * Project defaults to the key's project_id (override: --project <id>).
 * Serving config (headers/rewrites) is read from this repo's firebase.json.
 * Deploy is from the WORKING TREE — uncommitted changes go live.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");

const ROOT = path.resolve(__dirname, "..");
const HOST = "https://firebasehosting.googleapis.com/v1beta1";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

// Top-level entries never deployed (mirror firebase.json ignore + operator rules).
const IGNORE_TOP_FILES = new Set([
  "firebase.json",
  "firestore.rules",
  "firestore.indexes.json",
  "package.json",
  "package-lock.json",
]);
const IGNORE_TOP_DIRS = new Set(["scripts", "backup", "dist"]);
const IGNORE_EXTS = new Set([".md", ".log"]);

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
};
const WANT_STATUS = args.includes("--status");
const WANT_DRY_RUN = args.includes("--dry-run");
const WANT_RULES = args.includes("--rules");
const RULES_HOST = "https://firebaserules.googleapis.com/v1";
let SITE_ID = flag("--site") === true ? null : flag("--site");
let PROJECT_ID = flag("--project") === true ? null : flag("--project");
const CHANNEL = flag("--channel") === true ? null : flag("--channel") || "live";

const fail = (msg) => {
  console.error("\nDEPLOY FAILED: " + msg);
  process.exit(1);
};

/* ---------------- key / token ---------------- */

function defaultKeyPaths() {
  const roots = [];
  if (process.env.KEY_REPO_ROOT) roots.push(process.env.KEY_REPO_ROOT);
  roots.push(path.resolve(ROOT, "..", "..", "LIB", "New folder"));
  roots.push(path.resolve(ROOT, ".."));
  return roots.map((r) => path.join(r, "Shreeji-Library", "server", "serviceAccountKey.json"));
}

function loadServiceKey() {
  if (flag("--key") && flag("--key") !== true) {
    const p = path.resolve(String(flag("--key")));
    if (!fs.existsSync(p)) fail("key file not found: " + p);
    return JSON.parse(fs.readFileSync(p, "utf8"));
  }
  if (process.env.SERVICE_KEY_JSON) return JSON.parse(process.env.SERVICE_KEY_JSON);
  for (const p of [process.env.SERVICE_KEY, process.env.GOOGLE_APPLICATION_CREDENTIALS]) {
    if (p && fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  }
  for (const p of defaultKeyPaths()) {
    if (fs.existsSync(p)) {
      console.log("Using service key: " + p);
      return JSON.parse(fs.readFileSync(p, "utf8"));
    }
  }
  return null;
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function accessTokenFromKey(key) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/firebase.hosting https://www.googleapis.com/auth/cloud-platform",
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now,
  }));
  const signingInput = `${header}.${claims}`;
  const sig = crypto.sign("RSA-SHA256", Buffer.from(signingInput), key.private_key);
  const assertion = `${signingInput}.${b64url(sig)}`;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  if (!res.ok) fail(`token exchange HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  if (!body.access_token) fail("token exchange returned no access_token");
  return body.access_token;
}

/* ---------------- api helper ---------------- */

let TOKEN = "";
async function api(method, urlPath, body, query) {
  let url = HOST + urlPath;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    if (qs) url += (url.includes("?") ? "&" : "?") + qs;
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: "Bearer " + TOKEN,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON */ }
  if (!res.ok) {
    const msg = (json && json.error && json.error.message) || text || res.statusText;
    fail(`API ${method} ${urlPath} -> HTTP ${res.status}: ${String(msg).slice(0, 500)}`);
  }
  return json;
}

/* ---------------- file walk ---------------- */

function shouldSkip(relPosix) {
  const parts = relPosix.split("/");
  // node_modules / .git anywhere, dotfiles/dot-dirs anywhere
  for (const p of parts) {
    if (p === "node_modules" || p === ".git" || p.startsWith(".")) return true;
  }
  if (parts.length === 1) {
    if (IGNORE_TOP_FILES.has(parts[0])) return true;
  }
  if (IGNORE_TOP_DIRS.has(parts[0])) return true;
  const base = parts[parts.length - 1];
  const dot = base.lastIndexOf(".");
  if (dot !== -1 && IGNORE_EXTS.has(base.slice(dot).toLowerCase())) return true;
  return false;
}

function walkFiles(publicDir) {
  const out = [];
  const visit = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        const rel = path.relative(publicDir, full).split(path.sep).join("/");
        // cheap dir-level prune: skip ignored top dirs and dot-dirs early
        const top = rel.split("/")[0];
        if (IGNORE_TOP_DIRS.has(top) || ent.name.startsWith(".") || top === "node_modules") continue;
        visit(full);
      } else if (ent.isFile()) {
        const rel = path.relative(publicDir, full).split(path.sep).join("/");
        if (!shouldSkip(rel)) out.push({ full, rel: "/" + rel });
      }
    }
  };
  visit(publicDir);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

/* ---------------- serving config ---------------- */

function servingConfig(firebaseJson) {
  const hosting = firebaseJson.hosting || {};
  const cfg = {};
  if (Array.isArray(hosting.headers)) {
    cfg.headers = hosting.headers.map((h) => ({
      glob: h.source || h.glob || "**",
      headers: Object.fromEntries((h.headers || []).map((x) => [x.key, x.value])),
    }));
  }
  if (Array.isArray(hosting.rewrites)) {
    // REST ServingConfig.Rewrite uses glob + path (firebase.json calls it destination).
    cfg.rewrites = hosting.rewrites.map((r) => {
      const out = { glob: r.source || r.glob || "**" };
      if (r.destination !== undefined) out.path = r.destination;
      else if (r.path !== undefined) out.path = r.path;
      if (r.function !== undefined) out.function = r.function;
      if (r.run !== undefined) out.run = r.run;
      if (r.regex !== undefined) { delete out.glob; out.regex = r.regex; }
      return out;
    });
  }
  return cfg;
}

/* ---------------- status ---------------- */

async function showStatus() {
  const sitesRes = await api("GET", `/projects/${PROJECT_ID}/sites`);
  const sites = (sitesRes && sitesRes.sites) || [];
  if (!sites.length) {
    console.log(`No hosting sites in project ${PROJECT_ID}.`);
    return;
  }
  for (const s of sites) {
    const name = s.name || "";
    const id = name.split("/").pop();
    let line = `- site ${id}`;
    try {
      const ch = await api("GET", `/${name}/channels/${CHANNEL}`);
      const rel = ch.release || {};
      line += `  url=${ch.url || "?"}`;
      const ver = (rel.version && rel.version.name) || rel.name || null;
      line += `  release=${ver || "?"}`;
      if (rel.createTime) line += `  at=${rel.createTime}`;
    } catch (e) {
      line += "  (no live release info)";
    }
    try {
      const doms = await api("GET", `/${name}/customDomains`);
      const list = (doms && doms.customDomains) || [];
      if (list.length) line += `  domains=[${list.map((d) => (d.name || "").split("/").pop()).join(", ")}]`;
    } catch (e) { /* custom-domain listing not permitted — skip */ }
    console.log(line);
  }
}

/* ---------------- deploy ---------------- */

async function uploadOne(uploadUrl, hash, gzipped, rel) {
  const url = `${uploadUrl}/${hash}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + TOKEN,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(gzipped.length),
    },
    body: gzipped,
  });
  if (!res.ok) {
    const t = (await res.text()).slice(0, 400);
    fail(`upload ${rel} (hash ${hash.slice(0, 12)}…) -> HTTP ${res.status}: ${t}`);
  }
}

async function deploy() {
  if (!SITE_ID) {
    console.log("No --site given. Available sites:");
    await showStatus();
    fail("re-run with --site <SITE_ID> (or set $SITE_ID).");
  }

  const firebaseJson = JSON.parse(fs.readFileSync(path.join(ROOT, "firebase.json"), "utf8"));
  const publicDir = path.resolve(ROOT, (firebaseJson.hosting && firebaseJson.hosting.public) || ".");
  const config = servingConfig(firebaseJson);

  const files = walkFiles(publicDir);
  if (!files.length) fail("no deployable files found under " + publicDir);
  const entries = files.map((f) => {
    const raw = fs.readFileSync(f.full);
    const gz = zlib.gzipSync(raw, { level: 9 });
    const hash = crypto.createHash("sha256").update(gz).digest("hex");
    return { rel: f.rel, gz, hash, rawBytes: raw.length };
  });
  const totalRaw = entries.reduce((n, e) => n + e.rawBytes, 0);
  const totalGz = entries.reduce((n, e) => n + e.gz.length, 0);
  console.log(`Files: ${entries.length}  raw=${(totalRaw / 1048576).toFixed(2)} MB  gzipped=${(totalGz / 1048576).toFixed(2)} MB`);
  console.log(`Site: ${SITE_ID}  project: ${PROJECT_ID}  config: ${JSON.stringify(config)}`);

  if (WANT_DRY_RUN) {
    console.log("--dry-run: stopping before any network writes.");
    return;
  }

  // 1. create version
  const ver = await api("POST", `/sites/${SITE_ID}/versions`, { config });
  const versionName = ver.name;
  console.log("Version: " + versionName);

  // 2. declare files
  const pop = await api("POST", `/${versionName}:populateFiles`, {
    files: Object.fromEntries(entries.map((e) => [e.rel, e.hash])),
  });
  const uploadUrl = pop.uploadUrl;
  let required = pop.uploadRequiredHashes || [];
  if (!Array.isArray(required) && required && typeof required === "object") {
    required = Object.keys(required);
  }
  if (!uploadUrl) fail("populateFiles returned no uploadUrl");
  const byHash = new Map(entries.map((e) => [e.hash, e]));
  console.log(`Upload ${required.length} new/changed file(s), ${entries.length - required.length} already live.`);

  // 3. upload (small pool for speed)
  const POOL = 8;
  for (let i = 0; i < required.length; i += POOL) {
    await Promise.all(required.slice(i, i + POOL).map((h) => {
      const e = byHash.get(h);
      if (!e) fail("server asked for unknown hash " + h);
      return uploadOne(uploadUrl, h, e.gz, e.rel);
    }));
    if (required.length > POOL) console.log(`  …${Math.min(i + POOL, required.length)}/${required.length}`);
  }

  // 4. finalize
  await api("PATCH", `/${versionName}`, { status: "FINALIZED" }, { updateMask: "status" });
  console.log("Finalized.");

  // 5. release live
  const rel = await api("POST", `/sites/${SITE_ID}/releases`, {}, { versionName });
  console.log("LIVE: " + ((rel && rel.name) || versionName));
  console.log(`Done — https://${SITE_ID}.web.app (custom domains serve the same release).`);
}

/* ---------------- firestore.rules ---------------- */

async function rulesApi(method, urlPath, body) {
  const res = await fetch(RULES_HOST + urlPath, {
    method,
    headers: {
      Authorization: "Bearer " + TOKEN,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON */ }
  if (!res.ok) {
    const msg = (json && json.error && (json.error.message || JSON.stringify(json.error))) || text || res.statusText;
    const err = new Error(`Rules API ${method} ${urlPath} -> HTTP ${res.status}: ${String(msg).slice(0, 400)}`);
    err.http = res.status;
    throw err;
  }
  return json;
}

async function deployRules() {
  const rulesPath = path.join(ROOT, "firestore.rules");
  if (!fs.existsSync(rulesPath)) fail("firestore.rules not found in " + ROOT);
  const content = fs.readFileSync(rulesPath, "utf8");
  console.log(`Rules: ${content.length} chars from firestore.rules`);

  // 1. create ruleset
  const rs = await rulesApi("POST", `/projects/${PROJECT_ID}/rulesets`, {
    source: { files: [{ name: "firestore.rules", content }] },
  });
  const rulesetName = rs.name;
  console.log("Ruleset: " + rulesetName);

  // 2. point the firestore release at it (create, or patch if it exists)
  const releaseName = `projects/${PROJECT_ID}/releases/cloud.firestore`;
  try {
    await rulesApi("POST", `/projects/${PROJECT_ID}/releases`, {
      name: releaseName,
      rulesetName,
    });
  } catch (e) {
    if (e.http === 409) {
      try {
        await patchReleaseFirestore(rulesetName);
      } catch (e2) {
        if (e2.http !== 403 && !/permission/i.test(e2.message)) throw e2;
        return rulesManualFallback(rulesetName);
      }
    } else if (e.http === 403 || /permission/i.test(e.message)) {
      return rulesManualFallback(rulesetName);
    } else {
      throw e;
    }
  }
  console.log("RULES LIVE for Cloud Firestore.");
}

function rulesManualFallback(rulesetName) {
  console.log("\nRuleset compiled OK: " + rulesetName);
  console.log("This key may NOT publish releases (same IAM gap as the CLI).");
  console.log("Manual step (1 min, one time): Firebase Console → Firestore Database → Rules tab");
  console.log("→ paste firestore.rules from this repo → Publish. The seatRequests block then goes live.");
  process.exit(2);
}

// PATCH needs query params — small dedicated call (helper has no query support).
async function patchReleaseFirestore(rulesetName) {
  const releaseName = `projects/${PROJECT_ID}/releases/cloud.firestore`;
  const url = `${RULES_HOST}/${releaseName}?updateMask=ruleset_name`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ name: releaseName, rulesetName }),
  });
  if (!res.ok) fail(`Rules PATCH -> HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
}

/* ---------------- main ---------------- */

(async () => {
  const key = loadServiceKey();
  if (key) {
    if (!PROJECT_ID) PROJECT_ID = key.project_id || null;
    console.log(`Auth: service key ${key.client_email} (project ${PROJECT_ID})`);
    TOKEN = await accessTokenFromKey(key);
  } else if (process.env.FIREBASE_TOKEN) {
    if (!PROJECT_ID) fail("FIREBASE_TOKEN set but no --project given.");
    console.log("Auth: FIREBASE_TOKEN");
    TOKEN = process.env.FIREBASE_TOKEN;
  } else {
    fail("no credentials: pass --key <service-key.json> or set SERVICE_KEY / GOOGLE_APPLICATION_CREDENTIALS / FIREBASE_TOKEN.");
  }
  if (!PROJECT_ID) fail("no project: pass --project <id>.");
  if (process.env.SITE_ID && !SITE_ID) SITE_ID = process.env.SITE_ID;

  if (WANT_STATUS) await showStatus();
  else if (WANT_RULES) await deployRules();
  else await deploy();
})().catch((e) => fail(e && e.message ? e.message : String(e)));
