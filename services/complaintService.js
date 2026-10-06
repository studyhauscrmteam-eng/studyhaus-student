import { collection, query, where, onSnapshot, addDoc, serverTimestamp, doc, updateDoc, getDoc, getDocs } from "firebase/firestore";
import { db } from "../firebase/firebase.js";
import { validateComplaint } from "./complaintValidation.js";

// ===============================================
// STUDENT COMPLAINT ACTIONS
// ===============================================

export const submitComplaint = async (student, category, description) => {
  try {
    validateComplaint(category, description);

    // Seat the student is sitting in RIGHT NOW (the one they chose at
    // check-in today). Uses the indexed studentId+status query.
    let seatNumber = "";
    try {
      const activeQ = query(collection(db, "attendance"),
        where("studentId", "==", student.id), where("status", "==", "Active"));
      const activeSnap = await getDocs(activeQ);
      if (!activeSnap.empty) seatNumber = activeSnap.docs[0].data().seatNumber || "";
    } catch (_) { /* seat is optional context on a complaint */ }

    await addDoc(collection(db, "complaints"), {
      studentId: student.id,
      studentName: student.name,
      studentPhone: student.phone || "",
      seatNumber: seatNumber,
      planName: student.planName || "Unknown",
      category: category,
      description: description.trim(),
      status: "Pending", // Pending, In Progress, Resolved, Closed
      date: new Date().toISOString(),
      createdAt: serverTimestamp()
    });
    
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

export const listenToMyComplaints = (studentId, onUpdate, onError) => {
  if (!studentId) return () => {};
  const q = query(
    collection(db, "complaints"),
    where("studentId", "==", studentId)
  );
  return onSnapshot(q, (snapshot) => {
    const records = [];
    snapshot.forEach(doc => records.push({ id: doc.id, ...doc.data() }));
    records.sort((a, b) => new Date(b.date) - new Date(a.date));
    try { onUpdate(records); } catch (e) { console.warn("[complaints] onUpdate failed:", e); }
  }, (err) => {
    const msg = (err && (err.message || err.code)) || String(err);
    if (/permission|insufficient/i.test(msg)) {
      console.warn("[complaints] listening denied — check firestore.rules");
      try { onUpdate([]); } catch (_) {}
      if (typeof onError === "function") onError(msg);
      return;
    }
    if (typeof onError === "function") onError(msg);
    else console.warn("[complaints] listener error:", err);
  });
};

// ===============================================
// ADMIN COMPLAINT ACTIONS
// ===============================================

export const listenToAllComplaints = (onUpdate) => {
  const q = query(collection(db, "complaints"));
  return onSnapshot(q, (snapshot) => {
    const records = [];
    snapshot.forEach(doc => records.push({ id: doc.id, ...doc.data() }));
    records.sort((a, b) => new Date(b.date) - new Date(a.date));
    onUpdate(records);
  });
};

export const resolveComplaint = async (complaintId, resolverName, resolutionNote) => {
  try {
    const docRef = doc(db, "complaints", complaintId);
    const snap = await getDoc(docRef);
    if (!snap.exists()) throw new Error("Complaint not found.");

    await updateDoc(docRef, {
      status: "Resolved",
      resolutionNote: resolutionNote,
      resolvedBy: resolverName,
      resolvedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    
    return { success: true, data: snap.data() };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

export const updateComplaintStatus = async (complaintId, newStatus) => {
  try {
    const docRef = doc(db, "complaints", complaintId);
    await updateDoc(docRef, {
      status: newStatus,
      updatedAt: serverTimestamp()
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};
