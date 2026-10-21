import { collection, query, where, onSnapshot, addDoc, serverTimestamp, doc, updateDoc, getDoc } from "firebase/firestore";
import { db } from "../firebase/firebase.js";
import { validateTransactionId } from "./paymentValidation.js";

// ===============================================
// STUDENT PAYMENT ACTIONS
// ===============================================

export const submitPaymentRequest = async (student, transactionId, renewalMonths, amount, monthLabel = null, screenshot = "", extraDates = {}, paymentMethod = "UPI") => {
  try {
    const isCash = paymentMethod === "Cash" || paymentMethod === "Paid (Cash)";
    const cleanTxn = isCash ? (transactionId && String(transactionId).trim() ? String(transactionId).trim() : "CASH") : String(transactionId || "").trim();

    if (!isCash && (!cleanTxn || cleanTxn === "")) {
      throw new Error("Transaction ID is required.");
    }

    // Determine the screenshot proof data URL (mandatory only for UPI/online)
    let singleShot = typeof screenshot === "string" ? screenshot : (Array.isArray(screenshot) && screenshot.length ? screenshot[0] : "");
    if (!isCash && (!singleShot || typeof singleShot !== "string" || !singleShot.startsWith("data:image/"))) {
      throw new Error("Payment screenshot proof is required.");
    }

    // Block reused UTRs before writing for UPI
    if (!isCash && cleanTxn !== "CASH") {
      try { await validateTransactionId(cleanTxn); } catch (dupErr) { throw dupErr; }
    }

    const paymentData = {
      studentId: student.id,
      studentName: student.name,
      planId: student.planId || "",
      planName: student.planName,
      amount: Number(amount),
      paymentMethod: isCash ? "Cash" : "UPI",
      renewalPeriod: Number(renewalMonths || 1), // Months to add (kept for compat)
      renewalMonths: Number(renewalMonths || 1),
      renewalDays: Number(extraDates.durationDays || 0),
      durationDays: Number(extraDates.durationDays || (renewalMonths ? renewalMonths * 30 : 30)),
      durationMode: extraDates.durationMode || "monthly",
      startDate: extraDates.startDate || "",
      endDate: extraDates.endDate || "",
      transactionId: cleanTxn,
      screenshot: isCash ? "" : singleShot,
      paymentScreenshotUrl: isCash ? "" : singleShot,
      screenshots: (!isCash && singleShot) ? [singleShot] : [],
      source: "renewal",
      status: "pending", // "pending", "approved", "rejected"
      dueDateStr: extraDates.endDate || student.paymentDueDate || "", // Reference for dashboard
      date: new Date().toISOString(),
      createdAt: serverTimestamp()
    };

    // Store which specific month is being paid (for sequential overdue payments)
    if (monthLabel) paymentData.monthLabel = monthLabel; // e.g. "June 2026"

    await addDoc(collection(db, "payments"), paymentData);
    
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};



export const listenToMyPayments = (studentId, onUpdate, onError) => {
  if (!studentId) return () => {};
  const q = query(
    collection(db, "payments"),
    where("studentId", "==", studentId)
  );
  return onSnapshot(q, (snapshot) => {
    const records = [];
    snapshot.forEach(doc => records.push({ id: doc.id, ...doc.data() }));
    records.sort((a, b) => new Date(b.date) - new Date(a.date));
    try { onUpdate(records); } catch (e) { console.warn("[payments] onUpdate failed:", e); }
  }, (err) => {
    const msg = (err && (err.message || err.code)) || String(err);
    if (/permission|insufficient/i.test(msg)) {
      console.warn("[payments] listening denied — check firestore.rules");
      try { onUpdate([]); } catch (_) {}
      if (typeof onError === "function") onError(msg);
      return;
    }
    if (typeof onError === "function") onError(msg);
    else console.warn("[payments] listener error:", err);
  });
};

// ===============================================
// ADMIN PAYMENT ACTIONS
// ===============================================

export const listenToAllPayments = (onUpdate) => {
  const q = query(collection(db, "payments"));
  return onSnapshot(q, (snapshot) => {
    const records = [];
    snapshot.forEach(doc => records.push({ id: doc.id, ...doc.data() }));
    records.sort((a, b) => new Date(b.date) - new Date(a.date));
    onUpdate(records);
  });
};

export const receiveDirectPayment = async (data) => {
  try {
    await addDoc(collection(db, "payments"), {
      studentName: data.studentName,
      planName: data.planName,
      amount: Number(data.amount),
      paymentMethod: data.paymentMethod,
      transactionId: data.transactionId || "RC-N/A",
      status: data.status || "approved",
      date: data.date || new Date().toISOString(),
      createdAt: serverTimestamp(),
      approvedBy: data.approvedBy || "Admin",
      approvalDate: serverTimestamp()
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

export const approvePayment = async (paymentId, approverName) => {
  try {
    const paymentRef = doc(db, "payments", paymentId);
    const snap = await getDoc(paymentRef);
    if (!snap.exists()) throw new Error("Payment not found");
    
    const paymentData = snap.data();
    if (paymentData.status !== "pending") throw new Error("Payment is not pending.");

    // Retrieve the student
    const studentRef = doc(db, "students", paymentData.studentId);
    const studentSnap = await getDoc(studentRef);
    if (!studentSnap.exists()) throw new Error("Student not found");
    const studentData = studentSnap.data();

    // Calculate new due date: extend from the existing future due date,
    // otherwise start from today (first payment / long-expired rejoin).
    // Supports both month and day durations (e.g. 15-day plans).
    let startDue = null;
    try {
      const parsed = new Date(studentData.paymentDueDate || "");
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const dueMid = new Date(parsed); dueMid.setHours(0, 0, 0, 0);
      startDue = (!isNaN(dueMid.getTime()) && dueMid >= today) ? dueMid : today;
    } catch (_) { startDue = new Date(); }
    const renewalMonths = Number(paymentData.renewalMonths != null ? paymentData.renewalMonths : paymentData.renewalPeriod) || 0;
    const renewalDays = Number(paymentData.renewalDays) || 0;
    const fallbackMonths = (!renewalMonths && !renewalDays) ? (Number(paymentData.renewalPeriod) || 1) : 0;
    let endDue = new Date(startDue);
    try {
      const { addDurationToDate } = await import("./planDuration.js");
      endDue = addDurationToDate(startDue, renewalMonths + fallbackMonths, renewalDays);
    } catch (_) {
      endDue.setDate(1); // Reset to 1st to avoid month-end overflow
      endDue.setMonth(endDue.getMonth() + (renewalMonths + fallbackMonths || 1));
      const lastDay = new Date(endDue.getFullYear(), endDue.getMonth() + 1, 0).getDate();
      endDue.setDate(Math.min(lastDay, endDue.getDate()));
      if (renewalDays) endDue.setDate(endDue.getDate() + renewalDays);
    }
    const startStr = new Date(startDue).toISOString().split("T")[0];
    const newDueDateStr = endDue.toISOString().split("T")[0];

    // 1. Update Student Due Date (additive — no other fields touched)
    await updateDoc(studentRef, {
      paymentDueDate: newDueDateStr,
      status: "Active",
      updatedAt: serverTimestamp()
    });

    // 2. Update payment document to approved
    await updateDoc(paymentRef, {
      status: "approved",
      approvedBy: approverName,
      approvalDate: serverTimestamp()
    });

    // 3. Mirror into renewals/ so Renewal History shows every approved
    // payment (onboarding first payment + renewals), not just manual ones.
    // Best-effort additive — approval already succeeded above.
    try {
      const shot = paymentData.screenshot || paymentData.paymentScreenshotUrl || (Array.isArray(paymentData.screenshots) ? paymentData.screenshots[0] : "") || "";
      await addDoc(collection(db, "renewals"), {
        studentId: paymentData.studentId,
        studentName: paymentData.studentName || studentData.name || "",
        oldPlan: studentData.planName || paymentData.planName || "",
        newPlan: paymentData.planName || studentData.planName || "",
        startDate: startStr,
        endDate: newDueDateStr,
        amount: Number(paymentData.amount) || 0,
        paymentMethod: paymentData.paymentMethod || "Paid",
        transactionId: paymentData.transactionId || "",
        screenshot: shot,
        paymentScreenshotUrl: shot,
        screenshots: shot ? [shot] : [],
        paymentId,
        source: paymentData.source || "renewal",
        renewedBy: approverName,
        renewalNotes: "",
        status: "Completed",
        createdAt: serverTimestamp()
      });
    } catch (renewErr) {
      console.warn("[payments] renewals mirror skipped:", renewErr && renewErr.message ? renewErr.message : renewErr);
    }
    
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

export const rejectPayment = async (paymentId, approverName, remark) => {
  try {
    const paymentRef = doc(db, "payments", paymentId);
    await updateDoc(paymentRef, {
      status: "rejected",
      approvedBy: approverName,
      approvalDate: serverTimestamp(),
      remark: remark
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// ===============================================
// DASHBOARD LISTENERS (From Part 3)
// ===============================================

/**
 * Listen to all approved payments for today and this month to calculate earnings
 */
export const listenToEarnings = (onUpdate, onError) => {
  const q = query(
    collection(db, "payments"),
    where("status", "==", "approved")
  );

  return onSnapshot(q, (snapshot) => {
    let todayEarnings = 0;
    let monthlyEarnings = 0;
    
    const now = new Date();
    const todayStr = now.toISOString().split("T")[0]; // YYYY-MM-DD
    const currentMonthStr = todayStr.substring(0, 7); // YYYY-MM

    snapshot.forEach(doc => {
      const data = doc.data();
      const amount = Number(data.amount) || 0;
      
      let paymentDateStr = "";
      if (data.approvalDate && data.approvalDate.toDate) {
        paymentDateStr = data.approvalDate.toDate().toISOString().split("T")[0];
      } else if (data.date) {
        paymentDateStr = data.date.toString().split("T")[0];
      }

      if (paymentDateStr === todayStr) {
        todayEarnings += amount;
      }
      
      if (paymentDateStr.startsWith(currentMonthStr)) {
        monthlyEarnings += amount;
      }
    });

    onUpdate({ todayEarnings, monthlyEarnings });
  }, onError);
};

/**
 * Listen to pending payments to populate the dashboard panel
 */
export const listenToPendingPayments = (onUpdate, onError) => {
  const q = query(
    collection(db, "payments"),
    where("status", "==", "pending")
  );

  return onSnapshot(q, (snapshot) => {
    const pendingList = [];
    let totalPendingToday = 0;

    const now = new Date();
    now.setHours(0, 0, 0, 0);

    snapshot.forEach(doc => {
      const data = doc.data();
      let dueDate = data.dueDateStr ? new Date(data.dueDateStr) : new Date();
      dueDate.setHours(0, 0, 0, 0);
      
      const timeDiff = dueDate.getTime() - now.getTime();
      const daysRemaining = Math.ceil(timeDiff / (1000 * 3600 * 24));
      
      const amount = Number(data.amount) || 0;
      totalPendingToday += amount;

      pendingList.push({
        id: doc.id,
        studentName: data.studentName || "Unknown",
        seatNumber: data.seatNumber || "N/A", // Payment data might not have seat unless we added it
        amount: amount,
        dueDateStr: data.dueDateStr || "N/A",
        daysRemaining: daysRemaining,
        isOverdue: daysRemaining < 0
      });
    });

    pendingList.sort((a, b) => {
      if (a.isOverdue && !b.isOverdue) return -1;
      if (!a.isOverdue && b.isOverdue) return 1;
      return a.daysRemaining - b.daysRemaining;
    });

    onUpdate({ pendingList, totalPendingToday });
  }, onError);
};
