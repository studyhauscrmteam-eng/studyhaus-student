import { getAuth } from "firebase/auth";
import { collection, query, where, onSnapshot, addDoc, serverTimestamp, doc, updateDoc, getDoc, getDocs } from "firebase/firestore";
import { db } from "../firebase/firebase.js";
import { validateComplaint } from "./complaintValidation.js";

// ===============================================
// STUDENT COMPLAINT ACTIONS
// ===============================================

export const submitComplaint = async (student, category, description) => {
  try {
    const finalCategory = validateComplaint(category, description);

    let authUid = '';
    try {
      const auth = getAuth();
      if (auth.currentUser) authUid = auth.currentUser.uid;
    } catch (_) {}

    const studentObj = (student && typeof student === 'object') ? student : {};
    const sId = (student && typeof student === 'string') ? student : (studentObj.id || studentObj.studentId || authUid || '');
    const sName = studentObj.name || studentObj.studentName || 'Student';
    const sPhone = studentObj.phone || studentObj.studentPhone || '';
    const sPlan = studentObj.planName || 'Unknown';

    let seatNumber = studentObj.seatNumber || studentObj.seatAssigned || '';
    if (sId) {
      try {
        const activeQ = query(collection(db, 'attendance'),
          where('studentId', '==', sId), where('status', '==', 'Active'));
        const activeSnap = await getDocs(activeQ);
        if (!activeSnap.empty) {
          seatNumber = activeSnap.docs[0].data().seatNumber || seatNumber;
        }
      } catch (_) { /* seat is optional context on a complaint */ }
    }

    const complaintData = {
      studentId: sId,
      studentName: sName,
      studentPhone: sPhone,
      seatNumber: seatNumber || '',
      planName: sPlan,
      category: finalCategory,
      description: String(description || '').trim(),
      status: 'Pending', // Pending, In Progress, Resolved, Closed
      date: new Date().toISOString(),
      createdAt: serverTimestamp()
    };
    if (authUid) {
      complaintData.uid = authUid;
    }

    await addDoc(collection(db, 'complaints'), complaintData);
    
    return { success: true };
  } catch (error) {
    console.error('[complaint] submitComplaint error:', error);
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
