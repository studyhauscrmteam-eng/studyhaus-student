import { collection, doc, query, where, onSnapshot, serverTimestamp, runTransaction } from "firebase/firestore";
import { db } from "../firebase/firebase.js";
import { validateRenewal } from "./renewalValidation.js";

/**
 * Listens to renewal history for a specific student
 */
export const listenToRenewalHistory = (studentId, onUpdate, onError) => {
  if (!studentId) return () => {};
  const q = query(collection(db, "renewals"), where("studentId", "==", studentId));
  return onSnapshot(q, (snapshot) => {
    const history = [];
    snapshot.forEach(doc => history.push({ id: doc.id, ...doc.data() }));
    // Sort descending
    history.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    try { onUpdate(history); } catch (e) { console.warn("[renewals] onUpdate failed:", e); }
  }, (err) => {
    const msg = (err && (err.message || err.code)) || String(err);
    if (/permission|insufficient/i.test(msg)) {
      console.warn("[renewals] listening denied — check firestore.rules");
      try { onUpdate([]); } catch (_) {}
      if (typeof onError === "function") onError(msg);
      return;
    }
    if (typeof onError === "function") onError(msg);
    else console.warn("[renewals] listener error:", err);
  });
};

/**
 * Processes a renewal atomically
 */
export const processRenewal = async (data) => {
  try {
    validateRenewal(data);
    
    await runTransaction(db, async (transaction) => {
      // 1. Get references
      const studentRef = doc(db, "students", data.studentId);
      const renewalRef = doc(collection(db, "renewals")); // new doc
      
      const studentDoc = await transaction.get(studentRef);
      if (!studentDoc.exists()) throw new Error("Student not found.");

      // 2. Write Renewal Record
      transaction.set(renewalRef, {
        studentId: data.studentId,
        studentName: studentDoc.data().name,
        oldPlan: data.oldPlanName,
        newPlan: data.newPlanName,
        startDate: data.startDate,
        endDate: data.endDate,
        amount: Number(data.amount),
        paymentMethod: data.paymentMethod,
        renewedBy: data.renewedBy,
        renewalNotes: data.renewalNotes || "",
        status: "Completed",
        createdAt: serverTimestamp()
      });

      // 3. Update Student Record
      transaction.update(studentRef, {
        planId: data.newPlanId,
        planName: data.newPlanName,
        paymentDueDate: data.endDate, // The new due date is the end of this renewal period
        status: "Active", // Ensure they are active
        updatedAt: serverTimestamp()
      });

      // 4. Generate Completed Payment Record
      if (Number(data.amount) >= 0) {
        const paymentRef = doc(collection(db, "payments"));
        transaction.set(paymentRef, {
          studentId: data.studentId,
          studentName: studentDoc.data().name,
          planName: data.newPlanName,
          amount: Number(data.amount),
          paymentMethod: data.paymentMethod,
          paymentDate: new Date().toISOString().split("T")[0],
          status: "Completed", // Auto-completed because they paid during renewal
          recordedBy: data.renewedBy,
          createdAt: serverTimestamp()
        });
      }
    });

    return { success: true };
  } catch (error) {
    console.error("Renewal Error:", error);
    return { success: false, error: error.message };
  }
};
