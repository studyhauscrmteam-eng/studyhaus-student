/**
 * First-time onboarding wizard (see docs/FLOW-AND-DATA-SPEC.md §3).
 *
 * Renders exactly one screen at a time, derived from the record itself:
 *
 *   Details -> Documents -> Plan -> Seat (only for seat-preferred plans)
 *           -> Payment  -> "Pending admin approval"
 *
 * Nothing here is stored in sessionStorage: every step persists to Firestore
 * before advancing, so closing the tab resumes at the same step instead of
 * restarting (and therefore never creates a second record).
 *
 * After the admin approves, `resolvePortalState` returns DASHBOARD and this
 * module is never rendered again.
 */
import {
  STATE, WIZARD_STEPS, detailsComplete, docsComplete, paymentComplete,
  planRequiresSeat, saveDetails, savePlan, reserveSeat, releaseSeat,
  submitPaymentAndApplication, loadStudentDocuments
} from "./onboardingService.js";
import { fetchPlansForDropdown } from "./admissionService.js";

const esc = (v) => String(v === null || v === undefined ? "" : v)
  .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const toast = (msg, type = "info") => {
  if (window.showToast) window.showToast(msg, type);
  else alert(msg);
};

const FLD = "width:100%;padding:10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-card);color:var(--text-primary);";
const LBL = "font-size:13px;font-weight:600;display:block;margin-bottom:6px;";

const field = (id, label, control, required = false, half = true) => `
  <div class="form-group" style="margin:0;${half ? "" : "grid-column:1 / -1;"}">
    <label for="${id}" style="${LBL}">${label}${required ? ' <span style="color:#e53e3e;">*</span>' : ""}</label>
    ${control}
  </div>`;

const input = (id, type, value, attrs = "") =>
  `<input type="${type}" id="${id}" value="${esc(value)}" style="${FLD}" ${attrs} />`;

/** Progress rail shared by every wizard step. */
const progressHtml = (state, student, documents, plan) => {
  const done = {
    DETAILS: detailsComplete(student),
    DOCUMENTS: docsComplete(documents || {}),
    PLAN: !!student.planId,
    SEAT: planRequiresSeat(plan) ? !!student.seatNumber : true,
    PAYMENT: paymentComplete(student)
  };
  const active = WIZARD_STEPS.findIndex((s) => s.key === state);

  return `
    <div style="display:flex;gap:.5rem;align-items:flex-start;margin-bottom:1.5rem;overflow-x:auto;padding-bottom:.25rem;">
      ${WIZARD_STEPS.map((step, i) => {
        const isDone = done[step.key];
        const isActive = i === active;
        const skipped = step.key === STATE.SEAT && !planRequiresSeat(plan);
        const num = isDone ? "✓" : i + 1;
        const color = isActive ? "var(--primary)" : (isDone ? "var(--success, #10b981)" : "var(--text-muted)");
        const bg = isActive ? "var(--primary)" : (isDone ? "rgba(16,185,129,.15)" : "var(--bg-hover)");
        return `
          <div style="flex:1;min-width:96px;text-align:center;opacity:${skipped ? .45 : 1};">
            <div style="width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;
                        margin:0 auto .4rem;font-size:13px;font-weight:700;color:${isActive ? "#fff" : color};
                        background:${bg};border:2px solid ${isActive ? "var(--primary)" : (isDone ? "rgba(16,185,129,.4)" : "var(--border-bright)")};">
              ${num}
            </div>
            <div style="font-size:11.5px;font-weight:600;color:${isActive ? "var(--text-primary)" : "var(--text-muted)"};">${step.label}</div>
            ${skipped ? `<div style="font-size:10px;color:var(--text-muted);">n/a</div>` : ""}
            <div style="height:3px;border-radius:2px;margin-top:.5rem;background:${isDone || isActive ? color : "var(--border)"};"></div>
          </div>`;
      }).join("")}
    </div>`;
};

const shell = (state, student, documents, plan, body, footer) => `
  <div class="page-header" style="margin-bottom:1.25rem;">
    <div>
      <h1>Complete Your Admission</h1>
      <p class="page-subtitle">Step ${Math.max(1, WIZARD_STEPS.findIndex((s) => s.key === state) + 1)} of ${WIZARD_STEPS.length} — your progress is saved automatically.</p>
    </div>
  </div>
  <div class="card" style="padding:1.75rem;border-radius:12px;background:var(--bg-card);border:1px solid var(--border);">
    ${progressHtml(state, student, documents, plan)}
    ${body}
    <div style="display:flex;gap:.75rem;margin-top:1.75rem;padding-top:1.25rem;border-top:1px solid var(--border);">
      ${footer}
    </div>
  </div>`;

/* --------------------------------------------------------------- step bodies */
const detailsBody = (s) => `
  <h3 style="font-size:15px;margin:0 0 1rem;">Personal details</h3>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.25rem;">
    ${field("onb-name", "Full name", input("onb-name", "text", s.name || "", 'required placeholder="Your full name"'), true)}
    ${field("onb-phone", "Mobile", input("onb-phone", "tel", s.phone || "", 'required pattern="[0-9]{10}" maxlength="10" placeholder="10-digit mobile"'), true)}
    ${field("onb-parent-phone", "Parent mobile", input("onb-parent-phone", "tel", s.parentPhone || "", 'pattern="[0-9]{10}" maxlength="10"'), false)}
    ${field("onb-email", "Email", input("onb-email", "email", s.email || "", 'placeholder="you@example.com"'), false)}
    ${field("onb-dob", "Date of birth", input("onb-dob", "date", s.dob || "", "required"), true)}
    ${field("onb-gender", "Gender", `
      <select id="onb-gender" required style="${FLD}">
        <option value="">Select</option>
        ${["Male", "Female", "Other"].map((g) => `<option value="${g}" ${s.gender === g ? "selected" : ""}>${g}</option>`).join("")}
      </select>`, true)}
    ${field("onb-college", "College / Institute", input("onb-college", "text", s.college || "", 'required placeholder="Your college"'), true)}
    ${field("onb-course", "Course", input("onb-course", "text", s.course || "", 'required placeholder="e.g. B.Com, NEET"'), true)}
    ${field("onb-address", "Address", `<textarea id="onb-address" rows="2" required style="${FLD}" placeholder="Residential address">${esc(s.address || "")}</textarea>`, true, false)}
    ${field("onb-remarks", "Remarks / Exam goal", `<textarea id="onb-remarks" rows="2" style="${FLD}" placeholder="Optional — what are you preparing for?">${esc(s.remarks || "")}</textarea>`, false, false)}
  </div>`;

const documentsBody = (s) => `
  <h3 style="font-size:15px;margin:0 0 .35rem;">Identity documents</h3>
  <p style="font-size:13px;color:var(--text-muted);margin:0 0 1rem;">
    Front and back of your Aadhaar card plus a selfie are required to verify your admission.
    Images are compressed before upload and stay within the free Firestore plan.
  </p>
  <div id="onb-docs" style="margin-bottom:.5rem;"></div>
  <p id="onb-doc-status" style="font-size:12.5px;color:var(--text-muted);margin-top:.75rem;"></p>`;

const planBody = (s, plans) => `
  <h3 style="font-size:15px;margin:0 0 1rem;">Choose your membership plan</h3>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.25rem;">
    ${field("onb-plan", "Membership plan", `
      <select id="onb-plan" required style="${FLD}">
        <option value="">Choose a plan…</option>
        ${plans.map((p) => `<option value="${esc(p.id)}" ${s.planId === p.id ? "selected" : ""}>${esc(p.planName || p.name)} — ₹${esc(p.price)}</option>`).join("")}
      </select>`, true)}
    ${field("onb-plan-note", "Seat selection", `
      <div id="onb-plan-note" style="font-size:12.5px;color:var(--text-muted);padding-top:8px;">
        Fixed-seat plans let you pick your seat in the next step. Others are assigned at the desk.
      </div>`, false)}
  </div>`;

const seatBody = () => `
  <h3 style="font-size:15px;margin:0 0 .35rem;">Pick your seat</h3>
  <p style="font-size:13px;color:var(--text-muted);margin:0 0 1rem;">
    Only seats marked <strong>Available</strong> can be chosen. Your seat is reserved for you the moment you select it.
  </p>
  <div id="onb-seat" style="border:1px solid var(--border-bright);border-radius:12px;padding:1rem;min-height:220px;"></div>
  <input type="hidden" id="selectedSeatNumber" />
  <input type="hidden" id="selectedSeatId" />
  <p id="onb-seat-status" style="font-size:12.5px;color:var(--text-muted);margin-top:.75rem;"></p>`;

const paymentBody = (s, plan, amount) => `
  <h3 style="font-size:15px;margin:0 0 1rem;">Payment</h3>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1.25rem;">
    <label id="onb-pay-later-card" style="border:2px solid var(--border-bright);border-radius:12px;padding:1rem;cursor:pointer;background:rgba(255,255,255,.02);">
      <div style="display:flex;gap:.5rem;align-items:center;margin-bottom:.5rem;">
        <input type="radio" name="onb-paymethod" id="onb-pay-later" value="Pay Later" ${s.paymentMethod === "Pay Later" || !s.paymentMethod ? "checked" : ""} />
        <strong style="font-size:14px;color:var(--text-primary);">Pay Later</strong>
      </div>
      <div style="font-size:12.5px;color:var(--text-muted);margin-bottom:.75rem;">Reserve now, settle at the desk before the due date.</div>
      ${field("onb-due", "Pay by (date)", input("onb-due", "date", s.paymentDueDate || defaultDueDate(), "required"), true, false)}
    </label>

    <label id="onb-pay-now-card" style="border:2px solid var(--border-bright);border-radius:12px;padding:1rem;cursor:pointer;background:rgba(255,255,255,.02);">
      <div style="display:flex;gap:.5rem;align-items:center;margin-bottom:.5rem;">
        <input type="radio" name="onb-paymethod" id="onb-pay-now" value="Paid" ${s.paymentMethod === "Paid" ? "checked" : ""} />
        <strong style="font-size:14px;color:var(--text-primary);">Pay Now (UPI)</strong>
      </div>
      <div style="font-size:12.5px;color:var(--text-muted);margin-bottom:.75rem;">Scan, pay, then paste the reference and attach the screenshot.</div>
      <div style="text-align:center;margin-bottom:.75rem;">
        <img src="" class="payment-qr-img" alt="Scan to pay" style="width:150px;height:150px;object-fit:contain;border:1px solid var(--border);border-radius:8px;background:#fff;" />
        <div style="font-size:13px;font-weight:600;margin-top:.35rem;color:var(--text-primary);">Scan to pay <span style="color:var(--primary);">${esc(amount)}</span></div>
      </div>
      ${field("onb-txn", "Transaction ID", input("onb-txn", "text", s.transactionId || "", 'placeholder="UPI Ref / UTR number"'), true, false)}
      <div id="onb-shot-docs" style="margin-top:.75rem;"></div>
    </label>
  </div>
  <p id="onb-pay-status" style="font-size:12.5px;color:var(--text-muted);"></p>`;

function defaultDueDate() {
  const d = new Date();
  d.setDate(d.getDate() + 3);
  return d.toISOString().split("T")[0];
}

/* ----------------------------------------------------------- terminal bodies */
const pendingBody = (s) => `
  <div style="text-align:center;padding:2rem 1rem;">
    <div style="font-size:3rem;margin-bottom:1rem;">⏳</div>
    <h3 style="margin-bottom:.75rem;color:var(--text-primary);">Submitted — pending admin approval</h3>
    <p style="color:var(--text-secondary);font-size:.95rem;max-width:520px;margin:0 auto 1.25rem;">
      Thanks${s.name ? `, ${esc(s.name)}` : ""}! Your application${s.planName ? ` for <strong>${esc(s.planName)}</strong>` : ""}
      ${s.seatNumber ? ` with seat <strong>${esc(s.seatNumber)}</strong>` : ""} has been received.
      The admin will verify your details and payment, then activate your portal.
    </p>
    <ul style="text-align:left;color:var(--text-secondary);font-size:.95rem;line-height:1.6;padding-left:1.5rem;max-width:460px;margin:0 auto 1.5rem;">
      <li>Check status here any time — this screen disappears once you are approved.</li>
      <li>Choosing <strong>Pay Later</strong>? Please visit the desk before
        <strong>${s.paymentDueDate ? new Date(s.paymentDueDate).toLocaleDateString("en-GB") : "your due date"}</strong>.</li>
      <li>Need to change something? Contact the desk and the admin can reopen your application.</li>
    </ul>
    <button class="btn btn-ghost" onclick="window.location.reload()">Refresh status</button>
  </div>`;

const rejectedBody = (s) => `
  <div style="text-align:center;padding:2rem 1rem;">
    <div style="font-size:3rem;margin-bottom:1rem;">🚫</div>
    <h3 style="margin-bottom:.75rem;color:var(--text-primary);">Application not approved</h3>
    ${s.rejectReason ? `<p style="color:var(--text-secondary);max-width:520px;margin:0 auto 1rem;">Reason: <strong>${esc(s.rejectReason)}</strong></p>` : ""}
    <p style="color:var(--text-secondary);max-width:520px;margin:0 auto 1.5rem;">
      Please speak to the front desk to sort this out, then ask the admin to reopen your application.
    </p>
    <button class="btn btn-ghost" onclick="window.location.reload()">Refresh status</button>
  </div>`;

const signupBody = () => `
  <div style="text-align:center;padding:2rem 1rem;">
    <div style="font-size:3rem;margin-bottom:1rem;">👋</div>
    <h3 style="margin-bottom:.75rem;color:var(--text-primary);">Let's create your account</h3>
    <p style="color:var(--text-secondary);max-width:520px;margin:0 auto;">
      Please sign in again to continue. If you have not registered yet, use
      <strong>Sign Up</strong> on the login page with your mobile number or email.
    </p>
    <a class="btn btn-primary" href="/login.html" style="margin-top:1.25rem;">Go to sign in</a>
  </div>`;

/* ------------------------------------------------------------------ renderer */
/**
 * @param {HTMLElement} container  element to render into
 * @param {{state:string, student:Object, documents?:Object, plan?:Object,
 *          plans?:Object[], onAdvance:Function}} opts
 */
export const renderOnboarding = async (opts) => {
  const { container, state, student, onAdvance } = opts;
  if (!container) return;
  const documents = opts.documents || student._documents || {};
  let plans = opts.plans;
  let plan = opts.plan || null;

  if (!plans || !plans.length) {
    try { plans = await fetchPlansForDropdown(true); } catch (_) { plans = []; }
  }
  if (!plan && student.planId) plan = plans.find((p) => p.id === student.planId) || null;

  const amount = plan && plan.price != null ? `₹${plan.price}` : "—";
  const stepIdx = WIZARD_STEPS.findIndex((s) => s.key === state);

  const setBusy = (busy, label) => {
    container.querySelectorAll("button[data-onb-next], button[data-onb-back]").forEach((b) => {
      if (busy) { b.dataset._label = b.innerHTML; b.innerHTML = label || "Saving…"; b.disabled = true; }
      else { b.innerHTML = b.dataset._label || b.innerHTML; b.disabled = false; }
    });
  };

  let body = "";
  let footer = "";

  switch (state) {
    case STATE.DETAILS:
      body = detailsBody(student);
      footer = `
        <button class="btn btn-primary" data-onb-next style="flex:1;">Continue →</button>`;
      break;

    case STATE.DOCUMENTS:
      body = documentsBody(student);
      footer = `
        <button class="btn btn-ghost" data-onb-back style="flex:0 0 auto;">← Back</button>
        <button class="btn btn-primary" data-onb-next style="flex:1;">Continue →</button>`;
      break;

    case STATE.PLAN:
      body = planBody(student, plans);
      footer = `
        <button class="btn btn-ghost" data-onb-back style="flex:0 0 auto;">← Back</button>
        <button class="btn btn-primary" data-onb-next style="flex:1;">Continue →</button>`;
      break;

    case STATE.SEAT:
      body = seatBody();
      footer = `
        <button class="btn btn-ghost" data-onb-back style="flex:0 0 auto;">← Back</button>
        <button class="btn btn-primary" data-onb-next style="flex:1;">Reserve seat &amp; continue →</button>`;
      break;

    case STATE.PAYMENT:
      body = paymentBody(student, plan, amount);
      footer = `
        <button class="btn btn-ghost" data-onb-back style="flex:0 0 auto;">← Back</button>
        <button class="btn btn-primary" data-onb-next style="flex:1;">Submit application</button>`;
      break;

    case STATE.PENDING:
      container.innerHTML = shell(state, student, documents, plan, pendingBody(student), "");
      return;

    case STATE.REJECTED:
      container.innerHTML = shell(state, student, documents, plan, rejectedBody(student), "");
      return;

    default:
      container.innerHTML = shell(state, student, documents, plan, signupBody(), "");
      return;
  }

  container.innerHTML = shell(state, student, documents, plan, body, footer);

  /* ------------------------------------------------ per-step initialization */
  if (state === STATE.DOCUMENTS) {
    const status = document.getElementById("onb-doc-status");
    import("./documentUploadService.js").then(({ initDocumentUploads, getSelectedDocumentFiles, uploadAdmissionDocuments }) => {
      initDocumentUploads("onb-docs");
      window.__onbGetFiles = getSelectedDocumentFiles;
      window.__onbUploadFiles = uploadAdmissionDocuments;
      if (status) {
        const have = [documents.aadhaarFront, documents.aadhaarBack, documents.photo].filter(Boolean).length;
        status.textContent = have === 3
          ? "All three documents are already on file."
          : have > 0 ? `${have} of 3 documents on file — please attach the rest.`
                     : "None uploaded yet — all three are required.";
      }
    }).catch((e) => { if (status) status.textContent = "Upload component unavailable: " + e.message; });
  }

  if (state === STATE.PLAN) {
    const sel = document.getElementById("onb-plan");
    const note = document.getElementById("onb-plan-note");
    const updateNote = () => {
      const p = plans.find((x) => x.id === sel.value);
      if (!note) return;
      note.textContent = !p
        ? "Fixed-seat plans let you pick your seat in the next step. Others are assigned at the desk."
        : p.seatPreference === true
          ? `${p.planName} is a fixed-seat plan — you will choose your seat in the next step.`
          : `${p.planName} has no seat preference — your seat will be assigned at the desk.`;
    };
    if (sel) { sel.addEventListener("change", updateNote); updateNote(); }
  }

  if (state === STATE.SEAT) {
    const status = document.getElementById("onb-seat-status");
    const prefill = () => {
      const numEl = document.getElementById("selectedSeatNumber");
      if (numEl && !numEl.value && student.seatNumber) {
        numEl.value = student.seatNumber;
        const idEl = document.getElementById("selectedSeatId");
        if (idEl && !idEl.value) idEl.value = student.seatNumber;
        if (status) status.textContent = `Currently reserved: seat ${student.seatNumber}. Pick a different one to change it.`;
      }
    };
    import("./seatMapUI.js")
      .then(({ initSeatMapUI }) => initSeatMapUI("signup", "onb-seat"))
      .then(prefill)
      .catch((e) => { if (status) status.textContent = "Seat map unavailable: " + e.message; });
  }

  if (state === STATE.PAYMENT) {
    import("./documentUploadService.js").then(({ initDocumentUploads, getSelectedDocumentFiles, uploadAdmissionDocuments }) => {
      initDocumentUploads("onb-shot-docs");
      window.__onbGetFiles = getSelectedDocumentFiles;
      window.__onbUploadFiles = uploadAdmissionDocuments;
      // The payment step only needs the screenshot.
      ["aadhaarFront", "aadhaarBack"].forEach((k) => {
        const c = document.getElementById("doc-card-" + k);
        if (c) c.style.display = "none";
      });
      const photoCard = document.getElementById("doc-card-photo");
      if (photoCard) {
        photoCard.style.gridColumn = "1 / -1";
        const lbl = photoCard.querySelector("div[style*='font-size:12px']");
        if (lbl) lbl.textContent = "Payment screenshot *";
      }
      if (student.paymentScreenshotUrl) {
        const st = document.getElementById("onb-pay-status");
        if (st) st.textContent = "A payment screenshot is already attached.";
      }
    }).catch(() => {});
    import("./qrService.js").then(({ paintQrImages }) => paintQrImages(container)).catch(() => {});

    const syncCards = () => {
      const later = document.getElementById("onb-pay-later");
      const now = document.getElementById("onb-pay-now");
      const l = document.getElementById("onb-pay-later-card");
      const n = document.getElementById("onb-pay-now-card");
      const on = now && now.checked;
      if (l) l.style.borderColor = on ? "var(--border-bright)" : "var(--primary)";
      if (n) n.style.borderColor = on ? "var(--primary)" : "var(--border-bright)";
      const due = document.getElementById("onb-due");
      if (due) due.disabled = !!on;
      if (later) later.addEventListener("change", syncCards);
      if (now) now.addEventListener("change", syncCards);
    };
    syncCards();
  }

  /* -------------------------------------------------------- step navigation */
  const backBtn = container.querySelector("[data-onb-back]");
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      const prev = WIZARD_STEPS[stepIdx - 1];
      if (prev) onAdvance(prev.key);
    });
  }

  const nextBtn = container.querySelector("[data-onb-next]");
  if (nextBtn) nextBtn.addEventListener("click", () => runStep(state, student, plans, setBusy, onAdvance));
};

/* ------------------------------------------------------------------- save */
const val = (id) => {
  const el = document.getElementById(id);
  return el ? String(el.value || "").trim() : "";
};

const runStep = async (state, student, plans, setBusy, onAdvance) => {
  const id = student.id;

  try {
    /* ------------------------------------------------------------- details */
    if (state === STATE.DETAILS) {
      const name = val("onb-name");
      const phone = val("onb-phone").replace(/\D/g, "");
      const dob = val("onb-dob");
      const gender = val("onb-gender");
      const college = val("onb-college");
      const course = val("onb-course");
      const address = val("onb-address");

      if (!name) return toast("Please enter your full name.", "warning");
      if (phone.length !== 10) return toast("Please enter a valid 10-digit mobile number.", "warning");
      if (!dob) return toast("Please enter your date of birth.", "warning");
      if (!gender) return toast("Please select your gender.", "warning");
      if (!college) return toast("Please enter your college / institute.", "warning");
      if (!course) return toast("Please enter your course.", "warning");
      if (!address) return toast("Please enter your address.", "warning");

      setBusy(true, "Saving…");
      const res = await saveDetails(id, {
        name, phone, dob, gender, college, course, address,
        parentPhone: val("onb-parent-phone").replace(/\D/g, ""),
        email: val("onb-email").toLowerCase(),
        remarks: val("onb-remarks")
      });
      setBusy(false);
      if (!res.success) return toast("Could not save: " + res.error, "error");
      toast("Details saved.", "success");
      return onAdvance(STATE.DOCUMENTS);
    }

    /* ---------------------------------------------------------- documents */
    if (state === STATE.DOCUMENTS) {
      const files = (window.__onbGetFiles && window.__onbGetFiles()) || {};
      if (!files.aadhaarFront) return toast("Please attach the front of your Aadhaar card.", "warning");
      if (!files.aadhaarBack) return toast("Please attach the back of your Aadhaar card.", "warning");
      if (!files.photo) return toast("Please attach a selfie / photo.", "warning");

      setBusy(true, "Uploading…");
      try {
        if (window.__onbUploadFiles) {
          await window.__onbUploadFiles(
            { aadhaarFront: files.aadhaarFront, aadhaarBack: files.aadhaarBack, photo: files.photo },
            id
          );
        }
        // Persist a flag so the state machine can see completion without a
        // second round-trip (the images live in studentDocuments, not here).
        const { updateDoc, doc, serverTimestamp } = await import("firebase/firestore");
        const { db } = await import("../firebase/firebase.js");
        await updateDoc(doc(db, "students", id), {
          hasDocuments: true,
          updatedAt: serverTimestamp()
        });
      } catch (e) {
        setBusy(false);
        return toast("Upload failed: " + (e.message || e), "error");
      }
      setBusy(false);
      toast("Documents uploaded.", "success");
      return onAdvance(STATE.PLAN);
    }

    /* --------------------------------------------------------------- plan */
    if (state === STATE.PLAN) {
      const planId = val("onb-plan");
      if (!planId) return toast("Please choose a membership plan.", "warning");
      const plan = plans.find((p) => p.id === planId);
      if (!plan) return toast("That plan could not be found. Please refresh.", "error");

      setBusy(true, "Saving…");
      const prevSeat = student.seatNumber;
      const res = await savePlan(id, plan);
      setBusy(false);
      if (!res.success) return toast("Could not save: " + res.error, "error");

      // Moving to a plan without seat selection releases a previously reserved seat.
      if (planRequiresSeat(plan) === false && prevSeat) await releaseSeat(prevSeat);

      toast("Plan selected.", "success");
      return onAdvance(planRequiresSeat(plan) ? STATE.SEAT : STATE.PAYMENT);
    }

    /* --------------------------------------------------------------- seat */
    if (state === STATE.SEAT) {
      const seatNumber = val("selectedSeatNumber");
      if (!seatNumber) return toast("Please select a seat from the map.", "warning");

      setBusy(true, "Reserving…");
      const res = await reserveSeat(id, seatNumber, student.name || "");
      setBusy(false);
      if (!res.success) return toast(res.error, "error");

      toast(`Seat ${seatNumber} reserved for you.`, "success");
      return onAdvance(STATE.PAYMENT);
    }

    /* ------------------------------------------------------------ payment */
    if (state === STATE.PAYMENT) {
      const nowEl = document.getElementById("onb-pay-now");
      const paid = !!(nowEl && nowEl.checked);
      const method = paid ? "Paid" : "Pay Later";
      const txnId = val("onb-txn");
      const dueDate = val("onb-due");

      if (!paid && !dueDate) return toast("Please choose the date you will pay by.", "warning");
      if (paid && !txnId) return toast("Please enter the transaction ID from your payment.", "warning");

      setBusy(true, paid ? "Submitting payment…" : "Submitting…");
      let shot = "";
      try {
        if (paid) {
          const files = (window.__onbGetFiles && window.__onbGetFiles()) || {};
          if (!files.photo && !student.paymentScreenshotUrl) {
            setBusy(false);
            return toast("Please attach a screenshot of your payment.", "warning");
          }
          if (files.photo && window.__onbUploadFiles) {
            const map = await window.__onbUploadFiles({ paymentScreenshot: files.photo }, id);
            shot = map.paymentScreenshotUrl || "";
          }
        }
        const res = await submitPaymentAndApplication(id, {
          paymentMethod: method,
          transactionId: paid ? txnId : "",
          paymentDueDate: paid ? "" : dueDate,
          paymentScreenshotUrl: shot || student.paymentScreenshotUrl || ""
        });
        setBusy(false);
        if (!res.success) return toast("Could not submit: " + res.error, "error");
      } catch (e) {
        setBusy(false);
        return toast("Could not submit: " + (e.message || e), "error");
      }

      toast("Application submitted — pending admin approval.", "success");
      return onAdvance(STATE.PENDING);
    }
  } catch (e) {
    setBusy(false);
    toast("Something went wrong: " + (e.message || e), "error");
  }
};

export { loadStudentDocuments };
