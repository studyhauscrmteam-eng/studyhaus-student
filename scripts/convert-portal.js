/**
 * One-shot surgical edit of services/studentPortalUI.js
 * Replaces the legacy monolithic admission-form branch (which wrote to the
 * retired `admissions` collection) with the onboarding state-machine gate.
 *
 * Structure before:   if (newUser) { ...old form... } else { dashboard }
 * Structure after:    if (state !== DASHBOARD) { render wizard; return; }
 *                     { dashboard }          <- brace stays balanced
 */
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "services", "studentPortalUI.js");
const START = "  const hasPendingAdmission = sessionStorage.getItem('pendingName')";
const END = "  } else {";

const GATE = `  // ---- First-time onboarding / approval gate --------------------------
  // docs/FLOW-AND-DATA-SPEC.md §3. Every state other than an approved member
  // renders exactly one wizard step (or its pending/rejected screen) and hides
  // the navigation. Once the admin approves, this resolves to DASHBOARD and
  // the wizard never appears again. Nothing is stored in sessionStorage: each
  // step persists to Firestore before advancing, so a half-finished applicant
  // resumes at the same step instead of starting over (and never duplicates).
  const onboardingState = resolvePortalState(s, s._documents || {}, planForRecord(s));
  if (onboardingState !== STATE.DASHBOARD) {
    document.querySelectorAll(".sidebar-nav .nav-item").forEach((item) => {
      item.style.display = "none";
    });
    renderOnboarding({
      container: portalSection,
      state: onboardingState,
      student: s,
      documents: s._documents || {},
      plans: onboardingPlans,
      plan: planForRecord(s),
      onAdvance: () => renderPortal()
    });
    return;
  }

  { // ----- active student dashboard -----`;

const IMPORTS = `import { STATE, resolvePortalState } from "./onboardingService.js";
import { renderOnboarding } from "./onboardingUI.js";`;

const HELPERS = `
/** Plans are fetched once per page load; the wizard needs them to gate seats. */
let onboardingPlans = [];
const planForRecord = (s) =>
  s && s.planId ? onboardingPlans.find((p) => p.id === s.planId) || null : null;
`;

const FETCH = `    // Plans drive the seat-map gate (membershipPlans.seatPreference === true).
    import("./admissionService.js")
      .then(({ fetchPlansForDropdown }) => fetchPlansForDropdown(true))
      .then((p) => { onboardingPlans = p || []; })
      .catch((e) => console.warn("[portal] plans:", e));
`;

function main() {
  const src = fs.readFileSync(FILE, "utf8");
  const lines = src.split(/\r?\n/);

  if (src.includes("resolvePortalState(s,")) {
    console.log("Already converted — nothing to do.");
    return;
  }

  const startIdx = lines.findIndex((l) => l.startsWith(START));
  if (startIdx < 0) throw new Error("Start marker not found");

  // Anchor on the dashboard comment, then take the `} else {` that opens it.
  const dashIdx = lines.findIndex((l) => l.includes("// Normal active student dashboard"));
  if (dashIdx < 0) throw new Error("Dashboard marker not found");
  let endIdx = -1;
  for (let i = dashIdx; i >= startIdx; i--) {
    if (lines[i] === END) { endIdx = i; break; }
  }
  if (endIdx < 0) throw new Error("End marker not found");

  const removed = endIdx - startIdx + 1;
  console.log(`Splicing lines ${startIdx + 1}..${endIdx + 1} (${removed} lines, legacy admission form)`);

  const out = [
    ...lines.slice(0, startIdx),
    ...GATE.split("\n"),
    ...lines.slice(endIdx + 1)
  ];

  // 1. gate replaces the branch
  let result = out.join("\n");

  // 2. imports (after the last top-level import)
  if (!result.includes("onboardingService.js")) {
    const impLines = result.split(/\r?\n/);
    let lastImport = -1;
    for (let i = 0; i < impLines.length; i++) {
      if (/^import .*;$/.test(impLines[i])) lastImport = i;
    }
    if (lastImport < 0) throw new Error("No import block found");
    impLines.splice(lastImport + 1, 0, ...IMPORTS.split("\n"));
    result = impLines.join("\n");
  }

  // 3. helper state after the module-level `let currentRenewals = [];`
  if (!result.includes("onboardingPlans")) {
    const anchor = "let currentRenewals = [];";
    if (!result.includes(anchor)) throw new Error("Helper anchor not found");
    result = result.replace(anchor, anchor + "\n" + HELPERS);
  }

  // 4. fetch plans on init (just before the portal subscription)
  if (!result.includes("onboardingPlans = p || []")) {
    const anchor2 = "  unsubscribePortal = listenToStudentPortalData(async (studentData) => {";
    if (!result.includes(anchor2)) throw new Error("Fetch anchor not found");
    result = result.replace(anchor2, FETCH + "\n" + anchor2);
  }

  fs.writeFileSync(FILE, result, "utf8");

  // 5. Real syntax check (crude brace counting is useless against template
  //    literals full of CSS, so parse it properly instead).
  const { execSync } = require("child_process");
  const os = require("os");
  const tmp = path.join(os.tmpdir(), "portal-syntax-check.mjs");
  fs.copyFileSync(FILE, tmp);
  try {
    execSync(`node --check "${tmp}"`, { stdio: "pipe" });
    console.log("node --check: PASS");
  } catch (e) {
    console.error("node --check FAILED:\n" + (e.stderr ? e.stderr.toString() : e.message));
    process.exit(1);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
  console.log("OK");
}

main();
