import { listenToStudentPortalData, updateStudentOwnProfile } from "./studentPortalService.js";
import { listenToMyAttendance, checkIn, checkOut } from "./attendanceService.js";
import { calculateStudyHours } from "./studyHourCalculator.js";
import { generateAttendancePDF } from "./pdfService.js";
import { listenToMyPayments, submitPaymentRequest } from "./paymentService.js";

// ── Payment screenshot: compress single proof image to ≤200k-char data-URL ────
// Mandatory proof for payments — exactly 1 screenshot per payment.
const compressPaymentScreenshot = (file) => new Promise((resolve, reject) => {
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => {
    URL.revokeObjectURL(url);
    const MAX_DIM = 600;
    let { width, height } = img;
    if (width > height) { height = Math.round((height / width) * MAX_DIM); width = MAX_DIM; }
    else { width = Math.round((width / height) * MAX_DIM); height = MAX_DIM; }
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    canvas.getContext("2d").drawImage(img, 0, 0, width, height);
    let q = 0.6;
    let dataUrl = canvas.toDataURL("image/jpeg", q);
    while (dataUrl.length > 200000 && q > 0.2) {
      q -= 0.1;
      dataUrl = canvas.toDataURL("image/jpeg", q);
    }
    resolve(dataUrl);
  };
  img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Not a readable image")); };
  img.src = url;
});

const collectPaymentScreenshot = async () => {
  const input = document.getElementById("payment-ss");
  if (!input || !input.files || !input.files.length || !input.files[0]) {
    throw new Error("Payment screenshot proof is required.");
  }
  const f = input.files[0];
  if (!f.type.startsWith("image/")) {
    throw new Error("Payment screenshot must be an image file (JPG or PNG).");
  }
  return await compressPaymentScreenshot(f);
};

// Global proof preview modal for student portal
window.viewStudentProofModal = (dataUrl, title = "Payment Screenshot Proof") => {
  const isValidImage = (u) => typeof u === "string" && (u.startsWith("data:image/") || u.startsWith("http://") || u.startsWith("https://") || u.startsWith("blob:"));
  if (!isValidImage(dataUrl)) {
    if (window.showToast) window.showToast("No valid screenshot proof attached.", "warning");
    return;
  }
  const old = document.getElementById("student-proof-modal");
  if (old) old.remove();

  const dialog = document.createElement("dialog");
  dialog.id = "student-proof-modal";
  dialog.className = "card smooth-modal";
  dialog.style.cssText = "border:none; border-radius:14px; padding:0; box-shadow:0 18px 45px rgba(0,0,0,0.5); background:var(--bg-card); color:var(--text-primary); width:min(560px, 94vw); margin:auto;";
  dialog.innerHTML = `
    <div style="padding:1.25rem 1.5rem;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem; border-bottom:1px solid var(--border); padding-bottom:0.75rem;">
        <h3 style="margin:0; font-size:1.05rem; font-weight:700;">${title}</h3>
        <button class="btn btn-ghost" id="spm-close" style="padding:0.25rem 0.5rem; font-size:1.1rem; line-height:1; cursor:pointer;">✕</button>
      </div>
      <div style="text-align:center; background:var(--bg-hover); border-radius:10px; overflow:hidden; border:1px solid var(--border); display:flex; align-items:center; justify-content:center; min-height:220px; max-height:65vh; padding:10px;">
        <img src="${dataUrl}" alt="Proof" onerror="this.onerror=null; this.parentElement.innerHTML='<div style=\\'padding:2.5rem; color:var(--text-muted); font-size:13px; text-align:center;\\'>⚠️ Screenshot proof could not be loaded</div>';" style="width:100%; height:auto; max-height:65vh; object-fit:contain; display:block; border-radius:8px;" />
      </div>
      <div style="display:flex; justify-content:flex-end; gap:0.5rem; margin-top:1rem;">
        <a class="btn btn-primary" download="payment-proof.jpg" href="${dataUrl}" style="text-decoration:none; padding:7px 16px; font-size:13px;">Download Proof</a>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);
  dialog.querySelector("#spm-close").onclick = () => dialog.close();
  dialog.addEventListener("close", () => dialog.remove());
  dialog.showModal();
};
import { listenToMyComplaints, submitComplaint } from "./complaintService.js";
import { listenToRenewalHistory } from "./renewalService.js";
import { listenToMySeatRequests } from "./seatRequestService.js";
import { getSettings } from "./settingsService.js";
import { collection, getDocs, query, where, addDoc, setDoc, deleteDoc, doc, getDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase/firebase.js";
import { STATE, resolvePortalState } from "./onboardingService.js";
import { renderOnboarding, showWizardLoading, paintWizardSidebar, restoreSidebar } from "./onboardingUI.js";

let currentStudent = null;
let currentAttendance = [];
let currentPayments = [];
let currentComplaints = [];
let currentRenewals = [];
let currentSeatRequests = [];
// True when this student's plan includes a fixed seat (seatPreference) AND a
// seat is assigned — the only case where "Change seat" is offered.
let canChangeSeat = false;
let unsubscribePortal = null;
let unsubscribeAttendance = null;
let unsubscribePayments = null;
let unsubscribeComplaints = null;
let unsubscribeRenewals = null;
let unsubscribeSeatRequests = null;

/** Plans are fetched once per page load; the wizard needs them to gate seats. */
let onboardingPlans = [];
const planForRecord = (s) =>
  s && s.planId ? onboardingPlans.find((p) => p.id === s.planId) || null : null;

/**
 * Checks whether a student's membership subscription is expired or overdue.
 */
export function isSubscriptionExpired(s) {
  if (!s) return false;
  if (s._isNewUser || s.approvalStatus === "Pending" || (s.status === "Pending" && !s.startDate)) {
    return false;
  }
  if (s.status === "Inactive" || s.status === "Expired" || s.status === "Old" || s.status === "Old Student") {
    return true;
  }
  const dueDateStr = s.paymentDueDate || s.endDate;
  if (!dueDateStr) return false;
  const due = new Date(dueDateStr);
  if (isNaN(due.getTime())) return false;
  due.setHours(23, 59, 59, 999);
  const now = new Date();
  return due < now;
}

export const initStudentPortalUI = () => {
  const portalSection = document.getElementById("page-student-portal");
  if (!portalSection) return;

  const role = localStorage.getItem("userRole");
  if (role !== "Student") return;

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  portalSection.classList.add('active');
  portalSection.innerHTML = `<div style="padding: 2rem; text-align: center;">Loading your portal...</div>`;
  document.getElementById("page-student-payments").innerHTML = "";
  document.getElementById("page-student-attendance").innerHTML = "";
  document.getElementById("page-student-complaints").innerHTML = "";
  // Boot cover stays up until the first portal snapshot decides wizard vs
  // dashboard — this is what stops the dashboard flashing for new students.
  window.__onboardingActive = true;
  window.__portalFirstRender = false;

  // Self-admission summary (new signups pick a plan inside THIS portal).
  // Element-guarded: the portal summary card only has plan + amount.
  window.updateSummary = () => {
    const set = (id, txt) => { const el = document.getElementById(id); if (el) el.innerText = txt; };
    const planEl = document.getElementById("adm-plan");
    const plans = window.availablePlansList || [];
    if (!planEl || !planEl.value) {
      set("summary-plan", "—"); set("summary-amount", "—");
      set("summary-start", "—"); set("summary-ends", "—");
      return;
    }
    const plan = plans.find(p => p.id === planEl.value);
    if (!plan) return;
    set("summary-plan", plan.planName || "—");
    set("summary-amount", plan.price != null ? `₹${plan.price}` : "—");
    const today = new Date();
    set("summary-start", today.toLocaleDateString("en-GB"));
    if (typeof plan.duration === "number") {
      const e = new Date(today);
      e.setDate(e.getDate() + plan.duration);
      set("summary-ends", e.toLocaleDateString("en-GB"));
    } else {
      set("summary-ends", "Custom");
    }
  };

    // Plans drive the seat-map gate (membershipPlans.seatPreference === true).
    import("./admissionService.js")
      .then(({ fetchPlansForDropdown }) => fetchPlansForDropdown(true))
      .then((p) => { onboardingPlans = p || []; })
      .catch((e) => console.warn("[portal] plans:", e));

  unsubscribePortal = listenToStudentPortalData(async (studentData) => {
    if (!studentData._documents || !studentData._documents.paymentScreenshot) {
      try {
        const docSnap = await getDoc(doc(db, "studentDocuments", studentData.id));
        if (docSnap.exists()) {
          studentData._documents = { ...(studentData._documents || {}), ...docSnap.data() };
        }
      } catch (_) {}
    }
    currentStudent = studentData;
    hydrateDismissedNotifs(studentData);

    // Listeners (each scoped to this student's own docs, so rules allow them).
    // Pass an error callback where supported so a denied read shows an empty
    // state instead of stalling the whole portal.
    const attendanceErr = (msg) => {
      console.warn("[portal] attendance listener:", msg);
      currentAttendance = [];
      renderPortal();
    };
    if (!unsubscribeAttendance) {
      try {
        unsubscribeAttendance = listenToMyAttendance(studentData.id, (records) => {
          currentAttendance = records;
          renderPortal();
        }, attendanceErr);
      } catch (e) { attendanceErr(e.message); }
    }

    if (!unsubscribePayments) {
      try {
        unsubscribePayments = listenToMyPayments(studentData.id, (records) => {
          currentPayments = records;
          renderPortal();
        });
      } catch (e) { console.warn("[portal] payments listener:", e); currentPayments = []; }
    }

    if (!unsubscribeComplaints) {
      try {
        unsubscribeComplaints = listenToMyComplaints(studentData.id, (records) => {
          currentComplaints = records;
          renderPortal();
        });
      } catch (e) { console.warn("[portal] complaints listener:", e); currentComplaints = []; }
    }

    if (!unsubscribeRenewals) {
      try {
        unsubscribeRenewals = listenToRenewalHistory(studentData.id, (records) => {
          currentRenewals = records;
          renderPortal();
        });
      } catch (e) { console.warn("[portal] renewals listener:", e); currentRenewals = []; }
    }

    if (!unsubscribeSeatRequests) {
      try {
        unsubscribeSeatRequests = listenToMySeatRequests(studentData.id, (records) => {
          currentSeatRequests = records;
          renderPortal();
        });
      } catch (e) { console.warn("[portal] seat requests listener:", e); currentSeatRequests = []; }
    }

    // Seat-change gate: fixed-seat plan + assigned seat. Checked live (not
    // cached) so a plan change by the desk reflects on next snapshot.
    try {
      const { planAllowsSeatSelection } = await import("./planValidation.js");
      canChangeSeat = !!(studentData.seatNumber && await planAllowsSeatSelection(studentData.planId));
    } catch (_) { canChangeSeat = false; }

    // Desk announcements for the notifications bell (student-safe renderer).
    subscribeStudentAnnouncements();

    renderPortal();
  }, (errorMsg) => {
    portalSection.innerHTML = `<div style="padding: 2rem; color: var(--danger); text-align: center;">${errorMsg}</div>`;
    try { const boot = document.getElementById("portal-boot"); if (boot) boot.style.display = "none"; } catch (_) {}
  });

  // Shared check-in executor — used by the seat-picker modal AND the direct
  // assigned-seat path. Manages the visible button and toasts.
  const runCheckIn = async (selectedSeatNumber, selectedSeatFloor = null) => {
    const modal = document.getElementById("checkin-seat-modal");
    const btn = (modal && modal.open)
      ? document.getElementById("btn-confirm-checkin")
      : document.getElementById("btn-checkin");
    const originalText = btn ? btn.innerHTML : "";
    if (btn) { btn.innerHTML = "Processing..."; btn.disabled = true; }

    try {
      const res = await checkIn(currentStudent, selectedSeatNumber, selectedSeatFloor);
      if (!res.success) {
        window.showToast("Check-In Failed: " + res.error, "error");
      } else if (res.warning) {
        window.showToast("Checked in! " + res.warning, "warning");
        if (modal && modal.open) modal.close();
      } else {
        window.showToast("Checked in successfully!", "success");
        if (modal && modal.open) modal.close();
      }
    } catch (e) {
      window.showToast("Check-In Failed: " + (e.message || e), "error");
    } finally {
      if (btn) { btn.innerHTML = originalText; btn.disabled = false; }
    }
  };

  window.handleCheckIn = async () => {
    if (!currentStudent) {
      window.showToast("Profile still loading. Please wait a moment and try again.", "warning");
      return;
    }
    if (currentStudent.status !== "Active" || isSubscriptionExpired(currentStudent)) {
      window.showToast("Access Blocked: Your subscription has expired. Please renew your plan to check in.", "error");
      if (typeof navigate === "function") navigate("student-payments");
      return;
    }
    // Fixed-seat (preferred) plans check straight in to the assigned seat —
    // the seat picker is only for non-preferred (open seating) plans, or a
    // fixed-seat student the desk has not seated yet.
    try {
      const { planAllowsSeatSelection } = await import("./planValidation.js");
      if (currentStudent.seatNumber && await planAllowsSeatSelection(currentStudent.planId)) {
        await runCheckIn(null);
        return;
      }
    } catch (_) { /* fall through to the seat picker */ }
    const modal = document.getElementById("checkin-seat-modal");
    if (!modal) {
      window.showToast("Check-in dialog not ready. Please refresh the page.", "error");
      return;
    }

    // Clear previous selection (scoped to the check-in modal)
    const scope = modal;
    const numInput = scope.querySelector("#selectedSeatNumber") || document.getElementById("selectedSeatNumber");
    const idInput = scope.querySelector("#selectedSeatId") || document.getElementById("selectedSeatId");
    if (numInput) numInput.value = "";
    if (idInput) idInput.value = "";

    // Show modal and initialize seat map
    if (!modal.open) modal.showModal();
    try {
      const { initSeatMapUI } = await import("./seatMapUI.js");
      await initSeatMapUI("signup", "checkin-seat-selection-section", { context: "checkin" });
    } catch (e) {
      console.warn("[portal] seat map failed:", e);
      window.showToast("Could not load seat map: " + (e.message || e), "error");
    }
  };

  window.confirmCheckIn = async () => {
    const modal = document.getElementById("checkin-seat-modal");
    const getVal = (id) => (modal && modal.querySelector("#" + id)?.value) || document.getElementById(id)?.value || "";
    const selectedSeatId = getVal("selectedSeatId");
    const selectedSeatNumber = getVal("selectedSeatNumber");
    const selectedSeatFloor = getVal("selectedSeatFloor") || window.selectedSeatFloor || null;

    if (!selectedSeatId || !selectedSeatNumber) {
      window.showToast("Please select a seat from the map to check in.", "warning");
      return;
    }
    if (!currentStudent) {
      window.showToast("Profile still loading. Please wait a moment and try again.", "warning");
      return;
    }

    await runCheckIn(selectedSeatNumber, selectedSeatFloor);
  };

  // Handle Check-out
  window.handleCheckOut = async (attendanceId) => {
    const btns = [document.getElementById("btn-checkout-top"), document.getElementById("btn-checkout"), document.getElementById("btn-checkin")].filter(Boolean);
    btns.forEach(b => { b.dataset._label = b.innerHTML; b.innerHTML = "Checking out..."; b.disabled = true; });

    try {
      const res = await checkOut(attendanceId);
      if (!res.success) {
        window.showToast("Check-Out Failed: " + res.error, "error");
        btns.forEach(b => { b.innerHTML = b.dataset._label || "Check-Out Now"; b.disabled = false; });
      } else if (res.warning) {
        window.showToast("Checked out! " + res.warning, "warning");
      } else {
        window.showToast("Checked out successfully!", "success");
        // Listener will refresh the UI — no hard reload needed.
      }
    } catch (e) {
      window.showToast("Check-Out Failed: " + e.message, "error");
      btns.forEach(b => { b.innerHTML = b.dataset._label || "Check-Out Now"; b.disabled = false; });
    }
  };

  // Generate PDF of my attendance (used by the Attendance page button)
  window.handleDownloadPDF = async () => {
    if (!currentStudent || !currentAttendance) return;
    const btn = document.getElementById("btn-pdf");
    const originalText = btn.innerHTML;
    btn.innerHTML = "Generating...";
    btn.disabled = true;

    const calculated = calculateStudyHours(currentAttendance);
    const res = await generateAttendancePDF(currentStudent.name, currentAttendance, calculated.totalHours);
    if (!res.success) window.showToast(window.t ? window.t('Failed to generate PDF: ') || "Failed to generate PDF: " : "Failed to generate PDF: " + res.error, "error");

    btn.innerHTML = originalText;
    btn.disabled = false;
  };

  // Cache for plan prices
let planPriceCache = {};

async function getPlanPrice(planName) {
  if (!planName) return 1000;
  
  // Check cache first
  if (planPriceCache[planName]) return planPriceCache[planName];
  
  try {
    const plansRef = collection(db, "membershipPlans");
    const q = query(plansRef, where("planName", "==", planName));
    const snapshot = await getDocs(q);
    
    if (!snapshot.empty) {
      const plan = snapshot.docs[0].data();
      const price = Number(plan.price) || 1000;
      planPriceCache[planName] = price;
      return price;
    }
  } catch (e) {
    console.warn("Failed to fetch plan price:", e);
  }
  
  // Fallback to hardcoded prices
  const planNameLower = (planName || '').toLowerCase();
  let fallbackPrice = 1000;
  if (planNameLower.includes("rotational")) fallbackPrice = 800;
  else if (planNameLower.includes("night")) fallbackPrice = 700;
  else if (planNameLower.includes("half") || planNameLower.includes("6 hour")) fallbackPrice = 700;
  
  planPriceCache[planName] = fallbackPrice;
  return fallbackPrice;
}

const addDaysToStr = (dateStr, days) => {
  if (!dateStr) return "";
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + Number(days));
  return d.toISOString().split("T")[0];
};

const fmtDispDate = (dateStr) => {
  if (!dateStr) return "—";
  const [y, m, d] = String(dateStr).split("T")[0].split("-").map(Number);
  if (!y || !m || !d) return dateStr;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d} ${MONTHS[m - 1]} ${y}`;
};

window.onStudentRenewalModeChange = () => {
  const modeSelect = document.getElementById("student-duration-mode");
  const valWrap = document.getElementById("student-duration-val-wrap");
  const valInput = document.getElementById("student-duration-val");
  const unitSpan = document.getElementById("student-duration-unit");
  const autoBadge = document.getElementById("student-auto-badge");
  if (!modeSelect) return;

  const mode = modeSelect.value;
  if (mode === "monthly") {
    if (valWrap) valWrap.style.display = "flex";
    if (valInput) valInput.value = valInput.value > 0 ? valInput.value : 1;
    if (unitSpan) unitSpan.textContent = "month";
    if (autoBadge) { autoBadge.textContent = "AUTO"; autoBadge.style.color = "#16a34a"; }
  } else if (mode === "days") {
    if (valWrap) valWrap.style.display = "flex";
    if (valInput) valInput.value = valInput.value > 1 ? valInput.value : 30;
    if (unitSpan) unitSpan.textContent = "days";
    if (autoBadge) { autoBadge.textContent = "AUTO"; autoBadge.style.color = "#16a34a"; }
  } else if (mode === "custom") {
    if (valWrap) valWrap.style.display = "none";
    if (autoBadge) { autoBadge.textContent = "CUSTOM"; autoBadge.style.color = "#3b82f6"; }
  }
  window.calculatePaymentAmount();
};

window.triggerStudentDatePicker = (inputId) => {
  const el = document.getElementById(inputId);
  if (!el) return;
  if (inputId === "student-end-date") {
    const modeSelect = document.getElementById("student-duration-mode");
    if (modeSelect && modeSelect.value !== "custom") {
      modeSelect.value = "custom";
      window.onStudentRenewalModeChange();
    }
  }
  if (typeof el.showPicker === "function") {
    try { el.showPicker(); return; } catch (_) {}
  }
  el.focus();
  el.click();
};

window.calculatePaymentAmount = async () => {
  if (!currentStudent) return;
  const startEl = document.getElementById("student-start-date");
  const endEl = document.getElementById("student-end-date");
  const startDisp = document.getElementById("student-start-disp");
  const endDisp = document.getElementById("student-end-disp");
  const modeSelect = document.getElementById("student-duration-mode");
  const valInput = document.getElementById("student-duration-val");
  const amountDisplay = document.getElementById("payment-amount-display");
  const amountInput = document.getElementById("payment-amount");

  const basePrice = await getPlanPrice(currentStudent.planName);
  const mode = modeSelect?.value || "monthly";

  let startVal = startEl?.value;
  if (!startVal) {
    const today = new Date();
    let defStart = today;
    if (currentStudent.paymentDueDate) {
      const parsed = new Date(`${currentStudent.paymentDueDate}T00:00:00`);
      if (!isNaN(parsed.getTime())) {
        parsed.setDate(parsed.getDate() + 1);
        if (parsed >= today) defStart = parsed;
      }
    }
    startVal = defStart.toISOString().split("T")[0];
    if (startEl) startEl.value = startVal;
  }

  let total = basePrice;
  let durationDays = 30;

  if (mode === "monthly") {
    const months = Math.max(1, Number(valInput?.value || 1));
    durationDays = months * 30;
    const endStr = addDaysToStr(startVal, durationDays - 1);
    if (endEl) endEl.value = endStr;
    total = basePrice * months;
  } else if (mode === "days") {
    const days = Math.max(1, Number(valInput?.value || 30));
    durationDays = days;
    const endStr = addDaysToStr(startVal, days - 1);
    if (endEl) endEl.value = endStr;
    total = Math.round((basePrice / 30) * days);
  } else if (mode === "custom") {
    let endVal = endEl?.value;
    if (!endVal || endVal < startVal) {
      endVal = addDaysToStr(startVal, 29);
      if (endEl) endEl.value = endVal;
    }
    const d1 = new Date(`${startVal}T00:00:00`);
    const d2 = new Date(`${endVal}T00:00:00`);
    durationDays = Math.max(1, Math.round((d2 - d1) / (1000 * 60 * 60 * 24)) + 1);
    total = Math.round((basePrice / 30) * durationDays);
  }

  if (amountDisplay) amountDisplay.innerText = `₹${total}`;
  if (amountInput) amountInput.value = total;
  if (startDisp && startEl) startDisp.innerText = fmtDispDate(startEl.value);
  if (endDisp && endEl) endDisp.innerText = fmtDispDate(endEl.value);
};

window.onPaymentMethodChange = (method) => {
  const isCash = method === "Cash";
  const upiLabel = document.getElementById("sp-paymethod-upi-label");
  const cashLabel = document.getElementById("sp-paymethod-cash-label");
  const upiGroup = document.getElementById("sp-upi-group");
  const cashGroup = document.getElementById("sp-cash-group");
  const qrBoxUpi = document.getElementById("sp-qr-upi-view");
  const qrBoxCash = document.getElementById("sp-qr-cash-view");
  const submitBtn = document.getElementById("btn-submit-payment");

  if (upiLabel) {
    upiLabel.style.borderColor = isCash ? "var(--border-bright)" : "var(--primary)";
    upiLabel.style.background = isCash ? "var(--bg-hover)" : "rgba(14,165,233,0.08)";
  }
  if (cashLabel) {
    cashLabel.style.borderColor = isCash ? "var(--accent-emerald, #10b981)" : "var(--border-bright)";
    cashLabel.style.background = isCash ? "rgba(16,185,129,0.08)" : "var(--bg-hover)";
  }

  if (upiGroup) upiGroup.style.display = isCash ? "none" : "flex";
  if (cashGroup) cashGroup.style.display = isCash ? "block" : "none";
  if (qrBoxUpi) qrBoxUpi.style.display = isCash ? "none" : "flex";
  if (qrBoxCash) qrBoxCash.style.display = isCash ? "flex" : "none";

  const txnInput = document.getElementById("payment-txnid");
  const ssInput = document.getElementById("payment-ss");
  if (txnInput) txnInput.required = !isCash;
  if (ssInput) ssInput.required = !isCash;

  if (submitBtn) {
    submitBtn.innerHTML = isCash
      ? `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:8px;"><rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/></svg> Submit Cash Renewal Request`
      : `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:8px;"><path d="M23 4v6h-6"></path><path d="M1 20v-6h6"></path><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg> Submit Renewal Request`;
  }
};

window.handlePaymentSubmit = async () => {
  const btn = document.getElementById("btn-submit-payment");
  const isCash = document.getElementById("sp-paymethod-cash")?.checked === true;
  const txnId = isCash ? "CASH" : (document.getElementById("payment-txnid")?.value || "").trim();

  if (!isCash && !txnId) {
    return window.showToast(window.t ? window.t('Please enter the Transaction ID.') || "Please enter the Transaction ID." : "Please enter the Transaction ID.", "error");
  }

  const modeSelect = document.getElementById("student-duration-mode");
  const valInput = document.getElementById("student-duration-val");
  const startEl = document.getElementById("student-start-date");
  const endEl = document.getElementById("student-end-date");
  const amount = document.getElementById("payment-amount").value;

  const startDate = startEl?.value;
  const endDate = endEl?.value;
  const mode = modeSelect?.value || "monthly";
  const renewalMonths = mode === "monthly" ? Number(valInput?.value || 1) : 1;

  const d1 = new Date(`${startDate}T00:00:00`);
  const d2 = new Date(`${endDate}T00:00:00`);
  const durationDays = Math.max(1, Math.round((d2 - d1) / (1000 * 60 * 60 * 24)) + 1);

  btn.innerHTML = "Submitting...";
  btn.disabled = true;

  // Single mandatory payment screenshot proof (for UPI only)
  let screenshot = "";
  if (!isCash) {
    try {
      screenshot = await collectPaymentScreenshot();
    } catch (e) {
      btn.innerHTML = "Submit Renewal Request";
      btn.disabled = false;
      return window.showToast(e.message || "Payment screenshot proof is required.", "error");
    }
    if (!screenshot) {
      btn.innerHTML = "Submit Renewal Request";
      btn.disabled = false;
      return window.showToast("Payment screenshot proof is required.", "error");
    }
  }

  const res = await submitPaymentRequest(
    currentStudent,
    txnId,
    renewalMonths,
    amount,
    null,
    screenshot,
    { startDate, endDate, durationDays, durationMode: mode },
    isCash ? "Cash" : "UPI"
  );
  if (res.success) {
    window.showToast(
      isCash
        ? "Cash Renewal Request Submitted! Please settle payment at the front desk."
        : "Renewal Request Submitted! The admin will verify payment in their bank account and approve your access.",
      "success"
    );
    const txnInput = document.getElementById("payment-txnid");
    if (txnInput) txnInput.value = "";
    const ssInput = document.getElementById("payment-ss");
    if (ssInput) ssInput.value = "";

    // Instantly add to local array so the pending approval card displays immediately
    if (Array.isArray(currentPayments)) {
      currentPayments.unshift({
        id: "pending-" + Date.now(),
        studentId: currentStudent?.id,
        studentName: currentStudent?.name,
        amount: Number(amount),
        paymentMethod: isCash ? "Cash" : "UPI",
        transactionId: txnId,
        screenshot: screenshot,
        paymentScreenshotUrl: screenshot,
        source: "renewal",
        status: "pending",
        startDate,
        endDate,
        durationDays,
        renewalMonths,
        date: new Date().toISOString()
      });
      renderPortal();
    }
  } else {
    window.showToast("Failed: " + res.error, "error");
  }

  btn.innerHTML = isCash
    ? `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:8px;"><rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/></svg> Submit Cash Renewal Request`
    : `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:8px;"><path d="M23 4v6h-6"></path><path d="M1 20v-6h6"></path><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg> Submit Renewal Request`;
  btn.disabled = false;
};

  window.handleComplaintSubmit = async () => {
    if (isSubscriptionExpired(currentStudent)) {
      window.showToast("Access Blocked: Your subscription has expired. Please renew first.", "error");
      if (typeof navigate === "function") navigate("student-payments");
      return;
    }
    const btn = document.getElementById("btn-submit-complaint");
    const category = document.getElementById("complaint-category").value;
    const description = document.getElementById("complaint-description").value;

    btn.innerHTML = "Submitting...";
    btn.disabled = true;

    const res = await submitComplaint(currentStudent, category, description);
    if (res.success) {
      window.showToast(window.t ? window.t('Complaint Submitted Successfully!') || "Complaint Submitted Successfully!" : "Complaint Submitted Successfully!", "success");
      document.getElementById("complaint-category").value = "";
      document.getElementById("complaint-description").value = "";
    } else {
      window.showToast((window.t ? (window.t('Failed: ') || "Failed: ") : "Failed: ") + (res.error || ""), "error");
    }

    btn.innerHTML = "Submit Complaint";
    btn.disabled = false;
  };

  // ── Seat change (fixed-seat plans only) ──────────────────────────────
  // Uses the ORIGINAL room-layout seat map (same picker as check-in):
  // floor tabs, DOOR/TOILET room, green = Available. The student picks a
  // free seat and files a request; staff approves from the admin Seats
  // page. Statuses + cancel live on the "My Seat" dashboard card below.
  window.openSeatChangeModal = async () => {
    if (!currentStudent) { window.showToast("Profile still loading.", "warning"); return; }
    if (isSubscriptionExpired(currentStudent)) {
      window.showToast("Access Blocked: Your subscription has expired. Please renew first.", "error");
      if (typeof navigate === "function") navigate("student-payments");
      return;
    }
    if (!canChangeSeat) { window.showToast("Your plan does not include a fixed seat.", "warning"); return; }
    let modal = document.getElementById("seat-change-modal");
    if (!modal) {
      modal = document.createElement("dialog");
      modal.id = "seat-change-modal";
      modal.className = "card";
      modal.style.cssText = "border:none; border-radius:12px; padding:0; box-shadow:0 10px 30px rgba(0,0,0,0.5); background:var(--bg-card); color:var(--text-primary); width:min(860px, calc(100vw - 24px)); max-width:860px; margin:auto;";
      modal.innerHTML = `
        <div style="padding:1.1rem 1.5rem; border-bottom:1px solid var(--borderBright); display:flex; justify-content:space-between; align-items:center;">
          <div><h2 style="font-size:1.05rem; font-weight:600; margin:0;">Change your seat</h2>
          <div style="font-size:12px; color:var(--text-muted); margin-top:2px;">Tap any green (Available) seat — the desk approves your pick.</div></div>
          <button onclick="document.getElementById('seat-change-modal').close()" style="background:none; border:none; font-size:1.4rem; cursor:pointer; color:var(--text-muted);">&times;</button>
        </div>
        <div style="padding:1.25rem 1.5rem;">
          <div id="seat-change-selection-section" style="border:1px solid var(--border-bright); border-radius:12px; padding:1rem;"></div>
          <input type="hidden" id="selectedSeatNumber" />
          <input type="hidden" id="selectedSeatFloor" />
          <input type="hidden" id="selectedSeatId" />
          <div id="signup-selected-label" style="margin-top:0.6rem; font-size:13px; color:var(--text-secondary); min-height:20px;"></div>
          <div class="form-group" style="margin-top:0.75rem;">
            <label style="font-size:12px; color:var(--text-muted);">Reason (optional)</label>
            <input type="text" id="seat-change-reason" class="input-field" placeholder="e.g. nearer the window" maxlength="300" style="width:100%; box-sizing:border-box;" />
          </div>
          <div style="display:flex; justify-content:flex-end; gap:0.5rem; margin-top:1rem;">
            <button class="btn btn-ghost" onclick="document.getElementById('seat-change-modal').close()">Cancel</button>
            <button class="btn btn-primary" id="btn-send-seat-change" onclick="window.sendSeatChange()">Send request</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
    }
    // Clear previous selection (scoped to this modal — same ids as check-in,
    // but _signupSelectSeat writes into the OPEN dialog).
    modal.querySelector("#selectedSeatNumber").value = "";
    modal.querySelector("#selectedSeatId").value = "";
    modal.querySelector("#signup-selected-label").innerHTML = "";
    const reasonEl = modal.querySelector("#seat-change-reason");
    if (reasonEl) reasonEl.value = "";
    if (!modal.open) modal.showModal();
    try {
      const { initSeatMapUI } = await import("./seatMapUI.js");
      // No checkin context: ONLY green (Available) seats are tappable.
      await initSeatMapUI("signup", "seat-change-selection-section");
    } catch (e) {
      console.warn("[portal] seat map failed:", e);
      window.showToast("Could not load seat map: " + (e.message || e), "error");
    }
  };

  window.sendSeatChange = async () => {
    const modal = document.getElementById("seat-change-modal");
    const getVal = (id) => (modal && modal.querySelector("#" + id)?.value) || "";
    const pickedId = getVal("selectedSeatId");
    const pickedNum = getVal("selectedSeatNumber");
    if (!pickedId || !pickedNum) { window.showToast("Pick a free seat from the map first.", "warning"); return; }
    const btn = document.getElementById("btn-send-seat-change");
    const reason = (modal && modal.querySelector("#seat-change-reason")?.value) || "";
    if (btn) { btn.disabled = true; btn.innerText = "Sending..."; }
    try {
      // Floor comes from the picked seat doc itself (duplicate plain numbers
      // exist on both floors, so the number alone is ambiguous).
      const { doc: fsDoc, getDoc: fsGet } = await import("firebase/firestore");
      const seatSnap = await fsGet(fsDoc(db, "seats", pickedId));
      if (!seatSnap.exists()) throw new Error("That seat is gone. Pick another.");
      const seatData = seatSnap.data() || {};
      const { submitSeatChangeRequest } = await import("./seatRequestService.js");
      const res = await submitSeatChangeRequest(currentStudent, {
        toSeatNumber: seatData.seatNumber,
        toSeatFloor: seatData.floor || "Ground Floor",
        reason,
      });
      if (res.success) {
        window.showToast("Seat-change request sent. The desk will approve it.", "success");
        modal.close();
      } else {
        window.showToast("Failed: " + res.error, "error");
      }
    } catch (e) {
      window.showToast("Failed: " + (e.message || e), "error");
    } finally {
      if (btn) { btn.disabled = false; btn.innerText = "Send request"; }
    }
  };

  window.cancelSeatChange = async (id) => {
    try {
      const { cancelSeatRequest } = await import("./seatRequestService.js");
      const res = await cancelSeatRequest(id, currentStudent && currentStudent.id);
      if (!res.success) window.showToast("Failed: " + res.error, "error");
    } catch (e) {
      window.showToast("Failed: " + (e.message || e), "error");
    }
  };
};

/**
 * Makes the student shell real: sidebar/topbar show THIS student's name and
 * photo, and the admin global-search box is hidden (students have no
 * global search — their tables are on their own pages).
 * The notification badge + bell + tab title are owned entirely by
 * renderStudentNotifications below (single writer, like the admin bell).
 */
const syncStudentChrome = (s, photoUrl, notifCount) => {
  try {
    const name = s.name || "Student";
    const initials = name.substring(0, 2).toUpperCase();
    const avatarInner = photoUrl
      ? `<img src="${photoUrl}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;border-radius:50%;" />`
      : initials;

    const setAvatar = (el) => {
      if (!el) return;
      el.innerHTML = avatarInner;
      if (photoUrl) { el.style.overflow = "hidden"; el.style.padding = "0"; }
    };
    setAvatar(document.getElementById("current-user-avatar"));
    setAvatar(document.getElementById("topbar-user-avatar"));

    const nameEl = document.getElementById("current-user-name");
    const topbarNameEl = document.getElementById("topbar-user-name");
    if (nameEl) nameEl.textContent = name;
    if (topbarNameEl) topbarNameEl.textContent = name;

    const search = document.querySelector(".topbar-search");
    if (search) search.style.display = "none";
  } catch (e) { console.warn("[portal] chrome sync failed:", e); }
};

// WhatsApp-style student alerts: bell pill, tab badge, beep + toast.
// Fix for "old notification pops on every refresh": listeners fire in batches
// (attendance, then payments, then announcements), so the 2nd/3rd render used
// to mistake late-arriving OLD items for fresh ones. Now we (a) persist seen
// ids across refreshes, (b) ignore the first 6s of batched loads, and (c) only
// ever consider UNREAD ids as candidates for "new".
const S_BASE_TITLE = (typeof document !== "undefined" && document.title) || "Studyhaus";
let __sNotifFirst = true;
let __sKnownIds = new Set();
let __sBootAt = Date.now();
const sSeenKey = () => `seenNotifs_${(typeof localStorage !== "undefined" && localStorage.getItem("userId")) || "anon"}`;
const sLoadSeen = () => {
  try {
    const raw = localStorage.getItem(sSeenKey()) || "[]";
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch (_) { return new Set(); }
};
const sSaveSeen = (set) => {
  try { localStorage.setItem(sSeenKey(), JSON.stringify([...set].slice(-300))); } catch (_) {}
};

const sBeep = () => {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [0, 0.18].forEach((delay, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = i === 0 ? 880 : 660;
      osc.type = "sine";
      const t = ctx.currentTime + delay;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      osc.start(t);
      osc.stop(t + 0.16);
    });
    setTimeout(() => ctx.close().catch(() => {}), 600);
  } catch (_) {}
};

const sPaintBell = (unread) => {
  const dot = document.getElementById("topbar-notif-dot");
  if (!dot) return;
  const mobDot = document.getElementById("mob-notif-dot");
  if (unread > 0) {
    dot.style.display = "flex";
    dot.style.width = "auto";
    dot.style.height = "16px";
    dot.style.minWidth = "16px";
    dot.style.padding = "0 4px";
    dot.style.alignItems = "center";
    dot.style.justifyContent = "center";
    dot.style.top = "0px";
    dot.style.right = "0px";
    dot.style.fontSize = "10px";
    dot.style.fontWeight = "700";
    dot.style.color = "#fff";
    dot.style.backgroundColor = "#ef4444";
    dot.style.borderRadius = "999px";
    dot.textContent = unread > 9 ? "9+" : String(unread);
    if (mobDot) mobDot.style.display = "block";
  } else {
    dot.style.display = "none";
    dot.textContent = "";
    if (mobDot) mobDot.style.display = "none";
  }
};

const sPaintTab = (unread) => {
  try {
    document.title = unread > 0 ? `(${unread > 9 ? "9+" : unread}) ${S_BASE_TITLE}` : S_BASE_TITLE;
  } catch (_) {}
};

// Announcements broadcast by staff (read-only for students — no delete).
let studentAnnouncements = [];
let unsubscribeAnnouncements = null;
let showReadStudent = false;

const subscribeStudentAnnouncements = () => {
  if (unsubscribeAnnouncements) return;
  import("./announcementService.js").then(({ listenToAnnouncements }) => {
    try {
      unsubscribeAnnouncements = listenToAnnouncements((items) => {
        studentAnnouncements = Array.isArray(items) ? items : [];
        renderStudentNotifications();
      });
    } catch (e) { console.warn("[portal] announcements listener failed:", e); }
  }).catch(e => console.warn("[portal] announcements module failed:", e));

  // Re-check once a minute so announcements whose scheduled time arrives
  // while the portal is open pop in without a refresh.
  if (!window.__studentAnnTimer) {
    window.__studentAnnTimer = setInterval(() => {
      try { renderStudentNotifications(); } catch (_) {}
    }, 60000);
  }
};

// Dismissed notifications must survive logout/login and device changes: ids
// live in localStorage for instant effect AND on the student's own doc
// (students/{id}.dismissedNotifs — rules clause (b) allows self-writes), so
// the next login re-hides them before the first render.
const hydrateDismissedNotifs = (student) => {
  try {
    const ids = Array.isArray(student && student.dismissedNotifs) ? student.dismissedNotifs.map(String) : [];
    if (!ids.length) return;
    const key = `readNotifs_${localStorage.getItem("userId") || "anon"}`;
    const cur = new Set(JSON.parse(localStorage.getItem(key) || "[]").map(String));
    let changed = false;
    ids.forEach((id) => { if (!cur.has(id)) { cur.add(id); changed = true; } });
    if (changed) localStorage.setItem(key, JSON.stringify([...cur].slice(-300)));
  } catch (_) {}
};

const persistDismissedNotif = async (id) => {
  if (!currentStudent || !currentStudent.id || id == null) return;
  try {
    const sid = String(id);
    const prev = Array.isArray(currentStudent.dismissedNotifs) ? currentStudent.dismissedNotifs.map(String) : [];
    if (prev.includes(sid)) return;
    const next = prev.length >= 280 ? [...prev.slice(-279), sid] : [...prev, sid];
    const { doc: fsDoc, updateDoc: fsUpdate, serverTimestamp } = await import("firebase/firestore");
    await fsUpdate(fsDoc(db, "students", currentStudent.id), {
      dismissedNotifs: next,
      updatedAt: serverTimestamp()
    });
    currentStudent.dismissedNotifs = next;
  } catch (_) { /* localStorage copy still hides it on this device */ }
};

// One delegated click handler: clicking a notification marks it read so it
// stays gone (persisted per student). Action buttons navigate instead.
const wireStudentNotifDismiss = () => {
  const list = document.querySelector("#page-notifications .notif-list");
  if (!list || list.dataset.wired) return;
  list.dataset.wired = "1";
  list.addEventListener("click", async (e) => {
    const btn = e.target.closest("button, a");
    const item = e.target.closest("[data-notif-id]");
    if (!item) return;
    const { markNotifRead } = await import("./notificationReadState.js");
    markNotifRead(item.dataset.notifId);
    persistDismissedNotif(item.dataset.notifId);
    if (!btn) renderStudentNotifications();
    // With a button: let its own onclick (navigate/checkout) run, then refresh.
    else setTimeout(() => { try { renderStudentNotifications(); } catch (_) {} }, 300);
  });
};

const escNotif = (v) => String(v == null ? "" : v)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const notifIconFor = (type) => {
  if (type === "warning") return { cls: "red", svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>` };
  if (type === "success") return { cls: "emerald", svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>` };
  return { cls: "amber", svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>` };
};

/**
 * What "Notifications" means for a student: admin announcements addressed to
 * them, plus personal alerts generated from their own live data (due fees,
 * pending payments, complaint replies, active check-in). Rendered into the
 * student's own #page-notifications list — the admin renderer never runs
 * here, so without this the page stays empty.
 */
const renderStudentNotifications = () => {
  const list = document.querySelector("#page-notifications .notif-list");
  if (!list || !currentStudent) return;
  wireStudentNotifDismiss();
  const s = currentStudent;

  const { monthsOwed, nextMonthLabel } = computeUnpaidMonths(s.paymentDueDate);
  const pendings = (Array.isArray(currentPayments) ? currentPayments : []).filter(p => p.status === "pending");
  const opens = (Array.isArray(currentComplaints) ? currentComplaints : []).filter(c => c.status === "Pending" || c.status === "In Progress");
  const replied = opens.filter(c => c.resolutionNote);
  const active = (Array.isArray(currentAttendance) ? currentAttendance : []).find(r => r.status === "Active");

  const isRead = (id) => {
    try {
      const raw = localStorage.getItem(`readNotifs_${localStorage.getItem("userId") || "anon"}`) || "[]";
      return JSON.parse(raw).includes(String(id));
    } catch (_) { return false; }
  };

  let personal = "";
  if (monthsOwed > 0) {
    personal += `<div class="notif-item unread" data-notif-id="due" title="Click to dismiss">
      <div class="notif-icon red">${notifIconFor("warning").svg}</div>
      <div class="notif-content"><div class="notif-title">Fees overdue — ${monthsOwed} month${monthsOwed > 1 ? "s" : ""} pending</div>
      <div class="notif-body">Clear ${escNotif(nextMonthLabel)} first, one month at a time.</div>
      <div class="sp-notif-actions"><button class="btn btn-primary btn-sm" onclick="navigate('student-payments')">Pay now</button></div></div></div>`;
  }
  pendings.slice(0, 3).forEach(p => {
    personal += `<div class="notif-item unread" data-notif-id="pay_${p.id}" title="Click to dismiss">
      <div class="notif-icon amber">${notifIconFor("info").svg}</div>
      <div class="notif-content"><div class="notif-title">Payment ₹${Number(p.amount) || 0} awaiting approval</div>
      <div class="notif-body">Txn ${escNotif(p.transactionId || "—")} · submitted ${p.date ? new Date(p.date).toLocaleDateString() : "recently"}. The desk will approve it shortly.</div></div></div>`;
  });
  replied.forEach(c => {
    personal += `<div class="notif-item unread" data-notif-id="creply_${c.id}" title="Click to dismiss">
      <div class="notif-icon emerald">${notifIconFor("success").svg}</div>
      <div class="notif-content"><div class="notif-title">Update on your complaint: ${escNotif(c.category || "General")}</div>
      <div class="notif-body">Admin: ${escNotif(c.resolutionNote)}</div>
      <div class="sp-notif-actions"><button class="btn btn-ghost btn-sm" onclick="navigate('student-complaints')">View</button></div></div></div>`;
  });
  (opens.filter(c => !c.resolutionNote).slice(0, 2)).forEach(c => {
    personal += `<div class="notif-item" data-notif-id="copen_${c.id}" title="Click to dismiss">
      <div class="notif-icon blue">${notifIconFor("info").svg}</div>
      <div class="notif-content"><div class="notif-title">Complaint in queue: ${escNotif(c.category || "General")}</div>
      <div class="notif-body">Status: ${escNotif(c.status)}. We will notify you here when it is resolved.</div></div></div>`;
  });
  if (active) {
    personal += `<div class="notif-item" data-notif-id="active_${active.id}" title="Click to dismiss">
      <div class="notif-icon emerald">${notifIconFor("success").svg}</div>
      <div class="notif-content"><div class="notif-title">You are checked in — Seat ${escNotif(active.seatNumber || "—")}</div>
      <div class="notif-body">Since ${active.checkIn ? new Date(active.checkIn).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "today"}. Don't forget to check out when you leave.</div></div></div>`;
  }

  // Only announcements whose schedule has arrived and are within 1 day (24h) of being announced.
  const annLive = (a) => {
    if (!a) return false;
    const now = Date.now();
    let annTime = null;
    if (a.scheduledFor) {
      const t = new Date(a.scheduledFor).getTime();
      if (!Number.isNaN(t)) annTime = t;
    }
    if (!annTime && a.createdAt?.seconds) annTime = a.createdAt.seconds * 1000;
    if (annTime && (now - annTime) >= 24 * 60 * 60 * 1000) return false; // auto gone after 1 day
    if (!a.scheduledFor) return true;
    const t = new Date(a.scheduledFor).getTime();
    return Number.isNaN(t) || t <= now;
  };
  const visible = studentAnnouncements.filter(a => {
    if (!annLive(a)) return false;
    const aud = a.audience || "All Students";
    if (aud === "Staff") return false;
    if (aud === "Specific Students") return Array.isArray(a.targetStudentIds) && a.targetStudentIds.includes(s.id);
    if (aud === "Active Students Only") return s.status === "Active";
    return true;
  });

  let broadcast = "";
  visible.slice(0, 20).forEach(a => {
    const ic = notifIconFor(a.type);
    const when = (a.createdAt && a.createdAt.seconds)
      ? new Date(a.createdAt.seconds * 1000).toLocaleString() : "Just now";
    broadcast += `<div class="notif-item" data-notif-id="ann_${a.id}" title="Click to dismiss">
      <div class="notif-icon ${ic.cls}">${ic.svg}</div>
      <div class="notif-content"><div class="notif-title">${escNotif(a.title || "Announcement")}</div>
      <div class="notif-body">${escNotif(a.message || "")}</div>
      <div class="notif-time">${escNotif(when)}${a.createdBy ? ` · ${escNotif(a.createdBy)}` : ""}</div></div></div>`;
  });

  // Hide anything already dismissed; offer to show it back.
  personal = personal.replace(/<div class="notif-item([^"]*)" data-notif-id="([^"]+)"/g,
    (m, cls, id) => (isRead(id) && !showReadStudent) ? `<div class="notif-item${cls} noshow" data-notif-id="${id}" style="display:none;"` : m);
  broadcast = broadcast.replace(/<div class="notif-item" data-notif-id="([^"]+)"/g,
    (m, id) => (isRead(id) && !showReadStudent) ? `<div class="notif-item" data-notif-id="${id}" style="display:none;"` : m);

  const dismissedCount = (() => {
    const ids = [];
    if (monthsOwed > 0) ids.push("due");
    pendings.slice(0, 3).forEach(p => ids.push(`pay_${p.id}`));
    replied.forEach(c => ids.push(`creply_${c.id}`));
    opens.filter(c => !c.resolutionNote).slice(0, 2).forEach(c => ids.push(`copen_${c.id}`));
    if (active) ids.push(`active_${active.id}`);
    visible.slice(0, 20).forEach(a => ids.push(`ann_${a.id}`));
    return ids.filter(isRead).length;
  })();

  // Badge counts unread personal items + unread desk announcements.
  const unreadPersonal = (monthsOwed > 0 && !isRead("due") ? 1 : 0)
    + pendings.filter(p => !isRead(`pay_${p.id}`)).length
    + opens.filter(c => !isRead(c.resolutionNote ? `creply_${c.id}` : `copen_${c.id}`)).length;
  const unreadBroadcast = visible.filter(a => !isRead(`ann_${a.id}`)).length;
  const totalUnread = unreadPersonal + unreadBroadcast;
  const badge = document.querySelector('.nav-item[data-page="notifications"] .nav-badge');
  if (badge) {
    if (totalUnread > 0) { badge.textContent = totalUnread > 9 ? "9+" : String(totalUnread); badge.style.display = ""; }
    else { badge.textContent = "0"; badge.style.display = "none"; }
  }
  // WhatsApp-style: count pill on the bell, (n) on the browser tab,
  // beep + toast ONLY for genuinely new UNREAD items arriving after boot.
  sPaintBell(totalUnread);
  sPaintTab(totalUnread);
  // Only unread ids can ever count as "new" — dismissed items stay silent even
  // if a listener re-delivers them.
  const currentIds = [];
  if (monthsOwed > 0 && !isRead("due")) currentIds.push("due");
  pendings.forEach(p => { if (!isRead(`pay_${p.id}`)) currentIds.push(`pay_${p.id}`); });
  opens.forEach(c => {
    const oid = c.resolutionNote ? `creply_${c.id}` : `copen_${c.id}`;
    if (!isRead(oid)) currentIds.push(oid);
  });
  visible.forEach(a => { if (!isRead(`ann_${a.id}`)) currentIds.push(`ann_${a.id}`); });
  const persistedSeen = sLoadSeen();
  const bootGrace = (Date.now() - __sBootAt) < 6000;
  if (!__sNotifFirst && !bootGrace) {
    const fresh = currentIds.filter((id) => !__sKnownIds.has(id) && !persistedSeen.has(id));
    if (fresh.length > 0) {
      sBeep();
      if (typeof window.showToast === "function") {
        window.showToast(`You have ${fresh.length} new notification${fresh.length > 1 ? "s" : ""} — tap the bell.`, "info");
      }
    }
  }
  __sNotifFirst = false;
  __sKnownIds = new Set(currentIds);
  // Baseline: everything currently on screen counts as seen, so a refresh
  // tomorrow never re-announces today's items. Capped at 300 ids.
  try {
    const merged = sLoadSeen();
    currentIds.forEach((id) => merged.add(String(id)));
    sSaveSeen(merged);
  } catch (_) {}

  const toggle = dismissedCount > 0
    ? `<div style="text-align:center; padding:0.5rem;"><button class="btn btn-ghost btn-sm" onclick="window.toggleStudentReadNotifs()">${showReadStudent ? "Hide read" : `Show dismissed (${dismissedCount})`}</button></div>`
    : "";

  if (!personal && !broadcast) {
    list.innerHTML = `<div style="text-align:center; padding:2.5rem 1rem; color:var(--text-muted);">
      <div style="width:44px;height:44px;border-radius:12px;background:var(--bg-hover);display:flex;align-items:center;justify-content:center;margin:0 auto 0.75rem;color:var(--text-muted);"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="22" height="22"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg></div>
      <div style="font-weight:600; color:var(--text-primary); margin-bottom:0.25rem;">All caught up</div>
      <div style="font-size:0.85rem;">Fee reminders, payment updates and desk announcements will appear here.</div></div>`;
    return;
  }
  list.innerHTML =
    (personal ? `<div class="sp-notif-section">Needs your attention</div>${personal}` : "") +
    (broadcast ? `<div class="sp-notif-section">Announcements from the desk</div>${broadcast}` : "") +
    toggle;
};

window.toggleStudentReadNotifs = () => {
  showReadStudent = !showReadStudent;
  try { renderStudentNotifications(); } catch (_) {}
};

// Student's own documents — SAME backend as the admin view:
// studentDocuments/{uid} (aadhaarFront, aadhaarBack, photo — one photo only).
// Admin uploads appear here and student uploads appear in the admin panel:
// one record, no duplicates, no second source.
let docsLoadedFor = null;

const loadOwnDocuments = () => {
  const el = document.getElementById("student-own-documents");
  if (!el || !currentStudent || currentStudent._isNewUser || currentStudent._isPendingAdmission) return;
  if (docsLoadedFor === currentStudent.id && el.dataset.loaded) return;
  docsLoadedFor = currentStudent.id;
  import("./documentUploadService.js").then(({ renderStudentDocuments }) => {
    el.dataset.loaded = "1";
    return renderStudentDocuments(currentStudent.id, "student-own-documents");
  }).catch(e => {
    console.warn("[portal] own documents failed:", e);
    el.innerHTML = `<div style="text-align:center; padding:1.5rem; color:var(--text-muted);">Could not load documents. Try Refresh.</div>`;
  });
};

window.refreshOwnDocuments = () => {
  const el = document.getElementById("student-own-documents");
  if (el) delete el.dataset.loaded;
  docsLoadedFor = null;
  loadOwnDocuments();
};

/**
 * "My Seat" dashboard card: current fixed seat + change button + request
 * history (Pending with Cancel, Approved/Rejected as record). Rendered only
 * for fixed-seat plans; others see nothing seat-related here.
 */
const seatRequestsCardHtml = (s) => {
  const esc = (v) => String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const list = Array.isArray(currentSeatRequests) ? currentSeatRequests : [];
  const pending = list.filter((r) => r.status === "Pending");
  const rows = list.slice(0, 5).map((r) => {
    const badge = r.status === "Approved" ? "badge-paid" : r.status === "Rejected" ? "badge-absent" : "badge-pending";
    const cancel = r.status === "Pending"
      ? ` <a href="#" onclick="window.cancelSeatChange('${r.id}'); return false;" style="color:var(--danger); font-size:11px;">Cancel</a>` : "";
    const decided = r.status !== "Pending" && r.decidedAt
      ? ` <span style="color:var(--text-muted); font-size:11px;">· decided${r.decisionReason ? `: ${esc(r.decisionReason)}` : ""}</span>` : "";
    return `<div style="font-size:12.5px; color:var(--text-secondary); padding:6px 0; border-top:1px solid var(--border);">
      Seat ${esc(r.fromSeat || "?")} (${esc(r.fromFloor || "Ground Floor")}) → <strong style="color:var(--text-primary);">Seat ${esc(r.toSeat || "?")} (${esc(r.toFloor || "Ground Floor")})</strong>
      <span class="badge ${badge}" style="margin-left:6px;">${esc(r.status || "Pending")}</span>${decided}${cancel}</div>`;
  }).join("");
  return `
    <div class="card" style="margin-top: 1.25rem;">
      <div class="card-header"><h3>My Seat</h3>
        ${canChangeSeat ? `<button class="btn btn-ghost btn-sm" onclick="window.openSeatChangeModal()">Change seat</button>` : ""}
      </div>
      <div style="font-size:13px; color:var(--text-secondary);">
        ${s.seatNumber
          ? `Your fixed seat: <strong style="color:var(--text-primary); font-size:1.1rem;">Seat ${esc(s.seatNumber)} (${esc(s.seatFloor || 'Ground Floor')})</strong>${pending.length ? ` · <span style="color:var(--warning, #b45309);">${pending.length} change request${pending.length > 1 ? "s" : ""} waiting for approval</span>` : ""}`
          : "No fixed seat on your plan."}
      </div>
      ${rows ? `<div style="margin-top:0.5rem;">${rows}</div>` : ""}
    </div>`;
};

const renderPortal = () => {
  if (!currentStudent) return;
  // Listeners attach async — render as soon as the profile lands, using empty
  // arrays for sections that haven't delivered yet.
  if (!Array.isArray(currentAttendance)) currentAttendance = [];
  if (!Array.isArray(currentPayments)) currentPayments = [];
  if (!Array.isArray(currentComplaints)) currentComplaints = [];
  if (!Array.isArray(currentRenewals)) currentRenewals = [];
  const hideBoot = () => {
    try {
      const boot = document.getElementById("portal-boot");
      if (boot) boot.style.display = "none";
      window.__portalFirstRender = true;
    } catch (_) {}
  };
  const s = currentStudent;
  const portalSection = document.getElementById("page-student-portal");
  const initials = s.name ? s.name.substring(0, 2).toUpperCase() : "ST";
  const daysRemaining = calculateDaysRemaining(s.paymentDueDate);
  const isExpired = isSubscriptionExpired(s);
  window.__studentSubscriptionExpired = isExpired;

  const pendingPayment = (Array.isArray(currentPayments) ? currentPayments : []).find(p => p.status === "pending");
  const latestRejectedPayment = (Array.isArray(currentPayments) ? currentPayments : []).find(p => p.status === "rejected" && (!pendingPayment || new Date(p.date || 0) > new Date(pendingPayment.date || 0)));

  // If subscription was renewed by admin, show celebration toast
  if (window.__lastStudentExpiredState === true && !isExpired) {
    if (window.showToast) window.showToast("🎉 Subscription Renewed! Platform access restored.", "success");
  }
  window.__lastStudentExpiredState = isExpired;

  // Sync sidebar / mobile navigation lock states
  try {
    const navAtt = document.querySelector('.nav-item[data-page="student-attendance"]');
    const navComp = document.querySelector('.nav-item[data-page="student-complaints"]');
    const navNotif = document.querySelector('.nav-item[data-page="notifications"]');
    const navPay = document.querySelector('.nav-item[data-page="student-payments"]');
    const mobAtt = document.querySelector('.mob-nav-item[data-page="student-attendance"]');
    const mobComp = document.querySelector('.mob-nav-item[data-page="student-complaints"]');
    const mobNotif = document.querySelector('.mob-nav-item[data-page="notifications"]');

    if (isExpired) {
      [navAtt, navComp, navNotif, mobAtt, mobComp, mobNotif].forEach(el => {
        if (el) {
          el.style.opacity = "0.45";
          el.setAttribute("title", "Locked: Subscription expired");
        }
      });
      if (navPay) {
        let b = navPay.querySelector(".rn-lock-badge");
        if (!b) {
          b = document.createElement("span");
          b.className = "rn-lock-badge";
          b.style.cssText = "margin-left:auto; background:#dc2626; color:#fff; font-size:10px; font-weight:800; padding:2px 7px; border-radius:999px; text-transform:uppercase;";
          b.textContent = "Renew 🔒";
          navPay.appendChild(b);
        }
      }
    } else {
      [navAtt, navComp, navNotif, mobAtt, mobComp, mobNotif].forEach(el => {
        if (el) {
          el.style.opacity = "";
          el.removeAttribute("title");
        }
      });
      const b = navPay?.querySelector(".rn-lock-badge");
      if (b) b.remove();
    }
  } catch (_) {}

  const activeSession = currentAttendance.find(r => r.status === "Active");
  const studyHours = calculateStudyHours(currentAttendance);

  // History HTML Generation...
  let historyHtml = "";
  if (currentAttendance.length === 0) {
    historyHtml = `<tr><td colspan="5" style="text-align:center; color: var(--text-muted);">No attendance records.</td></tr>`;
  } else {
    currentAttendance.slice(0, 5).forEach(r => {
      const cIn = new Date(r.checkIn).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const cOut = r.checkOut ? new Date(r.checkOut).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "Active";
      const statusBadge = r.status === "Active" ? `<span class="badge badge-pending">Active</span>` : `<span class="badge badge-paid">Completed</span>`;
      historyHtml += `<tr><td>${r.date}</td><td>${cIn}</td><td>${cOut}</td><td>${r.duration > 0 ? r.duration + 'h' : '-'}</td><td>${statusBadge}</td></tr>`;
    });
  }

  // Single source of truth: helper to resolve plan amount so it is never ₹0
  const resolveRecordAmount = (r, student) => {
    if (r && Number(r.amount) > 0) return Number(r.amount);
    if (student && Number(student.amount || student.planPrice || student.price || student.fee) > 0) {
      return Number(student.amount || student.planPrice || student.price || student.fee);
    }
    const planName = (r && (r.newPlan || r.planName)) || (student && student.planName);
    const planId = (r && r.planId) || (student && student.planId);
    const p = (planId && onboardingPlans.find(x => x.id === planId)) ||
              (planName && onboardingPlans.find(x => (x.planName || "").toLowerCase().trim() === String(planName).toLowerCase().trim()));
    if (p && Number(p.price) > 0) return Number(p.price);
    return 1000;
  };

  const isValidImg = (u) => typeof u === "string" && (u.startsWith("data:image/") || u.startsWith("http://") || u.startsWith("https://") || u.startsWith("blob:"));
  const studentDocProof = (s._documents && isValidImg(s._documents.paymentScreenshot))
    ? s._documents.paymentScreenshot
    : (isValidImg(s.paymentScreenshot) ? s.paymentScreenshot : (isValidImg(s.paymentScreenshotUrl) ? s.paymentScreenshotUrl : ""));

  const resolveRecordProof = (r, student) => {
    let u = r?.screenshot || r?.paymentScreenshotUrl || (Array.isArray(r?.screenshots) && r.screenshots[0]) || "";
    if (!isValidImg(u)) {
      if (isValidImg(studentDocProof)) u = studentDocProof;
    }
    return isValidImg(u) ? u : "";
  };

  // Auto-heal single source of truth in Firestore + auto-cleanup of duplicate docs
  if (s.id && (s.status === "Active" || s.approvalStatus === "Approved") && !window.__portalRenewalsSyncRunning) {
    window.__portalRenewalsSyncRunning = true;
    (async () => {
      try {
        const renQ = query(collection(db, "renewals"), where("studentId", "==", s.id));
        const renSnap = await getDocs(renQ);
        const docsList = [];
        renSnap.forEach(d => docsList.push({ id: d.id, ...d.data() }));

        // Detect and clean up any duplicate renewal records in Firestore
        const seenDocs = new Map();
        const duplicatesToDelete = [];
        for (const rd of docsList) {
          const k = `${rd.startDate || ""}_${rd.endDate || ""}_${Number(rd.amount) || 0}_${String(rd.transactionId || "").trim().toUpperCase()}`;
          if (seenDocs.has(k)) {
            const prev = seenDocs.get(k);
            if (!prev.screenshot && (rd.screenshot || rd.paymentScreenshotUrl)) {
              duplicatesToDelete.push(prev.id);
              seenDocs.set(k, rd);
            } else {
              duplicatesToDelete.push(rd.id);
            }
          } else {
            seenDocs.set(k, rd);
          }
        }

        // Delete duplicates from Firestore so only one single truth record remains
        for (const dupId of duplicatesToDelete) {
          try {
            await deleteDoc(doc(db, "renewals", dupId));
            console.log("[portal] Removed duplicate renewal from Firestore:", dupId);
          } catch (delErr) {
            console.warn("[portal] Duplicate cleanup skipped:", delErr);
          }
        }

        // If no renewal exists at all in Firestore, create the admission record with deterministic doc ID
        if (seenDocs.size === 0) {
          const rawShot = isValidImg(studentDocProof) ? studentDocProof : "";
          const realAmt = resolveRecordAmount(null, s);
          const stDate = s.startDate || (s.createdAt?.seconds ? new Date(s.createdAt.seconds * 1000).toISOString().split("T")[0] : new Date().toISOString().split("T")[0]);
          const enDate = s.paymentDueDate || s.endDate || stDate;
          const renDoc = {
            studentId: s.id,
            studentName: s.name || "Student",
            oldPlan: "",
            newPlan: s.planName || "Regular Fixed Premium",
            startDate: stDate,
            endDate: enDate,
            amount: realAmt,
            paymentMethod: s.paymentMethod || "UPI",
            transactionId: s.transactionId || "ADMISSION",
            status: "Completed",
            type: "Initial Admission",
            source: "admission",
            renewedBy: "System",
            createdAt: s.createdAt || serverTimestamp()
          };
          if (rawShot) {
            renDoc.screenshot = rawShot;
            renDoc.paymentScreenshotUrl = rawShot;
            renDoc.screenshots = [rawShot];
          }
          await setDoc(doc(db, "renewals", "admission_" + s.id), renDoc, { merge: true });
        }
      } catch (err) {
        console.warn("[portal] renewals sync skipped:", err);
      } finally {
        setTimeout(() => { window.__portalRenewalsSyncRunning = false; }, 3000);
      }
    })();
  }

  // Payments generation
  let displayPayments = [...currentPayments];
  const hasAdmissionPay = displayPayments.some(p => p.source === "onboarding" || p.source === "admission" || (p.transactionId && s.transactionId && p.transactionId === s.transactionId));
  if (!hasAdmissionPay && (s.paymentMethod || s.transactionId || s.paymentScreenshotUrl || studentDocProof || s.status === "Active" || s.approvalStatus === "Approved")) {
    const realAmt = resolveRecordAmount(null, s);
    displayPayments.push({
      id: "initial-admission",
      date: s.startDate || s.admissionDate || (s.createdAt?.seconds ? new Date(s.createdAt.seconds * 1000).toISOString() : new Date().toISOString()),
      planName: s.planName || "Membership Admission",
      amount: realAmt,
      paymentMethod: s.paymentMethod || "UPI",
      transactionId: s.transactionId || "Admission",
      status: (s.status === "Active" || s.approvalStatus === "Approved") ? "approved" : "pending",
      source: "admission",
      monthLabel: s.planName || "Admission",
      screenshot: studentDocProof,
      paymentScreenshotUrl: studentDocProof,
      screenshots: studentDocProof ? [studentDocProof] : []
    });
  }

  let paymentsHtml = "";
  if (displayPayments.length === 0) {
    paymentsHtml = `<tr><td colspan="6" style="text-align:center; color: var(--text-muted);">No payment history.</td></tr>`;
  } else {
    displayPayments.forEach(p => {
      let badgeClass = "badge-pending";
      if (p.status === "approved" || p.status === "Completed") badgeClass = "badge-paid";
      if (p.status === "rejected") badgeClass = "badge-absent";
      const pDate = p.date ? new Date(p.date).toLocaleDateString() : (s.startDate || "—");
      let pPeriod = p.monthLabel || "—";
      const monthsPart = (p.renewalMonths != null && p.renewalMonths !== "") ? Number(p.renewalMonths)
        : (p.renewalPeriod != null && p.renewalPeriod !== "" ? Number(p.renewalPeriod) : 0);
      const daysPart = Number(p.renewalDays) || 0;
      if (monthsPart || daysPart) {
        const bits = [];
        if (monthsPart) bits.push(`${monthsPart} Mo.`);
        if (daysPart) bits.push(`${daysPart} Dy.`);
        pPeriod = bits.join(" ");
      } else if (p.renewalPeriod != null && p.renewalPeriod !== "") {
        pPeriod = `${p.renewalPeriod} Mo.`;
      }
      if (p.source === "onboarding" || p.source === "admission") pPeriod = s.startDate ? `${s.startDate} to ${s.paymentDueDate || s.endDate || "—"}` : "Admission";
      const pTxn = p.transactionId || "—";
      const pStatus = String(p.status || "pending").toUpperCase();
      const proofUrl = resolveRecordProof(p, s);
      const proofCell = isValidImg(proofUrl)
        ? `<button type="button" class="btn btn-ghost btn-sm" onclick="window.viewStudentProofModal('${proofUrl.replace(/'/g, "\\'")}', 'Payment Proof')" style="padding:3px 10px; font-size:12px; font-weight:600; color:var(--primary); border:1px solid var(--border); border-radius:6px; cursor:pointer; display:inline-flex; align-items:center; gap:4px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg> Proof</button>`
        : `<span style="color:var(--text-muted); font-size:12px;">—</span>`;

      paymentsHtml += `<tr><td>${pDate}</td><td>${pPeriod}</td><td>₹${resolveRecordAmount(p, s)}</td><td>${pTxn}</td><td><span class="badge ${badgeClass}">${pStatus}</span></td><td style="text-align:center;">${proofCell}</td></tr>`;
    });
  }

  // Complaints HTML Generation
  let complaintsHtml = "";
  if (currentComplaints.length === 0) {
    complaintsHtml = `<tr><td colspan="4" style="text-align:center; color: var(--text-muted);">No complaints history.</td></tr>`;
  } else {
    currentComplaints.forEach(c => {
      let badgeClass = "badge-pending";
      if (c.status === "Resolved" || c.status === "Closed") badgeClass = "badge-paid";
      if (c.status === "In Progress") badgeClass = "badge-info";
      const resNote = c.resolutionNote ? `<br><small style="color:var(--text-muted)"><i>Admin: ${c.resolutionNote}</i></small>` : "";
      complaintsHtml += `
        <tr>
          <td>${new Date(c.date).toLocaleDateString()}</td>
          <td>${c.category}</td>
          <td>${c.description}${resNote}</td>
          <td><span class="badge ${badgeClass}">${c.status}</span></td>
        </tr>`;
    });
  }

  // Renewals HTML Generation with Proof column, admission fallback, and strict deduplication
  let displayRenewals = [...currentRenewals];
  const hasAdmissionRenewal = displayRenewals.some(r => r.source === "onboarding" || r.source === "admission" || (r.startDate && r.startDate === s.startDate));
  if (!hasAdmissionRenewal && (s.status === "Active" || s.approvalStatus === "Approved") && (s.startDate || s.paymentDueDate)) {
    const realAmt = resolveRecordAmount(null, s);
    displayRenewals.push({
      id: "initial-admission-renewal",
      newPlan: s.planName || "Regular Fixed Premium",
      startDate: s.startDate || "—",
      endDate: s.paymentDueDate || s.endDate || "—",
      amount: realAmt,
      paymentMethod: s.paymentMethod || "UPI",
      screenshot: studentDocProof,
      paymentScreenshotUrl: studentDocProof,
      source: "admission",
      createdAt: s.createdAt || null
    });
  }

  // Deduplicate displayRenewals by date + amount + txnId
  const uniqueRenewalsMap = new Map();
  displayRenewals.forEach(r => {
    const st = r.startDate || "";
    const en = r.endDate || "";
    const amt = resolveRecordAmount(r, s);
    const txn = String(r.transactionId || s.transactionId || "ADMISSION").trim().toUpperCase();
    const key = `${st}_${en}_${amt}_${txn}`;
    if (!uniqueRenewalsMap.has(key)) {
      uniqueRenewalsMap.set(key, r);
    } else {
      const existing = uniqueRenewalsMap.get(key);
      if (!resolveRecordProof(existing, s) && resolveRecordProof(r, s)) {
        uniqueRenewalsMap.set(key, r);
      }
    }
  });
  displayRenewals = Array.from(uniqueRenewalsMap.values());

  let renewalsHtml = "";
  if (displayRenewals.length === 0) {
    renewalsHtml = `<tr><td colspan="5" style="text-align:center; color: var(--text-muted);">No renewal history.</td></tr>`;
  } else {
    displayRenewals.forEach(r => {
      const dateStr = r.startDate || (r.createdAt && r.createdAt.seconds ? new Date(r.createdAt.seconds * 1000).toLocaleDateString() : "Admission");
      const proofUrl = resolveRecordProof(r, s);
      const proofCell = isValidImg(proofUrl)
        ? `<button type="button" class="btn btn-ghost btn-sm" onclick="window.viewStudentProofModal('${proofUrl.replace(/'/g, "\\'")}', 'Renewal Proof')" style="padding:3px 10px; font-size:12px; font-weight:600; color:var(--primary); border:1px solid var(--border); border-radius:6px; cursor:pointer; display:inline-flex; align-items:center; gap:4px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg> Proof</button>`
        : `<span style="color:var(--text-muted); font-size:12px;">—</span>`;
      renewalsHtml += `
        <tr>
          <td>${dateStr}</td>
          <td>${r.newPlan || "—"}</td>
          <td style="font-size:0.85rem;">${r.startDate || "—"} to ${r.endDate || "—"}</td>
          <td class="amount">₹${resolveRecordAmount(r, s)}</td>
          <td style="text-align:center;">${proofCell}</td>
        </tr>
      `;
    });
  }

  // Unified Payment & Renewal History (Single Source of Truth with strict deduplication)
  const unifiedMap = new Map();
  displayRenewals.forEach(r => {
    const rDate = r.startDate || (r.createdAt && r.createdAt.seconds ? new Date(r.createdAt.seconds * 1000).toLocaleDateString() : "—");
    const rPeriod = (r.startDate && r.endDate) ? `${r.startDate} to ${r.endDate}` : "Admission";
    const rAmount = resolveRecordAmount(r, s);
    const rTxn = String(r.transactionId || s.transactionId || "ADMISSION").trim().toUpperCase();
    const rKey = `${rDate}_${rPeriod}_${rAmount}_${rTxn}`;
    if (!unifiedMap.has(rKey)) {
      unifiedMap.set(rKey, {
        id: r.id,
        date: rDate,
        plan: r.newPlan || s.planName || "Membership Plan",
        period: rPeriod,
        amount: rAmount,
        txnId: rTxn,
        status: (r.status || "APPROVED").toUpperCase(),
        proofUrl: resolveRecordProof(r, s)
      });
    }
  });

  displayPayments.forEach(p => {
    const pDate = p.date ? new Date(p.date).toLocaleDateString() : (s.startDate || "—");
    const pPeriod = p.monthLabel || "Admission";
    const pAmount = resolveRecordAmount(p, s);
    const pTxn = String(p.transactionId || "").trim().toUpperCase();
    const pKey = `${pDate}_${pPeriod}_${pAmount}_${pTxn}`;

    const isCovered = Array.from(unifiedMap.values()).some(u => 
      (pTxn && u.txnId && pTxn === u.txnId) ||
      (p.id === "initial-admission" && (u.id === "initial-admission-renewal" || u.id === "admission_" + s.id || String(u.txnId).toUpperCase() === "ADMISSION")) ||
      (p.date && u.date && p.date.split("T")[0] === u.date && pAmount === u.amount) ||
      (unifiedMap.has(pKey))
    );
    if (!isCovered) {
      unifiedMap.set(pKey, {
        id: p.id,
        date: pDate,
        plan: p.planName || s.planName || "Admission",
        period: pPeriod,
        amount: pAmount,
        txnId: pTxn || "—",
        status: String(p.status || "approved").toUpperCase(),
        proofUrl: resolveRecordProof(p, s)
      });
    }
  });

  const unifiedItems = Array.from(unifiedMap.values());

  let unifiedHistoryHtml = "";
  if (unifiedItems.length === 0) {
    unifiedHistoryHtml = `<tr><td colspan="7" style="text-align:center; color: var(--text-muted); padding:2rem;">No payment or renewal history found.</td></tr>`;
  } else {
    unifiedItems.forEach(item => {
      const isApproved = item.status === "APPROVED" || item.status === "COMPLETED";
      const isRejected = item.status === "REJECTED";
      const badgeClass = isApproved ? "badge-paid" : (isRejected ? "badge-absent" : "badge-pending");
      const hasProof = isValidImg(item.proofUrl);
      const proofCell = hasProof
        ? `<button type="button" class="btn btn-ghost btn-sm" onclick="window.viewStudentProofModal('${item.proofUrl.replace(/'/g, "\\'")}', 'Payment Proof')" style="padding:3px 10px; font-size:12px; font-weight:600; color:var(--primary); border:1px solid var(--border); border-radius:6px; cursor:pointer; display:inline-flex; align-items:center; gap:4px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg> Proof</button>`
        : `<span style="color:var(--text-muted); font-size:12px;">—</span>`;

      unifiedHistoryHtml += `
        <tr>
          <td>${item.date}</td>
          <td><strong>${item.plan}</strong></td>
          <td style="font-size:0.85rem; color:var(--text-secondary);">${item.period}</td>
          <td class="amount">₹${item.amount}</td>
          <td style="font-size:0.85rem; font-family:monospace;">${item.txnId}</td>
          <td><span class="badge ${badgeClass}">${item.status}</span></td>
          <td style="text-align:center;">${proofCell}</td>
        </tr>
      `;
    });
  }

  let attendanceActionHtml = "";
  if (activeSession) {
    attendanceActionHtml = `<button id="btn-checkout" class="btn" style="background: #ef4444 !important; color: #ffffff !important; border: none; box-shadow: 0 1px 2px rgba(239,68,68,0.2);" onclick="window.handleCheckOut('${activeSession.id}', ${activeSession.checkIn})">Check-Out Now</button>`;
  } else {
    attendanceActionHtml = isExpired
      ? (pendingPayment
          ? `<button class="btn btn-secondary" onclick="navigate('student-payments')" style="font-weight:600; display:inline-flex; align-items:center; gap:6px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> Verification Pending</button>`
          : `<button class="btn btn-primary" onclick="navigate('student-payments')" style="background:#dc2626 !important; border:none; display:inline-flex; align-items:center; gap:6px; font-weight:700;"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> Renew to Check-in</button>`)
      : `<button id="btn-checkin" class="btn" style="background: var(--primary) !important; color: #ffffff !important; border: none;" onclick="window.handleCheckIn()">Check-In Now</button>`;
  }

  // 1. DASHBOARD PAGE (Overview)
  // ---- First-time onboarding / approval gate --------------------------
  // docs/FLOW-AND-DATA-SPEC.md §3. Every state other than an approved member
  // renders exactly one wizard step (or its pending/rejected screen) and hides
  // the navigation. Once the admin approves, this resolves to DASHBOARD and
  // the wizard never appears again. Nothing is stored in sessionStorage: each
  // step persists to Firestore before advancing, so a half-finished applicant
  // resumes at the same step instead of starting over (and never duplicates).
  const onboardingState = resolvePortalState(s, s._documents || {}, planForRecord(s));
  // Manual step override (Back button): lets the student revisit an earlier
  // wizard screen without changing Firestore. Cleared on every Next/save so
  // the state machine stays the source of truth going forward.
  const manualStep = window.__wizardManualStep || null;
  const isWizardStep = (k) => k && [STATE.DETAILS, STATE.DOCUMENTS, STATE.PLAN, STATE.SEAT, STATE.PAYMENT].includes(k);
  const effectiveState = (isWizardStep(manualStep) && onboardingState !== STATE.DASHBOARD && onboardingState !== STATE.PENDING && onboardingState !== STATE.REJECTED)
    ? manualStep
    : onboardingState;
  if (effectiveState !== STATE.DASHBOARD) {
    window.__onboardingActive = true;
    // Both of these run BEFORE renderOnboarding awaits the plan list: the
    // sidebar becomes an admission step rail (hiding the nav items used to
    // leave a blank slab) and the content area gets a themed skeleton. That is
    // what stops the finished dashboard flashing for a beat first.
    paintWizardSidebar(effectiveState, s, s._documents || {}, planForRecord(s));
    // Force the portal tab active — the student must finish onboarding here.
    try {
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      portalSection.classList.add('active');
      document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    } catch (_) {}
    showWizardLoading(portalSection);
    hideBoot();
    const handleWizardAdvance = (target) => {
      if (isWizardStep(target)) {
        // Back/Next explicit jump: render that step immediately (no Firestore
        // round-trip needed for Back). Next/save clears the override first.
        const order = [STATE.DETAILS, STATE.DOCUMENTS, STATE.PLAN, STATE.SEAT, STATE.PAYMENT];
        const curIdx = order.indexOf(effectiveState);
        const tgtIdx = order.indexOf(target);
        if (tgtIdx !== -1 && tgtIdx < curIdx) {
          window.__wizardManualStep = target;
          renderPortal();
          return;
        }
        window.__wizardManualStep = null;
      } else {
        window.__wizardManualStep = null;
      }
      renderPortal();
    };
    renderOnboarding({
      container: portalSection,
      state: effectiveState,
      student: s,
      documents: s._documents || {},
      plans: onboardingPlans,
      plan: planForRecord(s),
      onAdvance: handleWizardAdvance
    });
    return;
  }
  // Approved: put the real navigation back (it was swapped for the step rail).
  window.__onboardingActive = false;
  window.__wizardManualStep = null;
  restoreSidebar();

  { // ----- active student dashboard -----
    // Normal active student dashboard

    // Clean up Settings page for students (Hide admin-only controls)
    const settingsPage = document.getElementById("page-settings");
    if (settingsPage) {
      const saveBtn = settingsPage.querySelector(".btn-primary");
      if (saveBtn) saveBtn.style.display = "none";

      const adminCards = settingsPage.querySelectorAll(".settings-card");
      adminCards.forEach(card => {
        const title = card.querySelector(".settings-section-title");
        if (title && title.innerText.includes("Reading Space Info")) {
          card.style.display = "none";
        }
      });

      const toggles = settingsPage.querySelector(".settings-toggle-list");
      if (toggles) toggles.style.display = "none";

      // Auto-save language on change for students
      const langSelect = document.getElementById("setting-language");
      if (langSelect) {
        langSelect.addEventListener("change", (e) => {
          import('./translationService.js').then(({ setLanguage }) => {
            setLanguage(e.target.value);
          });
        });
      }
    }

    // Restore sidebars for active students
    const navItems = document.querySelectorAll('.sidebar-nav .nav-item');
    navItems.forEach(item => {
      const dp = item.getAttribute('data-page');
      const allowedForStudent = ["student-portal", "student-payments", "student-attendance", "student-complaints", "notifications", "settings"];
      if (allowedForStudent.includes(dp)) {
        item.style.display = 'flex';
      } else {
        item.style.display = 'none';
      }
    });

    // Profile photo update — defined once per render but always reads the
    // latest currentStudent so a stale closure can never show the wrong avatar.
    window.updateProfilePhoto = async () => {
      const live = currentStudent || s;
      const livePhoto = live.profilePhotoUrl || live.photoUrl || live.photo || null;
      const liveInitials = (live.name || "ST").substring(0, 2).toUpperCase();
      const liveAvatar = livePhoto
        ? `<img src="${livePhoto}" alt="Profile" style="width:100%; height:100%; object-fit:cover; border-radius:50%;">`
        : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:rgba(139,92,246,.15);color:var(--accent-violet);font-weight:700;font-size:2rem;">${liveInitials}</div>`;
      // Remove any previous photo dialog (prevents stacked <dialog> nodes).
      document.getElementById("profile-photo-modal")?.remove();
      const modal = document.createElement('dialog');
      modal.id = "profile-photo-modal";
      modal.className = 'card';
      modal.style.cssText = 'border:none; border-radius:12px; padding:0; box-shadow:0 10px 30px rgba(0,0,0,0.5); background: var(--bg-card); color: var(--text-primary); max-width: 420px; width: calc(100vw - 32px); margin: auto;';
      modal.innerHTML = `
        <div style="padding: 1.25rem 1.5rem; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center;">
          <h2 style="font-size: 1.1rem; font-weight: 600; margin: 0;">Profile Photo</h2>
          <button id="photo-close" style="background: none; border: none; font-size: 1.4rem; cursor: pointer; color: var(--text-muted); line-height:1;">&times;</button>
        </div>
        <div style="padding: 1.5rem; text-align: center;">
          <div id="photo-preview" style="width: 150px; height: 150px; border-radius: 50%; overflow: hidden; border: 3px solid var(--primary); background: var(--bg-hover); margin: 0 auto 1rem; box-shadow: 0 4px 12px rgba(5,150,105,0.2);">
            ${liveAvatar}
          </div>
          <div style="margin-bottom: 1rem;">
            <label class="btn btn-primary" style="cursor:pointer; display:inline-flex; align-items:center; gap:6px; font-weight:600; font-size:13px; padding:8px 16px; border-radius:8px;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              Choose Photo
              <input type="file" accept="image/*" style="display:none;" id="profile-photo-input" />
            </label>
          </div>
          <p style="font-size:0.8rem; color:var(--text-muted); margin-bottom:1.25rem;">JPG/PNG up to 10MB. Compressed automatically — square photos look best.</p>
          <div style="display:flex; gap:0.5rem; justify-content:center;">
            <button class="btn btn-ghost" id="photo-cancel">Cancel</button>
            <button class="btn btn-primary" id="btn-save-photo" style="display:none;">Save Photo</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
      modal.showModal();
      modal.querySelector("#photo-close").onclick = () => modal.close();
      modal.querySelector("#photo-cancel").onclick = () => modal.close();
      modal.addEventListener("close", () => modal.remove());

      const input = modal.querySelector('#profile-photo-input');
      const preview = modal.querySelector('#photo-preview');
      const saveBtn = modal.querySelector('#btn-save-photo');
      let selectedFile = null;
      let previewUrl = null;

      input.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (!file.type.startsWith('image/')) {
          window.showToast("Please select an image file (JPG/PNG).", "error");
          input.value = "";
          return;
        }
        if (file.size > 10 * 1024 * 1024) {
          window.showToast("Image is too large. Maximum 10MB.", "error");
          input.value = "";
          return;
        }
        selectedFile = file;
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = URL.createObjectURL(file);
        preview.innerHTML = `<img src="${previewUrl}" alt="Preview" style="width:100%; height:100%; object-fit:cover; border-radius:50%;">`;
        saveBtn.style.display = 'inline-flex';
      });

      saveBtn.addEventListener('click', async () => {
        if (!selectedFile) return;
        saveBtn.disabled = true;
        saveBtn.innerHTML = 'Uploading...';
        try {
          const { uploadProfilePhoto } = await import("./documentUploadService.js");
          const result = await uploadProfilePhoto(selectedFile, live.id);
          if (result.success) {
            // Update in-memory profile so the UI refreshes instantly.
            if (currentStudent) {
              currentStudent.profilePhotoUrl = result.url;
              currentStudent.photoUrl = result.url;
            }
            window.showToast("Profile photo updated!", "success");
            modal.close();
            if (previewUrl) URL.revokeObjectURL(previewUrl);
            renderPortal();
          } else {
            window.showToast("Upload failed: " + result.error, "error");
          }
        } catch (e) {
          window.showToast("Upload failed: " + (e.message || e), "error");
        } finally {
          saveBtn.disabled = false;
          saveBtn.innerHTML = 'Save Photo';
        }
      });
    };

    // Get student photo from Firestore documents
    const liveStudent = currentStudent || s;
    const studentPhoto = liveStudent.profilePhotoUrl || liveStudent.photoUrl || liveStudent.photo || null;
    const avatarHtml = studentPhoto
      ? `<img src="${studentPhoto}" alt="${(s.name || "Student").replace(/"/g, "")}" style="width:100%; height:100%; object-fit:cover; border-radius:50%;">`
      : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:rgba(139,92,246,.15);color:var(--accent-violet);font-weight:700;font-size:1.75rem;">${initials}</div>`;

    // ---- Live dashboard figures (all from this student's own Firestore docs) ----
    const pendingPayments = currentPayments.filter(p => p.status === "pending");
    const openComplaints = currentComplaints.filter(c => c.status === "Pending" || c.status === "In Progress");
    const lastPayment = currentPayments[0] || null;
    const lastSession = currentAttendance.find(r => r.status !== "Active") || null;
    let liveToday = Number(studyHours.todayHours) || 0;
    if (activeSession && activeSession.checkIn) {
      liveToday = Math.round((liveToday + Math.max(0, (Date.now() - activeSession.checkIn) / 3600000)) * 100) / 100;
    }
    const checkinSince = activeSession && activeSession.checkIn
      ? new Date(activeSession.checkIn).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    const assignedSeat = s.seatNumber || s.seatAssigned || "";
    const assignedFloor = s.seatFloor || s.floor || (assignedSeat ? "Ground Floor" : "");
    const seatLabel = activeSession
      ? `${activeSession.seatNumber || "—"} (${activeSession.seatFloor || assignedFloor || "Ground Floor"})`
      : (assignedSeat ? `${assignedSeat} (${assignedFloor})` : "Not assigned");
    const dueLabel = s.paymentDueDate
      ? new Date(s.paymentDueDate).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "N/A";
    const dueUrgent = daysRemaining <= 5;
    const subscriptionLeft = formatSubscriptionLeft(daysRemaining);

    // Keep the app chrome honest for students: real name + photo, live
    // notification count, no admin search box.
    syncStudentChrome(s, studentPhoto, pendingPayments.length + openComplaints.length);

    portalSection.innerHTML = `
      <div class="page-header">
        <div>
          <h1>${window.t ? window.t("studentPortal.welcome", { name: s.name }) : "Welcome back, " + s.name}</h1>
          <p class="page-subtitle">Here is your personal study portal.</p>
        </div>
        <div style="display:flex; gap:1rem; align-items:center;">
          ${attendanceActionHtml}
        </div>
      </div>

      <!-- Live overview: profile / check-in state / study hours / subscription -->
      <div class="metrics-grid">
        <div class="metric-card" style="align-items: center; text-align: center;">
          <div style="width: 80px; height: 80px; border-radius: 50%; overflow: hidden; border: 3px solid var(--primary); background: var(--bg-card); margin-bottom: 0.75rem; box-shadow: 0 4px 12px rgba(5,150,105,0.2); flex-shrink:0;">
            ${avatarHtml}
          </div>
          <div style="width: 100%;">
            <div style="font-weight:700; font-size:1rem; color:var(--text-primary);">${s.name || "Student"}</div>
            <div style="font-size:0.8rem; color:var(--text-muted); margin:2px 0 6px;">${s.planName || "No plan"} · Seat ${seatLabel} · ${s.status || "—"}</div>
            ${s.profilePhotoUrl || s.photoUrl || s.photo
              ? `<button class="btn btn-ghost btn-sm" onclick="window.updateProfilePhoto()" style="margin-top: 0.25rem; font-size: 0.75rem;">Change Photo</button>`
              : `<button class="btn btn-primary btn-sm" onclick="window.updateProfilePhoto()" style="margin-top: 0.25rem; font-size: 0.75rem;">Add Photo</button>`}
          </div>
        </div>
        <div class="metric-card" style="align-items: center;">
          <div class="metric-icon ${isExpired ? "red" : (activeSession ? "emerald" : "amber")}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg></div>
          <div>
            <div class="metric-label">Right now</div>
            <div class="metric-value" style="font-size:1.15rem; color:${isExpired ? "var(--danger)" : "inherit"};">${isExpired ? "Access Locked" : (activeSession ? "Checked in" : "Not checked in")}</div>
            <div style="font-size:0.78rem; color:var(--text-muted); margin-top:2px;">${isExpired ? "Subscription expired. Renew to check in." : (activeSession ? `Seat ${seatLabel} · since ${checkinSince}` : (s.seatNumber ? `Your seat: Seat ${s.seatNumber} (${s.seatFloor || 'Ground Floor'})` : "Pick any free seat at check-in"))}</div>
            ${(!isExpired && canChangeSeat) ? `<button class="btn btn-ghost btn-sm" onclick="window.openSeatChangeModal()" style="margin-top:6px; font-size:0.75rem;">Change seat</button>` : ""}
          </div>
        </div>
        <div class="metric-card" style="align-items: center;">
          <div class="metric-icon blue"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg></div>
          <div>
            <div class="metric-label">Study hours</div>
            <div class="metric-value" style="font-size:1.15rem;">${liveToday}h <span style="font-size:0.75rem; font-weight:500; color:var(--text-muted);">today</span></div>
            <div style="font-size:0.78rem; color:var(--text-muted); margin-top:2px;">${studyHours.monthlyHours || 0}h this month · ${studyHours.totalHours || 0}h total</div>
          </div>
        </div>
        <div class="metric-card" style="align-items: center;">
          <div class="metric-icon ${isExpired || dueUrgent ? "red" : "teal"}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"></rect><line x1="2" y1="10" x2="22" y2="10"></line></svg></div>
          <div>
            <div class="metric-label">Subscription</div>
            <div class="metric-value" style="font-size:1.15rem; color:${isExpired || dueUrgent ? "var(--danger)" : "inherit"};">${isExpired ? "Expired" : subscriptionLeft}</div>
            <div style="font-size:0.78rem; color:var(--text-muted); margin-top:2px;">${isExpired ? `Ended ${dueLabel} · Access locked` : `Due ${dueLabel} · ${daysRemaining} day${daysRemaining === 1 ? "" : "s"}${pendingPayments.length ? ` · ${pendingPayments.length} pending` : " · all clear"}`}</div>
          </div>
        </div>
      </div>

      ${isExpired ? `
        ${pendingPayment ? `
          <div class="sp-alert sp-alert-warn" style="margin-top:1.25rem; padding:16px 20px; border-radius:14px; background:linear-gradient(135deg, rgba(245,158,11,0.14), rgba(217,119,6,0.06)); border:1.5px solid rgba(245,158,11,0.4); display:flex; gap:16px; align-items:flex-start;">
            <div style="width:36px; height:36px; border-radius:50%; background:rgba(245,158,11,0.2); color:var(--accent-amber, #f59e0b); display:flex; align-items:center; justify-content:center; flex-shrink:0;">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            </div>
            <div style="flex:1;">
              <div style="font-weight:700; font-size:15px; color:var(--text-primary); margin-bottom:4px;">Renewal Request Submitted — Awaiting Admin Verification</div>
              <div style="font-size:13px; color:var(--text-secondary); line-height:1.5;">
                We received your renewal payment of <strong style="color:var(--text-primary);">₹${pendingPayment.amount}</strong> via <strong>${pendingPayment.paymentMethod || 'UPI'}</strong> (UTR: <code style="font-family:monospace; background:var(--bg-card); padding:2px 6px; border-radius:4px; font-weight:700; border:1px solid var(--border);">${pendingPayment.transactionId}</code>). The admin is verifying the credit in the bank account against your uploaded proof. Once approved, your platform access and seat will be immediately restored.
              </div>
              <div style="margin-top:12px; display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
                <span class="badge" style="background:rgba(245,158,11,0.18); color:var(--accent-amber, #fbbf24); border:1px solid rgba(245,158,11,0.35); font-weight:700; padding:4px 10px; border-radius:999px; font-size:11.5px;">Status: Bank Verification Pending</span>
                <button class="btn btn-ghost btn-sm" onclick="navigate('student-payments')" style="font-size:12px; padding:4px 12px; border:1px solid var(--border); border-radius:6px; color:var(--text-primary);">View Status on Payments Page</button>
              </div>
            </div>
          </div>
        ` : `
          <div class="sp-alert sp-alert-bad" style="margin-top:1.25rem; padding:16px 20px; border-radius:14px; display:flex; gap:16px; align-items:flex-start;">
            <div style="width:36px; height:36px; border-radius:50%; background:rgba(239,68,68,0.18); color:var(--danger, #f43f5e); display:flex; align-items:center; justify-content:center; flex-shrink:0;">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            </div>
            <div style="flex:1;">
              <div style="font-weight:700; font-size:15px; color:var(--danger); margin-bottom:4px;">Platform Access Locked — Subscription Expired</div>
              <div style="font-size:13px; color:var(--text-secondary); line-height:1.5;">
                Your subscription finished on <strong style="color:var(--text-primary);">${dueLabel}</strong>. To access study hall facilities and check-in, please pay your debt / submit your renewal request.
              </div>
              <div style="margin-top:12px;">
                <button class="btn btn-primary" onclick="navigate('student-payments')" style="font-size:13px; font-weight:700; padding:8px 18px; border-radius:8px; background:var(--danger, #f43f5e); border:none; color:#fff;">Pay Debt & Renew Subscription Now →</button>
              </div>
            </div>
          </div>
        `}
      ` : ''}
      
      <div class="dashboard-grid" style="margin-top: 1.25rem;">
        <div class="card">
          <div class="card-header"><h3>Recent check-ins</h3><button class="btn btn-ghost btn-sm" onclick="navigate('student-attendance')">View all</button></div>
          ${currentAttendance.length === 0
            ? `<div style="text-align:center; color:var(--text-muted); padding:1.5rem 0;">No check-ins yet — use Check-In Now when you arrive.</div>`
            : `<div class="table-responsive"><table class="data-table"><thead><tr><th>Date</th><th>Seat</th><th>In</th><th>Out</th><th>Status</th></tr></thead><tbody>${currentAttendance.slice(0, 5).map(r => {
                const cIn = r.checkIn ? new Date(r.checkIn).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
                const cOut = r.checkOut ? new Date(r.checkOut).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : (r.status === "Active" ? "In now" : "—");
                const badge = r.status === "Active" ? `<span class="badge badge-pending">Active</span>` : `<span class="badge badge-paid">Done</span>`;
                return `<tr><td>${r.date || "—"}</td><td>${r.seatNumber || "—"}</td><td>${cIn}</td><td>${cOut}</td><td>${badge}</td></tr>`;
              }).join("")}</tbody></table></div>`}
        </div>
        <div class="card">
          <div class="card-header"><h3>Payments</h3><button class="btn btn-ghost btn-sm" onclick="navigate('student-payments')">Pay / history</button></div>
          ${lastPayment
            ? `<div style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:0.75rem;">Last: <strong style="color:var(--text-primary);">₹${Number(lastPayment.amount) || 0}</strong> · ${lastPayment.status || "pending"} · ${lastPayment.date ? new Date(lastPayment.date).toLocaleDateString() : "—"}</div>`
            : `<div style="font-size:0.85rem; color:var(--text-muted); margin-bottom:0.75rem;">No payments yet.</div>`}
          ${pendingPayments.length
            ? `<div class="sp-alert sp-alert-warn" style="margin-bottom:0.75rem;"><div><div class="sp-alert-title">${pendingPayments.length} payment${pendingPayments.length > 1 ? "s" : ""} awaiting approval</div><div>Pay the UPI ID on the Payments page and the desk will approve it.</div></div></div>`
            : `<div class="sp-alert sp-alert-ok" style="margin-bottom:0.75rem;"><div><div class="sp-alert-title">Subscription ${dueUrgent ? `ends ${dueLabel} — renew soon` : `valid till ${dueLabel}`}</div><div>${dueUrgent ? "Pay now to avoid losing your seat." : "You are all paid up."}</div></div></div>`}
          ${openComplaints.length
            ? `<div style="font-size:0.85rem; color:var(--text-secondary);">${openComplaints.length} open complaint${openComplaints.length > 1 ? "s" : ""} — <a href="#" onclick="navigate('student-complaints'); return false;" style="color:var(--primary);">track here</a>.</div>`
            : lastSession
              ? `<div style="font-size:0.85rem; color:var(--text-muted);">Last visit: ${lastSession.date || "—"}${lastSession.seatNumber ? ` · Seat ${lastSession.seatNumber} (${lastSession.seatFloor || 'Ground Floor'})` : ""} · ${lastSession.duration ? lastSession.duration + "h" : "—"}.</div>`
              : ""}
        </div>
      </div>
      
      ${seatRequestsCardHtml(s)}

      <div class="card" style="margin-top: 1.25rem;">
        <div class="card-header">
          <div>
            <h3>My Documents</h3>
            <div style="font-size:0.8rem; color:var(--text-muted); margin-top:2px;">Same files the desk sees — upload your Aadhaar here. One shared record, no duplicates.</div>
          </div>
          <button class="btn btn-ghost btn-sm" onclick="window.refreshOwnDocuments()">Refresh</button>
        </div>
        <div id="student-own-documents"><div style="text-align:center; padding:1.5rem; color:var(--text-muted);">Loading documents…</div></div>
      </div>

      <!-- Check-In Seat Map Modal -->
      <dialog id="checkin-seat-modal" class="card" style="border:none; border-radius:12px; padding:0; box-shadow:0 10px 30px rgba(0,0,0,0.5); background: var(--bg-card); color: var(--text-primary); width:min(860px, calc(100vw - 24px)); max-width:860px; margin:auto;">
        <div style="padding: 1.1rem 1.5rem; border-bottom: 1px solid var(--borderBright); display: flex; justify-content: space-between; align-items: center;">
          <div>
            <h2 style="font-size: 1.05rem; font-weight: 600; margin: 0;">Select Your Seat</h2>
            <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">Tap any green or amber seat — you're free to choose where you sit.</div>
          </div>
          <button onclick="document.getElementById('checkin-seat-modal').close()" style="background: none; border: none; font-size: 1.4rem; cursor: pointer; color: var(--text-muted); line-height: 1;">&times;</button>
        </div>
        <div style="padding: 1.25rem 1.5rem;">
          <div id="checkin-seat-selection-section" style="border: 1px solid var(--border-bright); border-radius: 12px; padding: 1rem;"></div>
          <input type="hidden" id="selectedSeatNumber" />
          <input type="hidden" id="selectedSeatFloor" />
          <input type="hidden" id="selectedSeatId" />
          <div style="display:flex; justify-content:space-between; align-items:center; gap:1rem; margin-top: 1rem; flex-wrap:wrap;">
            <span style="font-size:12.5px; color:var(--text-muted);">Occupied &amp; maintenance seats can't be picked.</span>
            <div style="display:flex; gap:0.6rem;">
              <button class="btn btn-ghost" onclick="document.getElementById('checkin-seat-modal').close()">Cancel</button>
              <button class="btn btn-primary" id="btn-confirm-checkin" onclick="window.confirmCheckIn()" style="padding:10px 24px;">Confirm Check-In</button>
            </div>
          </div>
        </div>
      </dialog>
    `;
  }

  // Compute unpaid months before building the payment form
  const { monthsOwed: _monthsOwed, nextMonthLabel: _nextMonthLabel, nextStartStr: _nextStartStr, nextEndStr: _nextEndStr } = computeUnpaidMonths(s.paymentDueDate);
  const renewSeatVal = s.seatNumber || s.seatAssigned || "";
  const renewFloorVal = s.seatFloor || s.floor || (renewSeatVal ? "Ground Floor" : "");
  const renewSeatText = renewSeatVal ? ` · Seat ${renewSeatVal} (${renewFloorVal})` : "";
  const paymentsPageBannerHtml = (() => {
    if (pendingPayment) {
      const pProof = pendingPayment.screenshot || pendingPayment.paymentScreenshotUrl || null;
      return `
        <div class="card" style="margin-bottom:1.25rem; padding:18px 20px; border-radius:14px; background:linear-gradient(135deg, rgba(245,158,11,0.12), rgba(217,119,6,0.05)); border:1.5px solid rgba(245,158,11,0.38);">
          <div style="display:flex; gap:16px; align-items:flex-start; flex-wrap:wrap;">
            <div style="width:36px; height:36px; border-radius:50%; background:rgba(245,158,11,0.2); color:var(--accent-amber, #f59e0b); display:flex; align-items:center; justify-content:center; flex-shrink:0;">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            </div>
            <div style="flex:1; min-width:260px;">
              <div style="display:flex; align-items:center; gap:10px; margin-bottom:6px; flex-wrap:wrap;">
                <h3 style="margin:0; font-size:1.05rem; font-weight:700; color:var(--text-primary);">Renewal Request Under Verification</h3>
                <span class="badge" style="background:rgba(245,158,11,0.18); color:var(--accent-amber, #fbbf24); border:1px solid rgba(245,158,11,0.35); font-weight:700; padding:3px 10px; border-radius:999px; font-size:12px;">Bank Verification Pending</span>
              </div>
              <div style="font-size:13.5px; color:var(--text-secondary); line-height:1.5; margin-bottom:8px;">
                We received your payment of <strong style="color:var(--text-primary);">₹${pendingPayment.amount}</strong> via <strong>${pendingPayment.paymentMethod || 'UPI'}</strong> (Txn/UTR: <code style="font-family:monospace; background:var(--bg-card); padding:2px 7px; border-radius:4px; font-weight:700; border:1px solid var(--border);">${pendingPayment.transactionId || '—'}</code>).
              </div>
              <div style="padding:10px 14px; background:rgba(245,158,11,0.08); border-radius:8px; border-left:3px solid var(--accent-amber, #f59e0b); font-size:12.5px; color:var(--text-secondary); line-height:1.45;">
                <strong style="color:var(--text-primary);">Admin Verification Process:</strong> The administrator is currently checking the credit in their bank account and validating your screenshot proof. Once verified and approved, your subscription will be renewed and platform check-in will be automatically unblocked.
              </div>
              ${pProof ? `
                <div style="margin-top:10px;">
                  <button type="button" class="btn btn-ghost btn-sm" onclick="window.viewStudentProofModal('${String(pProof).replace(/'/g, "\\'")}', 'Uploaded Payment Proof')" style="font-size:12px; font-weight:600; padding:4px 12px; border:1px solid var(--border); border-radius:6px; cursor:pointer; display:inline-flex; align-items:center; gap:4px; color:var(--primary);">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg> View Uploaded Proof Screenshot
                  </button>
                </div>
              ` : ''}
            </div>
          </div>
        </div>
      `;
    }

    if (latestRejectedPayment) {
      const rejectReason = latestRejectedPayment.rejectionReason || latestRejectedPayment.remark || "Payment could not be verified in bank account or invalid proof uploaded.";
      return `
        <div class="card" style="margin-bottom:1.25rem; padding:18px 20px; border-radius:14px; background:linear-gradient(135deg, rgba(239,68,68,0.1), rgba(220,38,38,0.04)); border:1.5px solid rgba(239,68,68,0.35);">
          <div style="display:flex; gap:16px; align-items:flex-start; flex-wrap:wrap;">
            <div style="width:36px; height:36px; border-radius:50%; background:rgba(239,68,68,0.18); color:var(--danger, #f43f5e); display:flex; align-items:center; justify-content:center; flex-shrink:0;">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
            </div>
            <div style="flex:1; min-width:260px;">
              <div style="display:flex; align-items:center; gap:10px; margin-bottom:6px; flex-wrap:wrap;">
                <h3 style="margin:0; font-size:1.05rem; font-weight:700; color:var(--danger);">Previous Renewal Request Not Approved</h3>
                <span class="badge" style="background:rgba(239,68,68,0.18); color:var(--danger, #f87171); border:1px solid rgba(239,68,68,0.35); font-weight:700; padding:3px 10px; border-radius:999px; font-size:12px;">Verification Failed</span>
              </div>
              <div style="font-size:13.5px; color:var(--text-secondary); line-height:1.5; margin-bottom:8px;">
                Your previous renewal payment of <strong style="color:var(--text-primary);">₹${latestRejectedPayment.amount}</strong> was rejected by admin.
              </div>
              <div style="padding:10px 14px; background:rgba(239,68,68,0.08); border-radius:8px; border-left:3px solid var(--danger); font-size:13px; color:var(--danger); font-weight:600; margin-bottom:10px;">
                Reason: "${rejectReason}"
              </div>
              <div style="font-size:12.5px; color:var(--text-muted); line-height:1.45;">
                Please verify the debit in your bank / UPI app, make sure you copy the exact 12-digit UTR/Transaction ID, upload a clear screenshot of the completed transaction, and re-submit below.
              </div>
            </div>
          </div>
        </div>
      `;
    }

    if (isExpired) {
      return `
        <div class="card" style="margin-bottom:1.25rem; padding:18px 20px; border-radius:14px; background:linear-gradient(135deg, rgba(239,68,68,0.09), rgba(185,28,28,0.03)); border:1.5px solid rgba(239,68,68,0.3);">
          <div style="display:flex; gap:16px; align-items:flex-start;">
            <div style="width:36px; height:36px; border-radius:50%; background:rgba(239,68,68,0.18); color:var(--danger, #f43f5e); display:flex; align-items:center; justify-content:center; flex-shrink:0;">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            </div>
            <div style="flex:1;">
              <h3 style="margin:0 0 6px 0; font-size:1.05rem; font-weight:700; color:var(--danger);">Platform Access Locked — Subscription Expired</h3>
              <div style="font-size:13.5px; color:var(--text-secondary); line-height:1.5;">
                Your subscription ended on <strong style="color:var(--text-primary);">${s.paymentDueDate ? new Date(s.paymentDueDate).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }) : 'recently'}</strong>. All platform facilities (check-in, complaints, attendance) are locked. Please submit your renewal payment below so the admin can verify bank credit and restore your access.
              </div>
            </div>
          </div>
        </div>
      `;
    }

    return "";
  })();

  // 2. PAYMENTS PAGE
  document.getElementById("page-student-payments").innerHTML = `
    <div class="page-header">
      <div>
        <h1>Payments & Renewals</h1>
        <p class="page-subtitle">Manage your subscription and view past payments.</p>
      </div>
    </div>
    
    <div class="sp-stack">
      <div class="sp-stack" style="margin-top:0;">
        ${paymentsPageBannerHtml}

        <!-- Submit Payment Request -->
        <div class="card sp-renew-card">
          <div style="display: flex; align-items: center; margin-bottom: 1.5rem; gap: 0.75rem; color: var(--primary);">
            <svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2" fill="none"><path d="M23 4v6h-6"></path><path d="M1 20v-6h6"></path><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
            <h3 style="margin: 0; font-size: 1.25rem;">Renew Subscription</h3>
          </div>

          ${_monthsOwed > 0 ? `
          <div class="sp-alert sp-alert-warn">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <div>
              <div class="sp-alert-title">⚠ ${_monthsOwed} Unpaid Month${_monthsOwed > 1 ? 's' : ''} Detected</div>
              <div>Your fees are overdue. You must clear them <strong>one month at a time</strong>, starting from the oldest. Currently paying for: <strong>${_nextMonthLabel}</strong>.</div>
            </div>
          </div>
          ` : ''}

          <div class="sp-renew-flex">
            <!-- LEFT SIDE: Form & Details -->
            <div class="sp-renew-main">
              
              <!-- Student Info Block -->
              <div class="sp-idcard">
                ${(s.profilePhotoUrl || s.photoUrl || s.photo)
                  ? `<div style="width: 50px; height: 50px; border-radius:50%; overflow:hidden; flex-shrink:0;"><img src="${s.profilePhotoUrl || s.photoUrl || s.photo}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;" /></div>`
                  : `<div class="avatar" style="width: 50px; height: 50px; background: var(--primary); font-size: 1.2rem;">${initials}</div>`}
                <div>
                  <h4>${s.name}</h4>
                  <div class="sp-idcard-sub">Phone: ${s.phone || "—"}${renewSeatText}</div>
                </div>
              </div>

              <!-- Subscription Status -->
              <div class="sp-alert ${_monthsOwed > 0 ? "sp-alert-bad" : "sp-alert-ok"}" style="align-items:center;">
                <svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2" fill="none"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                <div>
                  <div class="sp-alert-title" style="font-size:0.75rem; letter-spacing:0.04em;">Current Subscription Ends</div>
                  <div style="font-size: 1rem; font-weight: 600; display: flex; align-items: center; gap: 8px;">
                    ${s.paymentDueDate ? new Date(s.paymentDueDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : 'N/A'}
                    ${_monthsOwed > 0 ? `<span style="font-size:0.75rem; padding:2px 8px; background:var(--danger); color:#fff; border-radius:999px; font-weight:500;">Overdue</span>` : ''}
                  </div>
                </div>
              </div>

              <!-- DATES SECTION -->
              <div style="margin-bottom: 1.25rem;">
                <label style="font-size: 0.72rem; font-weight: 800; color: var(--text-muted); text-transform: uppercase; margin-bottom: 0.5rem; display: block; letter-spacing:0.05em;">DATES *</label>
                <div style="display:flex; align-items:center; justify-content:space-between; padding:1rem 1.25rem; background:var(--bg-card); border:1px solid var(--border); border-radius:12px; margin-bottom:0;">
                  <!-- START -->
                  <div style="text-align: center; flex:1; cursor:pointer;" onclick="window.triggerStudentDatePicker('student-start-date')">
                    <div style="font-size:0.72rem; font-weight:800; color:#3b82f6; display:flex; align-items:center; justify-content:center; gap:4px; text-transform:uppercase;">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/></svg>
                      START
                    </div>
                    <div style="font-size: 1.15rem; font-weight: 700; margin-top: 4px;" id="student-start-disp">--</div>
                    <div style="font-size: 11px; color: var(--text-muted); display:flex; align-items:center; justify-content:center; gap:2px;">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Edit
                    </div>
                    <input type="date" id="student-start-date" style="position:absolute; opacity:0; width:1px; height:1px; pointer-events:none;" onchange="window.calculatePaymentAmount()" />
                  </div>

                  <!-- ARROW -->
                  <div style="font-size: 1.4rem; margin: 0 0.75rem; user-select: none; opacity:0.6; color:var(--text-muted);">→</div>

                  <!-- END -->
                  <div style="text-align: center; flex:1; cursor:pointer;" onclick="window.triggerStudentDatePicker('student-end-date')">
                    <div style="font-size:0.72rem; font-weight:800; color:#16a34a; display:flex; align-items:center; justify-content:center; gap:4px; text-transform:uppercase;">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/></svg>
                      END
                    </div>
                    <div style="font-size: 1.15rem; font-weight: 700; margin-top: 4px;" id="student-end-disp">--</div>
                    <div id="student-auto-badge" style="font-size: 0.7rem; font-weight: 800; color: #16a34a; letter-spacing: 0.05em; text-transform: uppercase;">AUTO</div>
                    <input type="date" id="student-end-date" style="position:absolute; opacity:0; width:1px; height:1px; pointer-events:none;" onchange="window.calculatePaymentAmount()" />
                  </div>
                </div>
              </div>

              <!-- DURATION SECTION -->
              <div style="margin-bottom: 1.25rem;">
                <label style="font-size: 0.72rem; font-weight: 800; color: var(--text-muted); text-transform: uppercase; margin-bottom: 0.5rem; display: block; letter-spacing:0.05em;">DURATION *</label>
                <div class="sp-duration-row" style="display:grid; grid-template-columns: 1.4fr 1fr; gap:10px; align-items:center;">
                  <div>
                    <select id="student-duration-mode" onchange="window.onStudentRenewalModeChange()" class="sp-input" style="width:100%; padding:10px; border-radius:8px;">
                      <option value="monthly" selected>📅 Monthly</option>
                      <option value="days">📅 Days</option>
                      <option value="custom">📅 Custom Date</option>
                    </select>
                  </div>
                  <div id="student-duration-val-wrap" style="display:flex; align-items:center; gap:8px;">
                    <input type="number" id="student-duration-val" min="1" value="1" class="sp-input" style="width:80px; padding:10px; border-radius:8px;" oninput="window.calculatePaymentAmount()" />
                    <span id="student-duration-unit" style="font-size:13px; font-weight:600; color:var(--text-muted);">month</span>
                  </div>
                </div>
              </div>

              <form onsubmit="event.preventDefault(); window.handlePaymentSubmit();" class="form-grid" style="gap: 1.25rem;">
                <!-- Payment Method Selector -->
                <div class="form-group full-width" style="margin-bottom: 0.25rem;">
                  <label style="font-size: 0.72rem; font-weight: 800; color: var(--text-muted); text-transform: uppercase; margin-bottom: 0.5rem; display: block; letter-spacing:0.05em;">PAYMENT METHOD *</label>
                  <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem;">
                    <!-- UPI Option -->
                    <label id="sp-paymethod-upi-label" style="display:flex; align-items:center; gap:8px; padding:10px 14px; border-radius:10px; border:2px solid var(--primary); background:rgba(14,165,233,0.08); cursor:pointer; font-weight:600; font-size:13.5px; color:var(--text-primary); transition:all 0.15s ease;">
                      <input type="radio" name="portal-payment-method" id="sp-paymethod-upi" value="UPI" checked onchange="window.onPaymentMethodChange('UPI')" style="accent-color:var(--primary); width:16px; height:16px;" />
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--primary);"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                      <span>Pay Online (UPI)</span>
                    </label>
                    <!-- Cash Option -->
                    <label id="sp-paymethod-cash-label" style="display:flex; align-items:center; gap:8px; padding:10px 14px; border-radius:10px; border:2px solid var(--border-bright); background:var(--bg-hover); cursor:pointer; font-weight:600; font-size:13.5px; color:var(--text-primary); transition:all 0.15s ease;">
                      <input type="radio" name="portal-payment-method" id="sp-paymethod-cash" value="Cash" onchange="window.onPaymentMethodChange('Cash')" style="accent-color:var(--primary); width:16px; height:16px;" />
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--accent-emerald, #10b981);"><rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/></svg>
                      <span>Pay with Cash</span>
                    </label>
                  </div>
                </div>

                <div class="form-group">
                  <label style="font-size: 0.75rem; font-weight: 600; color:var(--text-secondary); text-transform: uppercase;">Amount (₹)</label>
                  <div id="payment-amount-display" style="font-size: 1.25rem; font-weight: 700; color: var(--text-primary); padding: 6px 0;">₹--</div>
                  <input type="hidden" id="payment-amount" value="0" />
                </div>

                <!-- UPI Fields -->
                <div id="sp-upi-group" class="full-width" style="display:flex; flex-direction:column; gap:1.25rem;">
                  <div class="form-group full-width">
                    <label style="font-size: 0.75rem; font-weight: 600; color:var(--text-secondary); text-transform: uppercase;">UPI Transaction ID *</label>
                    <input type="text" id="payment-txnid" required class="sp-input" placeholder="Enter your 12-digit UPI Txn ID" />
                  </div>
                  <div class="form-group full-width">
                    <label style="font-size: 0.75rem; font-weight: 700; color:var(--text-primary); text-transform: uppercase; letter-spacing:0.04em;">Payment Screenshot (Required) *</label>
                    <input type="file" id="payment-ss" accept="image/*" required class="sp-input" style="padding:8px;" />
                    <small style="font-size:11.5px; color:var(--text-muted); display:block; margin-top:4px;">Upload 1 clear screenshot proof of your payment.</small>
                  </div>
                </div>

                <!-- Cash Notice -->
                <div id="sp-cash-group" class="form-group full-width" style="display:none;">
                  <div style="padding:1rem; border-radius:10px; background:rgba(16,185,129,0.08); border:1px solid rgba(16,185,129,0.3); color:var(--text-primary);">
                    <div style="display:flex; align-items:center; gap:8px; font-weight:700; font-size:14px; color:var(--accent-emerald, #10b981); margin-bottom:4px;">
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/></svg>
                      Cash Payment at Desk
                    </div>
                    <div style="font-size:13px; color:var(--text-secondary); line-height:1.45;">
                      Please hand over the exact cash amount to the receptionist. Your renewal request will be sent to the admin and approved as soon as cash is received at the desk.
                    </div>
                  </div>
                </div>

                <div class="form-group full-width sp-actions">
                  <button type="button" class="btn btn-ghost" title="Clear the transaction ID field" onclick="document.getElementById('payment-txnid').value=''">Clear</button>
                  <button type="submit" id="btn-submit-payment" class="btn btn-primary sp-pay-submit" style="background:#16a34a; border-color:#16a34a;">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:8px;"><path d="M23 4v6h-6"></path><path d="M1 20v-6h6"></path><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
                    Submit Renewal Request
                  </button>
                </div>
              </form>
            </div>

            <!-- RIGHT SIDE: QR Code / Cash Info -->
            <div class="sp-qr">
              <!-- UPI View -->
              <div id="sp-qr-upi-view" style="display:flex; flex-direction:column; align-items:center; gap:0.75rem; width:100%;">
                <h4 style="margin:0; font-size: 0.9rem; color:var(--text-secondary); text-align:center;">Scan to Pay</h4>
                <div style="width: 160px; height: 160px; background:var(--bg-card); border:1px solid var(--border); border-radius: 8px; display:flex; align-items:center; justify-content:center; overflow: hidden; padding:4px;">
                  <img src="" class="payment-qr-img" alt="Scan to Pay" style="width: 100%; height: 100%; object-fit: contain;" />
                </div>
                <p style="font-size: 0.75rem; color:var(--text-secondary); text-align: center; margin: 0; line-height: 1.4;">Pay using GPay, PhonePe, or Paytm and enter the Txn ID here.</p>
              </div>

              <!-- Cash View -->
              <div id="sp-qr-cash-view" style="display:none; flex-direction:column; align-items:center; gap:0.75rem; width:100%; text-align:center; padding:0.5rem 0;">
                <div style="width: 72px; height: 72px; border-radius: 50%; background: rgba(16,185,129,0.14); border: 2px solid rgba(16,185,129,0.35); display: flex; align-items: center; justify-content: center; color: var(--accent-emerald, #10b981); margin-top:0.5rem;">
                  <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="2"><rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/></svg>
                </div>
                <h4 style="margin:0; font-size: 1rem; color:var(--text-primary); font-weight:700;">Desk Payment</h4>
                <p style="font-size: 0.8rem; color:var(--text-secondary); line-height: 1.45; margin: 0;">Settle your payment directly in cash with the administrator at the study hall reception.</p>
                <div style="font-size: 0.75rem; font-weight:600; color:var(--accent-emerald, #10b981); padding: 4px 10px; background: rgba(16,185,129,0.1); border-radius: 999px;">Cash accepted at desk</div>
              </div>
            </div>

          </div>
        </div>


        <div class="card">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 1.25rem; flex-wrap:wrap; gap:8px;">
            <div>
              <h3 style="margin:0; font-size:1.15rem; font-weight:700;">Payment & Renewal History</h3>
              <div style="font-size:0.8rem; color:var(--text-muted); margin-top:2px;">Verified records of your admission and renewal payments</div>
            </div>
          </div>
          <div class="table-responsive">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Plan</th>
                  <th>Period</th>
                  <th>Amount</th>
                  <th>Txn ID</th>
                  <th>Status</th>
                  <th style="text-align:center;">Proof</th>
                </tr>
              </thead>
              <tbody>${unifiedHistoryHtml}</tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `;

  // 3. ATTENDANCE PAGE
  attendanceActionHtml = "";
  if (activeSession) {
    attendanceActionHtml = `<button class="btn btn-primary" id="btn-checkout" onclick="window.handleCheckOut('${activeSession.id}', ${activeSession.checkIn})" style="background:#ef4444; border:none; box-shadow:0 1px 2px rgba(239,68,68,0.2);">Check Out</button>`;
  } else {
    attendanceActionHtml = `
      <button class="btn btn-primary" id="btn-checkin" onclick="window.handleCheckIn()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" style="margin-right:6px;"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Check In
      </button>
    `;
  }

  document.getElementById("page-student-attendance").innerHTML = `
    <div class="page-header">
      <div>
        <h1>Attendance</h1>
        <p class="page-subtitle">Track your daily study hours.</p>
      </div>
      <div>
        ${attendanceActionHtml}
      </div>
    </div>
    
    <div class="sp-cols">
      <div class="card">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem; gap:0.75rem; flex-wrap:wrap;">
          <h3 style="margin:0;">Recent Attendance</h3>
          <button id="btn-pdf" class="btn btn-ghost" onclick="window.handleDownloadPDF()">Download PDF</button>
        </div>
        <div class="table-responsive"><table class="data-table"><thead><tr><th>Date</th><th>Check In</th><th>Check Out</th><th>Duration</th><th>Status</th></tr></thead><tbody>${historyHtml}</tbody></table></div>
      </div>
      <div class="card" style="padding: 1.5rem; text-align:center;">
        <h4 style="margin-bottom: 0.5rem; color: var(--text-muted);">Today's Hours</h4>
        <div style="font-size: 1.5rem; font-weight: 600; color: var(--primary);">${studyHours.todayHours}h</div>
      </div>
    </div>
  `;

  // 4. COMPLAINTS PAGE
  document.getElementById("page-student-complaints").innerHTML = `
    <div class="page-header">
      <div>
        <h1>Complaints</h1>
        <p class="page-subtitle">Report issues and track their resolution status.</p>
      </div>
    </div>
    
    <div class="sp-stack">
      <div class="sp-stack" style="margin-top:0;">
        <div class="card" style="border-left: 4px solid var(--danger); max-width: 640px; width: 100%; box-sizing: border-box;">
          <h3 style="margin-bottom: 1.5rem;">Report an Issue</h3>
          <form onsubmit="event.preventDefault(); window.handleComplaintSubmit();" class="form-grid">
            <div class="form-group full-width">
              <label>Category</label>
              <select id="complaint-category" class="sp-input" required>
                <option value="">Select an issue...</option>
                <option value="Noise">Noise</option>
                <option value="Light">Light</option>
                <option value="Fan">Fan</option>
                <option value="Charging Point">Charging Point</option>
                <option value="Furniture">Furniture</option>
                <option value="Cleaning">Cleaning</option>
                <option value="Washroom">Washroom</option>
                <option value="WiFi">WiFi</option>
                <option value="Others">Others</option>
              </select>
            </div>
            <div class="form-group full-width">
              <label>Description</label>
              <textarea id="complaint-description" rows="3" style="resize:none;" required placeholder="Describe the issue in detail..."></textarea>
            </div>
            <div class="form-group full-width" style="margin-top: 0.5rem;">
              <button type="submit" id="btn-submit-complaint" class="btn btn-primary">Submit Complaint</button>
            </div>
          </form>
        </div>
        <div class="card"><h3 style="margin-bottom: 1rem;">My Complaints</h3><div class="table-responsive"><table class="data-table"><thead><tr><th>Date</th><th>Category</th><th>Details</th><th>Status</th></tr></thead><tbody>${complaintsHtml}</tbody></table></div></div>
      </div>
    </div>
  `;

  // Paint the single live QR everywhere (upload once in Settings).
  import("./qrService.js").then(({ paintQrImages }) => paintQrImages()).catch(() => {});

  // Keep the notifications page (bell + sidebar) in sync with live data.
  try { renderStudentNotifications(); } catch (e) { console.warn("[portal] notifications render failed:", e); }

  // Load the student's own documents (same record the admin panel shows).
  try { loadOwnDocuments(); } catch (e) { console.warn("[portal] own documents failed:", e); }

  // Dashboard is fully painted — drop the boot cover so the real content shows.
  hideBoot();

  setTimeout(() => { if (window.calculatePaymentAmount) window.calculatePaymentAmount(); }, 50);
};

/**
 * Computes how many months of fees are unpaid and details of the oldest owed month.
 * If paymentDueDate is in the past, the student owes months from the day after dueDate up to today.
 * Each call to this enforces sequential payment: student must pay the oldest month first.
 */
const computeUnpaidMonths = (paymentDueDateStr) => {
  if (!paymentDueDateStr) return { monthsOwed: 0, nextMonthLabel: '', nextStartStr: 'Today', nextEndStr: '--' };
  const dueDate = new Date(paymentDueDateStr);
  if (isNaN(dueDate.getTime())) return { monthsOwed: 0, nextMonthLabel: '', nextStartStr: 'Today', nextEndStr: '--' };
  dueDate.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (dueDate >= today) {
    // Student is up to date — no owed months
    return {
      monthsOwed: 0,
      nextMonthLabel: '',
      nextStartStr: dueDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
      nextEndStr: '--'
    };
  }

  // Due date is in the past — compute how many full billing months have elapsed
  const firstUnpaid = new Date(dueDate);
  firstUnpaid.setDate(firstUnpaid.getDate() + 1); // Day after last paid day

  let monthsOwed = 0;
  let checkDate = new Date(firstUnpaid);
  while (checkDate <= today) {
    monthsOwed++;
    checkDate.setMonth(checkDate.getMonth() + 1);
  }

  // Label and date strings for the first owed payment period
  const nextMonthLabel = firstUnpaid.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const nextStartStr = firstUnpaid.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const nextEnd = new Date(dueDate);
  nextEnd.setMonth(nextEnd.getMonth() + 1);
  const nextEndStr = nextEnd.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

  return { monthsOwed, nextMonthLabel, nextStartStr, nextEndStr };
};

const calculateDaysRemaining = (dueDateStr) => {
  if (!dueDateStr) return 0;
  const due = new Date(dueDateStr);
  const now = new Date();
  const diffTime = due - now;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays > 0 ? diffDays : 0;
};

// Real subscription text: "1 month left" / "15 days left" /
// "1 month 15 days left". Pure display over the day count — the stored
// paymentDueDate is untouched.
const formatSubscriptionLeft = (totalDays) => {
  const t = Math.max(0, Math.ceil(Number(totalDays) || 0));
  if (t <= 0) return "Expired";
  if (t < 30) return `${t} day${t === 1 ? "" : "s"} left`;
  const months = Math.floor(t / 30);
  const days = t % 30;
  if (days === 0) return `${months} month${months === 1 ? "" : "s"} left`;
  return `${months} month${months === 1 ? "" : "s"} ${days} day${days === 1 ? "" : "s"} left`;
};
