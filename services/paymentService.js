import { collection, query, where, onSnapshot, addDoc, serverTimestamp, doc, updateDoc, getDoc } from "firebase/firestore";
import { db } from "../firebase/firebase.js";
import { validateTransactionId } from "./paymentValidation.js";

// ===============================================
// STUDENT PAYMENT ACTIONS
// ===============================================

export const submitPaymentRequest = async (student, transactionId, renewalMonths, amount, monthLabel = null) => {
  try {
    if (!transactionId || transactionId.trim() === "") {
      throw new Error("Transaction ID is required.");
    }

    const paymentData = {
      studentId: student.id,
      studentName: student.name,
      planName: student.planName,
      amount: Number(amount),
      renewalPeriod: Number(renewalMonths), // Months to add
      transactionId: transactionId.trim(),
      status: "pending", // "pending", "approved", "rejected"
      dueDateStr: student.paymentDueDate || "", // Reference for dashboard
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

    // Calculate new due date
    let currentDue = new Date(studentData.paymentDueDate || new Date());
    if (isNaN(currentDue.getTime())) currentDue = new Date();
    
    // Add the renewal months (day-safe: avoids Jan 31 + 1 month = Mar 3)
    const renewalMonths = Number(paymentData.renewalPeriod);
    currentDue.setDate(1); // Reset to 1st to avoid month-end overflow
    currentDue.setMonth(currentDue.getMonth() + renewalMonths);
    // Move to last day of that month if original was end-of-month
    const lastDay = new Date(currentDue.getFullYear(), currentDue.getMonth() + 1, 0).getDate();
    currentDue.setDate(Math.min(lastDay, currentDue.getDate()));
    const newDueDateStr = currentDue.toISOString().split("T")[0];

    // 1. Update Student Due Date
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
