import { collection, addDoc, updateDoc, doc, query, where, onSnapshot, serverTimestamp, getDocs, getDoc, orderBy, writeBatch } from "firebase/firestore";
import { db } from "../firebase/firebase.js";

// Helper to get today's date string YYYY-MM-DD
const getTodayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};

const isPermissionError = (e) => {
  const msg = String((e && (e.code || e.message)) || e || "");
  return /permission|insufficient/i.test(msg);
};

const permissionHint = () => "Permission denied. Please deploy the latest firestore.rules (attendance + seats self check-in) with `firebase deploy --only firestore:rules`, then try again.";

/**
 * Validates Check-In rules:
 * 1. Checks if Membership is Active.
 * 2. Checks if Seat exists (has truthy value).
 * 3. Checks Night Study constraint.
 * 4. Checks if there is already an Active session today.
 */
const validateCheckIn = async (student, selectedSeatNumber) => {
  if (!student || !student.id) throw new Error("Student profile not loaded yet. Please wait and try again.");
  if (student.status !== "Active") throw new Error("Membership is not active. Please clear dues or contact the desk.");

  // Seat-first check-in: the seat the student CHOSE wins for every plan.
  // Falls back to the assigned seat only when nothing was selected (desk flow).
  const chosenSeat = selectedSeatNumber ? String(selectedSeatNumber).trim() : "";
  const assignedSeat = student.seatNumber ? String(student.seatNumber).trim() : "";
  const finalSeat = chosenSeat || assignedSeat;

  if (!finalSeat) throw new Error("Select a seat to check in.");

  // Night Study check (7 PM to 7 AM)
  const isNightPlan = (student.planName || "").toLowerCase().includes("night");
  if (isNightPlan) {
    const hour = new Date().getHours();
    if (hour >= 7 && hour < 19) {
      throw new Error("Night study students can only check in between 7:00 PM and 7:00 AM.");
    }
  }

  const today = getTodayStr();

  // Check for existing Active session
  let snap;
  try {
    const q = query(
      collection(db, "attendance"),
      where("studentId", "==", student.id),
      where("status", "==", "Active")
    );
    snap = await getDocs(q);
  } catch (e) {
    if (isPermissionError(e)) throw new Error(permissionHint());
    throw e;
  }

  if (!snap.empty) {
    for (const sessionDoc of snap.docs) {
      const sessionData = sessionDoc.data();

      if (sessionData.date === today) {
        // Already checked in TODAY — block the duplicate
        throw new Error("You are already checked in. Please check out first.");
      } else {
        // Stale session from a previous day (student left without checking out).
        // Auto-close it so today's check-in can proceed.
        const checkOutTime = new Date().getTime();
        const checkInTime = sessionData.checkIn || checkOutTime;
        const durationHours = Math.max(0, Math.round((checkOutTime - checkInTime) / (1000 * 60 * 60) * 100) / 100);

        try {
          await updateDoc(sessionDoc.ref, {
            checkOut: checkOutTime,
            duration: durationHours,
            status: "Completed",
            autoClosedReason: "Stale session — student did not check out the previous day.",
            updatedAt: serverTimestamp()
          });
        } catch (e) {
          if (isPermissionError(e)) throw new Error("Found yesterday's open session but cannot close it. " + permissionHint());
          throw e;
        }

        // Free up the seat that was marked Occupied from the stale session
        // (best effort — a seat failure must not block today's check-in).
        if (sessionData.seatNumber) {
          try {
            const seatQ = query(collection(db, "seats"), where("seatNumber", "==", sessionData.seatNumber));
            const seatSnap = await getDocs(seatQ);
            if (!seatSnap.empty) {
              const seatDoc = seatSnap.docs[0];
              const sData = seatDoc.data();
              const newStatus = sData.assignedStudentId ? "Reserved" : "Available";
              await updateDoc(seatDoc.ref, { status: newStatus, lastUpdated: serverTimestamp() });
            }
          } catch (_) { /* seat cleanup is best-effort */ }
        }
      }
    }
  }

  return finalSeat;
};

export const checkIn = async (student, selectedSeatNumber = null) => {
  let finalSeat = null;
  try {
    finalSeat = await validateCheckIn(student, selectedSeatNumber);
  } catch (error) {
    return { success: false, error: error.message };
  }

  try {
    // Verify seat is available (or reserved — first come, first served)
    let seatSnap;
    try {
      const seatQ = query(collection(db, "seats"), where("seatNumber", "==", finalSeat));
      seatSnap = await getDocs(seatQ);
    } catch (e) {
      if (isPermissionError(e)) return { success: false, error: permissionHint() };
      throw e;
    }
    if (seatSnap.empty) return { success: false, error: `Seat ${finalSeat} not found. Please pick another seat.` };

    const seatDoc = seatSnap.docs[0];
    const seatData = seatDoc.data();

    if (seatData.status === "Occupied") return { success: false, error: `Seat ${finalSeat} is already occupied. Please pick another seat.` };
    if (seatData.status === "Maintenance" || seatData.status === "Inactive") return { success: false, error: `Seat ${finalSeat} is under maintenance. Please pick another seat.` };
    // Reserved seats are freely pickable — first come, first served. The
    // assignment only decides which status the seat reverts to on check-out.

    const now = new Date();
    const payload = {
      studentId: student.id,
      studentName: student.name,
      seatNumber: finalSeat, // The actual seat they are taking
      planName: student.planName || "",
      date: getTodayStr(),
      checkIn: now.getTime(),
      checkOut: null,
      duration: 0,
      status: "Active",
      createdAt: serverTimestamp()
    };

    // Step 1: create the attendance record (must succeed).
    let attendanceRef = null;
    try {
      attendanceRef = await addDoc(collection(db, "attendance"), payload);
    } catch (e) {
      if (isPermissionError(e)) return { success: false, error: permissionHint() };
      return { success: false, error: e.message };
    }

    // Step 2: mark the seat Occupied (best effort — works once new rules are deployed).
    try {
      await updateDoc(seatDoc.ref, {
        status: "Occupied",
        lastUpdated: serverTimestamp()
      });
    } catch (e) {
      if (isPermissionError(e)) {
        console.warn("[attendance] checked in but seat map needs rules deploy:", e.message);
        return { success: true, warning: "Checked in, but the seat map could not update. Ask staff to deploy the latest security rules." };
      }
      console.warn("[attendance] seat update failed:", e);
      return { success: true, warning: "Checked in, but the seat map could not update." };
    }

    return { success: true };
  } catch (error) {
    if (isPermissionError(error)) return { success: false, error: permissionHint() };
    return { success: false, error: error.message };
  }
};

export const checkOut = async (attendanceId, checkInTimestamp) => {
  try {
    if (!attendanceId) throw new Error("Missing attendance record.");
    // 1. Get attendance record to know which seat to free up
    const docRef = doc(db, "attendance", attendanceId);
    let snap;
    try {
      snap = await getDoc(docRef);
    } catch (e) {
      if (isPermissionError(e)) return { success: false, error: permissionHint() };
      throw e;
    }
    if (!snap.exists()) throw new Error("Attendance record not found.");
    const attData = snap.data();

    const now = new Date();
    const checkOutTime = now.getTime();
    const safeCheckIn = checkInTimestamp || attData.checkIn || checkOutTime;

    let durationHours = (checkOutTime - safeCheckIn) / (1000 * 60 * 60);
    if (durationHours < 0) durationHours = 0;
    durationHours = Math.round(durationHours * 100) / 100;

    try {
      await updateDoc(docRef, {
        checkOut: checkOutTime,
        duration: durationHours,
        status: "Completed",
        updatedAt: serverTimestamp()
      });
    } catch (e) {
      if (isPermissionError(e)) return { success: false, error: permissionHint() };
      throw e;
    }

    // 2. Free up the seat (best effort).
    if (attData.seatNumber) {
      try {
        const seatQ = query(collection(db, "seats"), where("seatNumber", "==", attData.seatNumber));
        const seatSnap = await getDocs(seatQ);
        if (!seatSnap.empty) {
          const seatDoc = seatSnap.docs[0];
          const sData = seatDoc.data();

          // If it's a fixed seat belonging to someone, revert to Reserved. Else Available.
          let newStatus = "Available";
          if (sData.assignedStudentId) newStatus = "Reserved";

          await updateDoc(seatDoc.ref, {
            status: newStatus,
            lastUpdated: serverTimestamp()
          });
        }
      } catch (e) {
        console.warn("[attendance] checked out but seat map needs rules deploy:", e && e.message);
        return { success: true, warning: "Checked out, but the seat map could not update." };
      }
    }

    return { success: true };
  } catch (error) {
    if (isPermissionError(error)) return { success: false, error: permissionHint() };
    return { success: false, error: error.message };
  }
};

export const listenToMyAttendance = (studentId, onUpdate, onError) => {
  if (!studentId) return () => {};
  const q = query(
    collection(db, "attendance"),
    where("studentId", "==", studentId)
  );
  return onSnapshot(q, (snapshot) => {
    const records = [];
    snapshot.forEach(doc => {
      records.push({ id: doc.id, ...doc.data() });
    });
    // Sort descending by checkIn locally since we didn't index it composite
    records.sort((a, b) => (b.checkIn || 0) - (a.checkIn || 0));
    try { onUpdate(records); } catch (e) { console.warn("[attendance] onUpdate failed:", e); }
  }, (err) => {
    if (isPermissionError(err)) {
      console.warn("[attendance] listening denied — deploy latest firestore.rules");
      if (typeof onError === "function") onError(permissionHint());
      else try { onUpdate([]); } catch (_) {}
      return;
    }
    if (typeof onError === "function") onError(err.message || String(err));
    else console.warn("[attendance] listener error:", err);
  });
};

export const listenToAllAttendance = (onUpdate, onError) => {
  const q = query(
    collection(db, "attendance")
  );
  return onSnapshot(q, (snapshot) => {
    const records = [];
    snapshot.forEach(doc => {
      records.push({ id: doc.id, ...doc.data() });
    });
    records.sort((a, b) => (b.checkIn || 0) - (a.checkIn || 0));
    onUpdate(records);
  }, (err) => {
    if (typeof onError === "function") onError(err.message || String(err));
    else console.warn("[attendance] listener error:", err);
  });
};
