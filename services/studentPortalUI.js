import { listenToStudentPortalData, updateStudentOwnProfile } from "./studentPortalService.js";
import { listenToMyAttendance, checkIn, checkOut } from "./attendanceService.js?v=seat1";
import { calculateStudyHours } from "./studyHourCalculator.js";
import { generateAttendancePDF } from "./pdfService.js";
import { listenToMyPayments, submitPaymentRequest } from "./paymentService.js";
import { listenToMyComplaints, submitComplaint } from "./complaintService.js?v=ui2";
import { listenToRenewalHistory } from "./renewalService.js";
import { getSettings } from "./settingsService.js?v=ui1";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "../firebase/firebase.js";

let currentStudent = null;
let currentAttendance = [];
let currentPayments = [];
let currentComplaints = [];
let currentRenewals = [];
let unsubscribePortal = null;
let unsubscribeAttendance = null;
let unsubscribePayments = null;
let unsubscribeComplaints = null;
let unsubscribeRenewals = null;

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

  unsubscribePortal = listenToStudentPortalData(async (studentData) => {
    currentStudent = studentData;

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

    // Desk announcements for the notifications bell (student-safe renderer).
    subscribeStudentAnnouncements();

    renderPortal();
  }, (errorMsg) => {
    portalSection.innerHTML = `<div style="padding: 2rem; color: var(--danger); text-align: center;">${errorMsg}</div>`;
  });

  window.handleCheckIn = async () => {
    if (!currentStudent) {
      window.showToast("Profile still loading. Please wait a moment and try again.", "warning");
      return;
    }
    if (currentStudent.status !== "Active") {
      window.showToast("Membership is not active. Please clear dues or contact the desk.", "error");
      return;
    }
    // Seat-first check-in: EVERY student picks the seat they will use —
    // no auto check-in to an assigned seat, no plan-based shortcuts.
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
      const { initSeatMapUI } = await import("./seatMapUI.js?v=ui1");
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

    if (!selectedSeatId || !selectedSeatNumber) {
      window.showToast("Please select a seat from the map to check in.", "warning");
      return;
    }
    if (!currentStudent) {
      window.showToast("Profile still loading. Please wait and try again.", "warning");
      return;
    }

    const btn = document.getElementById("btn-confirm-checkin");
    const originalText = btn ? btn.innerHTML : "";
    if (btn) { btn.innerHTML = "Processing..."; btn.disabled = true; }

    try {
      const res = await checkIn(currentStudent, selectedSeatNumber);
      if (!res.success) {
        window.showToast("Check-In Failed: " + res.error, "error");
      } else if (res.warning) {
        window.showToast("Checked in! " + res.warning, "warning");
        if (modal) modal.close();
      } else {
        window.showToast("Checked in successfully!", "success");
        if (modal) modal.close();
      }
    } catch (e) {
      window.showToast("Check-In Failed: " + (e.message || e), "error");
    } finally {
      if (btn) { btn.innerHTML = originalText; btn.disabled = false; }
    }
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

window.calculatePaymentAmount = async () => {
    if (!currentStudent) return;
    const { monthsOwed, nextStartStr, nextEndStr } = computeUnpaidMonths(currentStudent.paymentDueDate);
    const months = monthsOwed > 0 ? 1 : (parseInt(document.getElementById("payment-months")?.value) || 1);

    const basePrice = await getPlanPrice(currentStudent.planName);
    const total = basePrice * months;
    
    const amountDisplay = document.getElementById("payment-amount-display");
    const amountInput = document.getElementById("payment-amount");
    if (amountDisplay) amountDisplay.innerText = `₹${total}`;
    if (amountInput) amountInput.value = total;

    const startEl = document.getElementById("payment-start-date");
    const endEl = document.getElementById("payment-end-date");
    if (monthsOwed > 0) {
      if (startEl) startEl.innerText = nextStartStr;
      if (endEl) endEl.innerText = nextEndStr;
    } else {
      let startDate = new Date();
      if (currentStudent.paymentDueDate) {
        const parsed = new Date(currentStudent.paymentDueDate);
        if (!isNaN(parsed.getTime())) startDate = parsed;
      }
      const endDate = new Date(startDate);
      endDate.setMonth(endDate.getMonth() + months);
      if (startEl) startEl.innerText = startDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
      if (endEl) endEl.innerText = endDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    }
  };

  window.handlePaymentSubmit = async () => {
    const btn = document.getElementById("btn-submit-payment");
    const txnId = document.getElementById("payment-txnid").value;

    if (!txnId) return window.showToast(window.t ? window.t('Please enter the Transaction ID.') || "Please enter the Transaction ID." : "Please enter the Transaction ID.", "error");

    const { monthsOwed, nextMonthLabel } = computeUnpaidMonths(currentStudent?.paymentDueDate);
    const months = monthsOwed > 0 ? 1 : (parseInt(document.getElementById("payment-months")?.value) || 1);
    const amount = document.getElementById("payment-amount").value;
    const monthLabel = monthsOwed > 0 ? nextMonthLabel : null;

    btn.innerHTML = "Submitting...";
    btn.disabled = true;

    const res = await submitPaymentRequest(currentStudent, txnId, months, amount, monthLabel);
    if (res.success) {
      window.showToast(window.t ? window.t('Payment Request Submitted Successfully!') || "Payment Request Submitted Successfully!" : "Payment Request Submitted Successfully!", "success");
      document.getElementById("payment-txnid").value = "";
    } else {
      window.showToast("Failed: " + res.error, "error");
    }

    btn.innerHTML = "Submit Payment Request";
    btn.disabled = false;
  };

  window.handleComplaintSubmit = async () => {
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
      window.showToast(window.t ? window.t('Failed: ') || "Failed: " : "Failed: " + res.error, "error");
    }

    btn.innerHTML = "Submit Complaint";
    btn.disabled = false;
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
const S_BASE_TITLE = (typeof document !== "undefined" && document.title) || "Studyhaus";
let __sNotifFirst = true;
let __sKnownIds = new Set();

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
  } else {
    dot.style.display = "none";
    dot.textContent = "";
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

  // Only announcements whose schedule has arrived (no date = immediate).
  const annLive = (a) => {
    if (!a || !a.scheduledFor) return true;
    const t = new Date(a.scheduledFor).getTime();
    return Number.isNaN(t) || t <= Date.now();
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
  // beep + toast when genuinely new items arrive (skip first render).
  sPaintBell(totalUnread);
  sPaintTab(totalUnread);
  const currentIds = [];
  if (monthsOwed > 0 && !isRead("due")) currentIds.push("due");
  pendings.forEach(p => { if (!isRead(`pay_${p.id}`)) currentIds.push(`pay_${p.id}`); });
  opens.forEach(c => currentIds.push(c.resolutionNote ? `creply_${c.id}` : `copen_${c.id}`));
  visible.forEach(a => { if (!isRead(`ann_${a.id}`)) currentIds.push(`ann_${a.id}`); });
  if (!__sNotifFirst) {
    const fresh = currentIds.filter((id) => !__sKnownIds.has(id));
    if (fresh.length > 0) {
      sBeep();
      if (typeof window.showToast === "function") {
        window.showToast(`🔔 You have ${fresh.length} new notification${fresh.length > 1 ? "s" : ""} — tap the bell.`, "info");
      }
    }
  }
  __sNotifFirst = false;
  __sKnownIds = new Set(currentIds);

  const toggle = dismissedCount > 0
    ? `<div style="text-align:center; padding:0.5rem;"><button class="btn btn-ghost btn-sm" onclick="window.toggleStudentReadNotifs()">${showReadStudent ? "Hide read" : `Show dismissed (${dismissedCount})`}</button></div>`
    : "";

  if (!personal && !broadcast) {
    list.innerHTML = `<div style="text-align:center; padding:2.5rem 1rem; color:var(--text-muted);">
      <div style="font-size:2rem; margin-bottom:0.5rem;">🔔</div>
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

const renderPortal = () => {
  if (!currentStudent) return;
  // Listeners attach async — render as soon as the profile lands, using empty
  // arrays for sections that haven't delivered yet.
  if (!Array.isArray(currentAttendance)) currentAttendance = [];
  if (!Array.isArray(currentPayments)) currentPayments = [];
  if (!Array.isArray(currentComplaints)) currentComplaints = [];
  if (!Array.isArray(currentRenewals)) currentRenewals = [];
  const s = currentStudent;
  const portalSection = document.getElementById("page-student-portal");
  const initials = s.name ? s.name.substring(0, 2).toUpperCase() : "ST";
  const daysRemaining = calculateDaysRemaining(s.paymentDueDate);

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

  let paymentsHtml = "";
  if (currentPayments.length === 0) {
    paymentsHtml = `<tr><td colspan="5" style="text-align:center; color: var(--text-muted);">No payment history.</td></tr>`;
  } else {
    currentPayments.forEach(p => {
      let badgeClass = "badge-pending";
      if (p.status === "approved" || p.status === "Completed") badgeClass = "badge-paid";
      if (p.status === "rejected") badgeClass = "badge-absent";
      const pDate = p.date ? new Date(p.date).toLocaleDateString() : "—";
      const pPeriod = p.renewalPeriod != null && p.renewalPeriod !== "" ? `${p.renewalPeriod} Mo.` : (p.monthLabel || "—");
      const pTxn = p.transactionId || "—";
      const pStatus = String(p.status || "pending").toUpperCase();
      paymentsHtml += `<tr><td>${pDate}</td><td>${pPeriod}</td><td>₹${Number(p.amount) || 0}</td><td>${pTxn}</td><td><span class="badge ${badgeClass}">${pStatus}</span></td></tr>`;
    });
  }

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

  let renewalsHtml = "";
  if (currentRenewals.length === 0) {
    renewalsHtml = `<tr><td colspan="4" style="text-align:center; color: var(--text-muted);">No renewal history.</td></tr>`;
  } else {
    currentRenewals.forEach(r => {
      const dateStr = r.createdAt && r.createdAt.seconds ? new Date(r.createdAt.seconds * 1000).toLocaleDateString() : "Just now";
      renewalsHtml += `
        <tr>
          <td>${dateStr}</td>
          <td>${r.newPlan || "—"}</td>
          <td style="font-size:0.85rem;">${r.startDate || "—"} to ${r.endDate || "—"}</td>
          <td class="amount">₹${Number(r.amount) || 0}</td>
        </tr>
      `;
    });
  }

  let attendanceActionHtml = "";
  if (activeSession) {
    attendanceActionHtml = `<button id="btn-checkout" class="btn" style="background: #ef4444 !important; color: #ffffff !important; border: none; box-shadow: 0 1px 2px rgba(239,68,68,0.2);" onclick="window.handleCheckOut('${activeSession.id}', ${activeSession.checkIn})">Check-Out Now</button>`;
  } else {
    attendanceActionHtml = `<button id="btn-checkin" class="btn" style="background: var(--primary) !important; color: #ffffff !important; border: none;" onclick="window.handleCheckIn()">Check-In Now</button>`;
  }

  // 1. DASHBOARD PAGE (Overview)
  const hasPendingAdmission = sessionStorage.getItem('pendingName') || sessionStorage.getItem('pendingPlan');
  if (s._isNewUser || hasPendingAdmission) {
    // New user or came from website -> Show admission form
    portalSection.innerHTML = `
      <div class="page-header" style="margin-bottom: 1.5rem;">
        <div>
          <h1>Complete Your Admission</h1>
          <p class="page-subtitle">Please fill out the admission form to enroll in a plan.</p>
        </div>
      </div>
      <div class="sp-admit-wrap">
        <div class="card sp-admit-form" style="padding: 2rem; border-radius: 12px; background:var(--bg-card); border:1px solid var(--border);">
          <form id="admission-form" onsubmit="event.preventDefault(); window.showPaymentModal(); return false;">
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; margin-bottom: 1.5rem;">
              <div class="form-group" style="margin:0;"><label style="font-size: 13px; font-weight: 600; display: block; margin-bottom: 6px;">Full name <span style="color:#e53e3e;">*</span></label><input type="text" id="adm-name" required style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid var(--border);" value="${sessionStorage.getItem('pendingName') || s.name || ''}" /></div>
              <div class="form-group" style="margin:0;"><label style="font-size: 13px; font-weight: 600; display: block; margin-bottom: 6px;">Mobile <span style="color:#e53e3e;">*</span></label><input type="tel" pattern="[0-9]{10}" id="adm-phone" required style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid var(--border);" value="${sessionStorage.getItem('pendingPhone') || s.phone || ''}" /></div>
              <div class="form-group" style="margin:0;"><label style="font-size: 13px; font-weight: 600; display: block; margin-bottom: 6px;">Parent mobile</label><input type="tel" pattern="[0-9]{10}" id="adm-parent-phone" style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid var(--border);" value="${s.parentPhone || ''}" /></div>
              <div class="form-group" style="margin:0;"><label style="font-size: 13px; font-weight: 600; display: block; margin-bottom: 6px;">Email <span style="color:#e53e3e;">*</span></label><input type="email" id="adm-email" required style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg-card);" value="${sessionStorage.getItem('pendingEmail') || s.email || ''}" readonly /></div>
              <div class="form-group" style="margin:0;"><label style="font-size: 13px; font-weight: 600; display: block; margin-bottom: 6px;">Date of birth <span style="color:#e53e3e;">*</span></label><input type="date" id="adm-dob" style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid var(--border);" value="${s.dob || ''}" required /></div>
              <div class="form-group" style="margin:0;"><label style="font-size: 13px; font-weight: 600; display: block; margin-bottom: 6px;">Gender <span style="color:#e53e3e;">*</span></label>
                <select id="adm-gender" required style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg-card);">
                  <option value="">Select</option><option value="Male" ${s.gender === 'Male' ? 'selected' : ''}>Male</option><option value="Female" ${s.gender === 'Female' ? 'selected' : ''}>Female</option><option value="Other" ${s.gender === 'Other' ? 'selected' : ''}>Other</option>
                </select>
              </div>
              <div class="form-group" style="margin:0;"><label style="font-size: 13px; font-weight: 600; display: block; margin-bottom: 6px;">College / Institute</label><input type="text" id="adm-college" style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid var(--border);" value="${s.college || ''}" /></div>
              <div class="form-group" style="margin:0;"><label style="font-size: 13px; font-weight: 600; display: block; margin-bottom: 6px;">Course</label><input type="text" id="adm-course" style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid var(--border);" value="${s.course || ''}" /></div>
              <div class="form-group" style="grid-column: 1 / -1; margin:0;"><label style="font-size: 13px; font-weight: 600; display: block; margin-bottom: 6px;">Remarks / Exam Goal</label><textarea id="adm-remarks" rows="2" style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid var(--border);">${sessionStorage.getItem('pendingMessage') || s.remarks || ''}</textarea></div>
              <div class="form-group" style="margin:0; grid-column: 1 / -1;"><label style="font-size: 13px; font-weight: 600; display: block; margin-bottom: 6px;">Membership plan <span style="color:#e53e3e;">*</span></label>
                <select id="adm-plan" required onchange="window.updateSummary()" style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg-card);">
                  <option value="">Choose plan (Loading...)</option>
                </select>
              </div>
            </div>

            <h3 style="font-size: 15px; margin: 0 0 1rem;">Seat Selection *</h3>
            <div id="seat-selection-section" style="margin-bottom: 2rem; border: 1px solid var(--border-bright); border-radius: 12px; padding: 1rem;"></div>
            <input type="hidden" id="selectedSeatNumber" />
            <input type="hidden" id="selectedSeatId" />
            
            <h3 style="font-size: 15px; margin: 0 0 1rem;">Document Uploads *</h3>
            <div id="doc-upload-section" style="margin-bottom: 1.5rem;"></div>

          </form>
        </div>
        <div class="sp-admit-side">
          <div class="card" style="padding: 1.5rem; background:var(--bg-hover); border:1px solid var(--border); border-radius: 12px; box-shadow: none;">
            <h4 style="font-size: 11px; font-weight: 700; color:var(--text-muted); letter-spacing: 0.5px; margin-bottom: 1rem;">SUMMARY</h4>
            <div style="display: flex; justify-content: space-between; font-size: 13px; color:var(--text-secondary); margin-bottom: 12px;"><span>Plan</span><span id="summary-plan" style="color:var(--text-primary); font-weight: 600;">—</span></div>
            <div style="display: flex; justify-content: space-between; font-size: 13px; color:var(--text-secondary); margin-bottom: 12px;"><span>Amount</span><span id="summary-amount" style="color:var(--text-primary); font-weight: 600;">—</span></div>
            <div class="sp-divider"></div>
            <button class="btn btn-primary" id="btn-submit-admission" onclick="document.getElementById('admission-form').requestSubmit()" style="width: 100%; padding: 12px; font-size: 14px;">Confirm Admission</button>
          </div>
        </div>
      </div>
      
      <!-- Payment Modal -->
      <dialog id="payment-modal" class="card" style="border:none; border-radius:12px; padding:0; box-shadow:0 10px 30px rgba(0,0,0,0.5); background: var(--bg-card); color: var(--text-primary); max-width: 450px; margin: auto;">
        <div style="padding: 1.5rem; border-bottom: 1px solid var(--borderBright); display: flex; justify-content: space-between; align-items: center;">
          <h2 style="font-size: 1.1rem; font-weight: 600; margin: 0;">Payment Options</h2>
          <button onclick="window.closePaymentModal()" style="background: none; border: none; font-size: 1.2rem; cursor: pointer; color: var(--text-muted);">&times;</button>
        </div>
        
        <!-- Step 1: Choose Pay Now or Pay Later -->
        <div id="payment-step-1" style="padding: 1.5rem; text-align: center;">
          <p style="margin-bottom: 1.5rem; color: var(--text-secondary); font-size: 0.95rem;">You can pay now to confirm your seat immediately, or pay later at the desk.</p>
          <div style="display: flex; gap: 1rem; justify-content: center;">
            <button class="btn btn-ghost" onclick="window.submitSelfAdmission('Pay Later')" style="flex: 1; border: 1px solid var(--borderBright);">Pay Later</button>
            <button class="btn btn-primary" onclick="window.showPaymentStep2()" style="flex: 1;">Pay Now</button>
          </div>
        </div>

        <!-- Step 2: Pay Now Form -->
        <div id="payment-step-2" style="padding: 1.5rem; display: none;">
          <div style="text-align: center; margin-bottom: 1.5rem;">
            <img src="" class="payment-qr-img" alt="Scan to Pay" style="width: 180px; height: 180px; object-fit: contain; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 0.5rem;" />
            <div style="font-weight: 600; color: var(--text-primary);">Scan to Pay: <span id="payment-modal-amount" style="color: var(--primary);">₹--</span></div>
          </div>
          <div class="form-group">
            <label>Transaction ID *</label>
            <input type="text" id="modal-txnid" required style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid var(--border);" placeholder="Enter UPI Ref ID" />
          </div>
          <div class="form-group" style="margin-bottom: 1.5rem;">
            <div id="modal-doc-upload-section"></div>
          </div>
          <button class="btn btn-primary" id="btn-modal-paid" onclick="window.submitSelfAdmission('Paid')" style="width: 100%;">Mark as Paid & Submit</button>
        </div>
      </dialog>
    `;

    // Hide sidebars since they shouldn't access other pages yet
    const navItems = document.querySelectorAll('.sidebar-nav .nav-item');
    navItems.forEach(item => {
      if (item.getAttribute('data-page') !== 'student-portal') {
        item.style.display = 'none';
      }
    });

    // We must manually trigger initAdmissionsUI logic for dropdowns since we are in the student portal view
    import("./admissionService.js").then(({ fetchPlansForDropdown, submitAdmission }) => {
      window.submitAdmission = submitAdmission;
      fetchPlansForDropdown(true).then(plans => {
        window.availablePlansList = plans;
        const planSelect = document.getElementById("adm-plan");
        if (planSelect) {
          let html = "<option value=''>Choose plan</option>";
          plans.forEach(p => { html += `<option value="${p.id}">${(p.planName || '').toLowerCase()} - ₹${p.price}</option>`; });
          planSelect.innerHTML = html;

          const savedPlan = sessionStorage.getItem('pendingPlan');
          if (savedPlan) {
            // Find a plan where planName includes savedPlan or matches it roughly
            const matchedPlan = plans.find(p => p.planName.toLowerCase().includes(savedPlan.toLowerCase()) || savedPlan.toLowerCase().includes(p.planName.toLowerCase()));
            if (matchedPlan) {
              planSelect.value = matchedPlan.id;
              window.updateSummary();
            }
          }
        }
      });
    });

    import("./seatMapUI.js?v=ui1").then(({ initSeatMapUI }) => {
      initSeatMapUI("signup", "seat-selection-section");
    });

    import("./documentUploadService.js").then(({ initDocumentUploads, getSelectedDocumentFiles, uploadAdmissionDocuments }) => {
      window.getSelectedDocumentFiles = getSelectedDocumentFiles;
      window.uploadAdmissionDocuments = uploadAdmissionDocuments;
      initDocumentUploads("doc-upload-section");
    });

    // Add logic for modal flow
    window.showPaymentModal = async () => {
      const selectedSeatId = document.getElementById("selectedSeatId")?.value;
      if (!selectedSeatId && !s.seatNumber) {
        return window.showToast(window.t ? window.t('Please select a seat from the Seat Map.') || "Please select a seat from the Seat Map." : "Please select a seat from the Seat Map.", "error");
      }

      // Document uploads are now optional

      const btnSubmit = document.getElementById("btn-submit-admission");
      const originalText = btnSubmit.innerHTML;
      btnSubmit.innerHTML = "Reserving Seat...";
      btnSubmit.disabled = true;

      try {
        if (selectedSeatId) {
          const { assignSeat } = await import("./seatService.js");
          const studentName = document.getElementById("adm-name").value || "New Student";
          await assignSeat(selectedSeatId, { id: s.id, name: studentName });
        }
      } catch (e) {
        btnSubmit.innerHTML = originalText;
        btnSubmit.disabled = false;
        return window.showToast(window.t ? window.t('Failed to reserve seat: ') || "Failed to reserve seat: " : "Failed to reserve seat: " + e.message, "error");
      }

      btnSubmit.innerHTML = originalText;
      btnSubmit.disabled = false;

      const modal = document.getElementById("payment-modal");
      document.getElementById("payment-step-1").style.display = "block";
      document.getElementById("payment-step-2").style.display = "none";

      const amount = document.getElementById("summary-amount").innerText;
      document.getElementById("payment-modal-amount").innerText = amount;

      modal.showModal();
    };

    window.closePaymentModal = async () => {
      const modal = document.getElementById("payment-modal");
      modal.close();
      const selectedSeatId = document.getElementById("selectedSeatId")?.value;
      if (selectedSeatId) {
        try {
          const { unassignSeat } = await import("./seatService.js");
          await unassignSeat(selectedSeatId);
          window.showToast(window.t ? window.t('Seat reservation released.') || "Seat reservation released." : "Seat reservation released.", "info");
        } catch (e) {
          console.error("Failed to release seat on cancel", e);
        }
      }
    };

    window.showPaymentStep2 = () => {
      document.getElementById("payment-step-1").style.display = "none";
      document.getElementById("payment-step-2").style.display = "block";
    };

    window.submitSelfAdmission = async (paymentMethod) => {
      let txnId = "";

      try {
        if (paymentMethod === "Paid") {
          txnId = document.getElementById("modal-txnid").value;
          if (!txnId) return window.showToast(window.t ? window.t('Please enter Transaction ID.') || "Please enter Transaction ID." : "Please enter Transaction ID.", "warning");

          const btn = document.getElementById("btn-modal-paid");
          btn.innerHTML = "Uploading & Submitting...";
          btn.disabled = true;
        } else {
          const btn = document.querySelector("#payment-step-1 button.btn-ghost");
          btn.innerHTML = "Submitting...";
          btn.disabled = true;
        }

        // Upload Admission Documents first if present (single photo + ID proofs)
        let docUrls = {};
        if (window.getSelectedDocumentFiles && window.uploadAdmissionDocuments) {
          const files = window.getSelectedDocumentFiles();
          if (files.aadhaarFront || files.aadhaarBack || files.photo) {
            docUrls = await window.uploadAdmissionDocuments(files, s.id);
          }
        }

        // Collect form data
        const planEl = document.getElementById("adm-plan");
        const planId = planEl.value;
        const plan = (window.availablePlansList || []).find(p => p.id === planId);

        const selectedSeatNumber = document.getElementById("selectedSeatNumber")?.value || "";
        const selectedSeatId = document.getElementById("selectedSeatId")?.value || "";

        const data = {
          name: document.getElementById("adm-name").value,
          phone: document.getElementById("adm-phone").value,
          email: (document.getElementById("adm-email")?.value || "").trim().toLowerCase(),
          dob: document.getElementById("adm-dob")?.value || "",
          gender: document.getElementById("adm-gender")?.value || "",
          parentPhone: document.getElementById("adm-parent-phone")?.value || "",
          college: document.getElementById("adm-college")?.value || "",
          course: document.getElementById("adm-course")?.value || "",
          address: document.getElementById("adm-address")?.value || "",
          planId: planId,
          planName: plan ? plan.planName : "",
          seatNumber: selectedSeatNumber,
          seatId: selectedSeatId,
          paymentMethod: paymentMethod,
          transactionId: txnId,
          paymentScreenshotUrl: "",
          documents: docUrls,
          loginCredentials: s.loginCredentials || "",
          termsAccepted: true
        };

        if (paymentMethod === "Pay Later") {
          const d = new Date();
          d.setDate(d.getDate() + 3);
          data.paymentDueDate = d.toISOString().split('T')[0];
        }

        if (window.submitAdmission) {
          // Note: window.submitAdmission takes (data, isSelfAdmission) as arguments
          // wait, let me check admissionService.js
          const res = await window.submitAdmission(data, true);
          if (res.success) {
            // Upgrade seat status to Occupied
            if (selectedSeatId) {
              try {
                const { changeSeatStatus } = await import("./seatService.js");
                await changeSeatStatus(selectedSeatId, "Occupied");
              } catch (e) {
                console.error("Failed to mark seat as occupied", e);
              }
            }
            // Website requests ALWAYS stay Pending until an admin approves —
            // even when paid now. The admin decides in Pending approval.
            if (paymentMethod === "Paid") {
              window.showToast(window.t ? window.t('Payment received! Your request is now Pending Approval — the admin will confirm your admission.') || "Payment received! Your request is now Pending Approval — the admin will confirm your admission." : "Payment received! Your request is now Pending Approval — the admin will confirm your admission.", "success");
            } else {
              window.showToast(window.t ? window.t('Admission request submitted successfully and is Pending Approval!') || "Admission request submitted successfully and is Pending Approval!" : "Admission request submitted successfully and is Pending Approval!", "success");
            }
            document.getElementById("payment-modal").close();
            sessionStorage.removeItem('pendingName');
            sessionStorage.removeItem('pendingPhone');
            sessionStorage.removeItem('pendingEmail');
            sessionStorage.removeItem('pendingPlan');
            sessionStorage.removeItem('pendingMessage');
            window.location.reload(); // reload to show pending or active state
          } else {
            window.showToast((window.t ? window.t('Error: ') : "Error: ") + res.error, "error");
            document.getElementById("payment-modal").close();
            if (paymentMethod === "Paid") {
              const btn = document.getElementById("btn-modal-paid");
              btn.innerHTML = "Mark as Paid & Submit";
              btn.disabled = false;
            } else {
              const btn = document.querySelector("#payment-step-1 button.btn-ghost");
              btn.innerHTML = "Pay Later";
              btn.disabled = false;
            }
          }
        }
      } catch (err) {
        window.showToast((window.t ? window.t('An unexpected error occurred: ') : "An unexpected error occurred: ") + err.message, "error");
        if (paymentMethod === "Paid") {
          const btn = document.getElementById("btn-modal-paid");
          if (btn) { btn.innerHTML = "Mark as Paid & Submit"; btn.disabled = false; }
        } else {
          const btn = document.querySelector("#payment-step-1 button.btn-ghost");
          if (btn) { btn.innerHTML = "Pay Later"; btn.disabled = false; }
        }
      }
    };

  } else if (s._isPendingAdmission) {
    // Pending admission state
    portalSection.innerHTML = `
      <div class="page-header" style="margin-bottom: 1.5rem; justify-content: center; text-align: center;">
        <div>
          <h1 style="color: var(--warning);">Admission Pending Approval</h1>
          <p class="page-subtitle" style="margin-top: 0.5rem;">Your admission details have been submitted and are waiting for admin approval. Please check back later or contact the desk.</p>
        </div>
      </div>
      <div style="display: flex; justify-content: center;">
        <div class="card" style="padding: 2rem; max-width: 500px; text-align: center; border-radius: 12px; background:var(--bg-card); border:1px solid var(--border);">
           <div style="font-size: 3rem; margin-bottom: 1rem;">⏳</div>
           <h3 style="margin-bottom: 1rem; color:var(--text-primary);">What's next?</h3>
           <ul style="text-align: left; color:var(--text-secondary); font-size: 0.95rem; line-height: 1.5; padding-left: 1.5rem;">
             <li>The admin will verify your details and payment.</li>
             <li>Once approved, you will get access to the portal.</li>
             <li>If you chose "Pay Later", please visit the desk, or pay online below.</li>
           </ul>
           <button class="btn btn-primary" style="margin-top: 1rem; width: 100%;" onclick="window.showPendingPaymentModal()">Pay Now Online</button>
        </div>
      </div>

      <!-- Payment Modal for Pending State -->
      <dialog id="pending-payment-modal" class="card" style="border:none; border-radius:12px; padding:0; box-shadow:0 10px 30px rgba(0,0,0,0.5); background: var(--bg-card); color: var(--text-primary); max-width: 450px; margin: auto;">
        <div style="padding: 1.5rem; border-bottom: 1px solid var(--borderBright); display: flex; justify-content: space-between; align-items: center;">
          <h2 style="font-size: 1.1rem; font-weight: 600; margin: 0;">Pay Now</h2>
          <button onclick="document.getElementById('pending-payment-modal').close()" style="background: none; border: none; font-size: 1.2rem; cursor: pointer; color: var(--text-muted);">&times;</button>
        </div>
        
        <!-- Step 2: Pay Now Form (Directly) -->
        <div id="pending-payment-step-2" style="padding: 1.5rem;">
          <div style="text-align: center; margin-bottom: 1.5rem;">
            <img src="" class="payment-qr-img" alt="Scan to Pay" style="width: 180px; height: 180px; object-fit: contain; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 0.5rem;" />
            <div style="font-weight: 600; color: var(--text-primary);">Scan to Pay</div>
          </div>
          <div class="form-group">
            <label>Transaction ID *</label>
            <input type="text" id="pending-modal-txnid" required style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid var(--border);" placeholder="Enter UPI Ref ID" />
          </div>
          <div class="form-group" style="margin-bottom: 1.5rem;">
            <div id="pending-modal-doc-upload-section"></div>
          </div>
          <button class="btn btn-primary" id="btn-pending-modal-paid" onclick="window.submitPendingPayment()" style="width: 100%;">Mark as Paid & Submit</button>
        </div>
      </dialog>
    `;

    window.showPendingPaymentModal = () => {
      document.getElementById('pending-payment-modal').showModal();
      import("./documentUploadService.js").then(({ initDocumentUploads, getSelectedDocumentFiles, uploadAdmissionDocuments }) => {
        window.getSelectedDocumentFiles = getSelectedDocumentFiles;
        window.uploadAdmissionDocuments = uploadAdmissionDocuments;
        initDocumentUploads("pending-modal-doc-upload-section");
        setTimeout(() => {
          const d1 = document.getElementById('doc-card-aadhaarFront');
          const d2 = document.getElementById('doc-card-aadhaarBack');
          const d3 = document.getElementById('doc-card-photo');
          if (d1) d1.style.display = 'none';
          if (d2) d2.style.display = 'none';
          if (d3) {
            d3.style.gridColumn = "1 / -1";
            const lbl = d3.querySelector('div[style*="font-size:12px"]');
            if (lbl) lbl.textContent = "Payment Screenshot (Optional)";
            const icon = d3.querySelector('div[style*="font-size:1.5rem"], div[style*="justify-content:center"]');
            if (icon) icon.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><line x1="8" x2="16" y1="8" y2="8"/><line x1="8" x2="16" y1="12" y2="12"/><line x1="8" x2="13" y1="16" y2="16"/></svg>';
          }
        }, 100);
      });
    };

    window.submitPendingPayment = async () => {
      const txnId = document.getElementById("pending-modal-txnid").value;
      if (!txnId) return window.showToast(window.t ? window.t('Please enter Transaction ID.') || "Please enter Transaction ID." : "Please enter Transaction ID.", "warning");

      const btn = document.getElementById("btn-pending-modal-paid");
      btn.innerHTML = "Uploading & Submitting...";
      btn.disabled = true;

      let paymentScreenshotUrl = "";
      if (window.getSelectedDocumentFiles && window.uploadAdmissionDocuments) {
        const files = window.getSelectedDocumentFiles();
        // Store as `paymentScreenshot` (NOT the student photo) so paying
        // never overwrites the student's single photo.
        if (files.photo) {
          const urlMap = await window.uploadAdmissionDocuments({ paymentScreenshot: files.photo }, s.id);
          paymentScreenshotUrl = urlMap.paymentScreenshotUrl || "";
        }
      }

      import("./admissionService.js").then(async ({ updateAdmissionPayment }) => {
        const res = await updateAdmissionPayment(s.id, txnId, paymentScreenshotUrl);
        if (res.success) {
          window.showToast(window.t ? window.t('Payment details updated successfully!') || "Payment details updated successfully!" : "Payment details updated successfully!", "success");
          document.getElementById("pending-payment-modal").close();
          window.location.reload();
        } else {
          window.showToast((window.t ? window.t('Error: ') : "Error: ") + res.error, "error");
          btn.innerHTML = "Mark as Paid & Submit";
          btn.disabled = false;
        }
      });
    };

    // Hide sidebars since they shouldn't access other pages yet
    const navItems = document.querySelectorAll('.sidebar-nav .nav-item');
    navItems.forEach(item => {
      if (item.getAttribute('data-page') !== 'student-portal') {
        item.style.display = 'none';
      }
    });

  } else {
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
    const seatLabel = activeSession ? (activeSession.seatNumber || "—") : (s.seatNumber || "Not assigned");
    const dueLabel = s.paymentDueDate
      ? new Date(s.paymentDueDate).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "N/A";
    const dueUrgent = daysRemaining <= 5;

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
          <div class="metric-icon ${activeSession ? "emerald" : "amber"}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg></div>
          <div>
            <div class="metric-label">Right now</div>
            <div class="metric-value" style="font-size:1.15rem;">${activeSession ? "Checked in" : "Not checked in"}</div>
            <div style="font-size:0.78rem; color:var(--text-muted); margin-top:2px;">${activeSession ? `Seat ${seatLabel} · since ${checkinSince}` : (s.seatNumber ? `Your seat: ${s.seatNumber}` : "Pick any free seat at check-in")}</div>
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
          <div class="metric-icon ${dueUrgent ? "red" : "teal"}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"></rect><line x1="2" y1="10" x2="22" y2="10"></line></svg></div>
          <div>
            <div class="metric-label">Subscription</div>
            <div class="metric-value" style="font-size:1.15rem; color:${dueUrgent ? "var(--danger)" : "inherit"};">${daysRemaining} days left</div>
            <div style="font-size:0.78rem; color:var(--text-muted); margin-top:2px;">Due ${dueLabel}${pendingPayments.length ? ` · ${pendingPayments.length} payment${pendingPayments.length > 1 ? "s" : ""} pending` : " · all clear"}</div>
          </div>
        </div>
      </div>
      
      <div class="dashboard-grid" style="margin-top: 1.25rem;">
        <div class="card">
          <div class="card-header"><h3>Recent check-ins</h3><button class="btn btn-ghost btn-sm" onclick="navigate('student-attendance')">View all</button></div>
          ${currentAttendance.length === 0
            ? `<div style="text-align:center; color:var(--text-muted); padding:1.5rem 0;">No check-ins yet — use Check-In Now when you arrive.</div>`
            : `<table class="data-table"><thead><tr><th>Date</th><th>Seat</th><th>In</th><th>Out</th><th>Status</th></tr></thead><tbody>${currentAttendance.slice(0, 5).map(r => {
                const cIn = r.checkIn ? new Date(r.checkIn).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
                const cOut = r.checkOut ? new Date(r.checkOut).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : (r.status === "Active" ? "In now" : "—");
                const badge = r.status === "Active" ? `<span class="badge badge-pending">Active</span>` : `<span class="badge badge-paid">Done</span>`;
                return `<tr><td>${r.date || "—"}</td><td>${r.seatNumber || "—"}</td><td>${cIn}</td><td>${cOut}</td><td>${badge}</td></tr>`;
              }).join("")}</tbody></table>`}
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
              ? `<div style="font-size:0.85rem; color:var(--text-muted);">Last visit: ${lastSession.date || "—"}${lastSession.seatNumber ? ` · Seat ${lastSession.seatNumber}` : ""} · ${lastSession.duration ? lastSession.duration + "h" : "—"}.</div>`
              : ""}
        </div>
      </div>
      
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
                  <div class="sp-idcard-sub">Phone: ${s.phone || "—"}${s.seatNumber ? ` · Seat ${s.seatNumber}` : ""}</div>
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

              <!-- Payment Period -->
              <div style="margin-bottom: 1.5rem;">
                <label style="font-size: 0.75rem; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; margin-bottom: 0.5rem; display: block;">Payment Period</label>
                <div class="sp-alert ${_monthsOwed > 0 ? "sp-alert-warn" : "sp-alert-ok"}" style="padding:1.25rem 1.5rem; align-items:center; justify-content:space-between; margin-bottom:0;">
                  <div style="text-align: center; flex:1;">
                    <div class="sp-alert-title" style="font-size:0.75rem;">▶ START</div>
                    <div style="font-size: 1.1rem; font-weight: 700; margin-top: 6px;" id="payment-start-date">${_monthsOwed > 0 ? _nextStartStr : (s.paymentDueDate ? new Date(s.paymentDueDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : 'Today')}</div>
                  </div>
                  <div style="font-size: 1.5rem; margin: 0 1rem; user-select: none; opacity:0.6;">→</div>
                  <div style="text-align: center; flex:1;">
                    <div class="sp-alert-title" style="font-size:0.75rem;">■ END</div>
                    <div style="font-size: 1.1rem; font-weight: 700; margin-top: 6px;" id="payment-end-date">${_monthsOwed > 0 ? _nextEndStr : '--'}</div>
                  </div>
                </div>
              </div>

              <form onsubmit="event.preventDefault(); window.handlePaymentSubmit();" class="form-grid" style="gap: 1.5rem;">
                ${_monthsOwed > 0 ? `
                <div class="form-group">
                  <label style="font-size: 0.75rem; font-weight: 600; color: var(--text-secondary); text-transform: uppercase;">Paying For (Locked)</label>
                  <div class="sp-alert sp-alert-warn" style="padding:10px 14px; margin-bottom:0; font-weight:600; font-size:0.95rem; align-items:center;">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                    <span>${_nextMonthLabel}</span>
                  </div>
                  <input type="hidden" id="payment-months" value="1" />
                </div>
                ` : `
                <div class="form-group">
                  <label style="font-size: 0.75rem; font-weight: 600; color: var(--danger); text-transform: uppercase;">Duration *</label>
                  <select id="payment-months" onchange="window.calculatePaymentAmount()" class="sp-input">
                    <option value="1">1 Month</option>
                    <option value="2">2 Months</option>
                    <option value="3">3 Months</option>
                    <option value="6">6 Months</option>
                  </select>
                </div>
                `}
                <div class="form-group">
                  <label style="font-size: 0.75rem; font-weight: 600; color:var(--text-secondary); text-transform: uppercase;">Amount (₹)</label>
                  <div id="payment-amount-display" style="font-size: 1.25rem; font-weight: 700; color: var(--text-primary); padding: 6px 0;">₹--</div>
                  <input type="hidden" id="payment-amount" value="0" />
                </div>
                <div class="form-group full-width">
                  <label style="font-size: 0.75rem; font-weight: 600; color:var(--text-secondary); text-transform: uppercase;">UPI Transaction ID *</label>
                  <input type="text" id="payment-txnid" required class="sp-input" placeholder="Enter your 12-digit UPI Txn ID" />
                </div>
                <div class="form-group full-width sp-actions">
                  <button type="button" class="btn btn-ghost" title="Clear the transaction ID field" onclick="document.getElementById('payment-txnid').value=''">Clear</button>
                  <button type="submit" id="btn-submit-payment" class="btn btn-primary sp-pay-submit">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:8px;"><path d="M23 4v6h-6"></path><path d="M1 20v-6h6"></path><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
                    ${_monthsOwed > 0 ? `Pay for ${_nextMonthLabel}` : 'Submit Renewal Request'}
                  </button>
                </div>
              </form>
            </div>

            <!-- RIGHT SIDE: QR Code -->
            <div class="sp-qr">
              <h4 style="margin:0; font-size: 0.9rem; color:var(--text-secondary); text-align:center;">Scan to Pay</h4>
              <div style="width: 160px; height: 160px; background:var(--bg-card); border:1px solid var(--border); border-radius: 8px; display:flex; align-items:center; justify-content:center; overflow: hidden;">
                <img src="" class="payment-qr-img" alt="Scan to Pay" style="width: 100%; height: 100%; object-fit: contain;" />
              </div>
              <p style="font-size: 0.75rem; color:var(--text-secondary); text-align: center; margin: 0; line-height: 1.4;">Pay using GPay, PhonePe, or Paytm and enter the Txn ID here.</p>
            </div>

          </div>
        </div>


        <div class="card"><h3 style="margin-bottom: 1rem;">Renewal History</h3><table class="data-table"><thead><tr><th data-i18n="table.date">\${window.t ? window.t("table.date") : "Date"}</th><th>Plan</th><th>Period</th><th data-i18n="table.amount">\${window.t ? window.t("table.amount") : "Amount"}</th></tr></thead><tbody>${renewalsHtml}</tbody></table></div>
        <div class="card"><h3 style="margin-bottom: 1rem;">My Payments</h3><table class="data-table"><thead><tr><th data-i18n="table.date">\${window.t ? window.t("table.date") : "Date"}</th><th>Period</th><th data-i18n="table.amount">\${window.t ? window.t("table.amount") : "Amount"}</th><th>Txn ID</th><th data-i18n="table.status">\${window.t ? window.t("table.status") : "Status"}</th></tr></thead><tbody>${paymentsHtml}</tbody></table></div>
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
        <table class="data-table"><thead><tr><th data-i18n="table.date">\${window.t ? window.t("table.date") : "Date"}</th><th>Check In</th><th>Check Out</th><th>Duration</th><th data-i18n="table.status">\${window.t ? window.t("table.status") : "Status"}</th></tr></thead><tbody>${historyHtml}</tbody></table>
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
        <div class="card"><h3 style="margin-bottom: 1rem;">My Complaints</h3><table class="data-table"><thead><tr><th data-i18n="table.date">\${window.t ? window.t("table.date") : "Date"}</th><th>Category</th><th>Details</th><th data-i18n="table.status">\${window.t ? window.t("table.status") : "Status"}</th></tr></thead><tbody>${complaintsHtml}</tbody></table></div>
      </div>
    </div>
  `;

  // Paint the single live QR everywhere (upload once in Settings).
  import("./qrService.js").then(({ paintQrImages }) => paintQrImages()).catch(() => {});

  // Keep the notifications page (bell + sidebar) in sync with live data.
  try { renderStudentNotifications(); } catch (e) { console.warn("[portal] notifications render failed:", e); }

  // Load the student's own documents (same record the admin panel shows).
  try { loadOwnDocuments(); } catch (e) { console.warn("[portal] own documents failed:", e); }

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
