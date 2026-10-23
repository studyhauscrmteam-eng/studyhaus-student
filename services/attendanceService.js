import { collection, addDoc, updateDoc, doc, query, where, onSnapshot, serverTimestamp, getDocs, getDoc, orderBy, writeBatch } from "firebase/firestore";
import { db } from "../firebase/firebase.js";

import { validateStudentScheduleAccess } from "./scheduleService.js";

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
 * 3. Checks Day/Night access schedule using configurable 24/7 library rules.
 * 4. Checks if there is already an Active session today.
 */
const validateCheckIn = async (student, selectedSeatNumber, selectedSeatFloor = null) => {
  if (!student || !student.id) throw new Error("Student profile not loaded yet. Please wait and try again.");
  if (student.portalAccessDisabled === true || student.status === "Old" || student.status === "Old Student") {
    throw new Error("Portal access is disabled for Old Students. Please contact library administration.");
  }
  if (student.status !== "Active") throw new Error("Membership is not active. Please clear dues or contact the desk.");

  // Seat-first check-in: the seat the student CHOSE wins for every plan.
  // Falls back to the assigned seat only when nothing was selected (desk flow).
  // Plain numbers only ("A20" -> "20"); floor hint carried for disambiguation.
  const stripPlain = (v) => {
    const raw = String(v == null ? "" : v).trim().toUpperCase().replace(/\s+/g, "");
    const m = raw.match(/^[AB]?0*(\d+)[AB]?$/);
    return m ? String(Number(m[1])) : String(v == null ? "" : v).trim();
  };
  const chosenSeat = selectedSeatNumber ? stripPlain(selectedSeatNumber) : "";
  const assignedSeat = student.seatNumber ? stripPlain(student.seatNumber) : "";
  const finalSeat = chosenSeat || assignedSeat;
  // Floor hint: explicit arg wins, else the student's stored floor.
  const seatFloorHint = selectedSeatFloor || (student && (student.seatFloor || "")) || "Ground Floor";

  if (!finalSeat) throw new Error("Select a seat to check in.");

  // Configurable 24/7 Day & Night schedule validation (Requirement 7)
  const schedCheck = await validateStudentScheduleAccess(student, seatFloorHint);
  if (!schedCheck.allowed) {
    throw new Error(schedCheck.reason || "Check-in outside permitted schedule hours.");
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
              const fh = sessionData.seatFloor || "";
              const seatDoc = seatSnap.docs.length === 1
                ? seatSnap.docs[0]
                : (fh && seatSnap.docs.find(d => ((d.data() || {}).floor || "") === fh)) || seatSnap.docs[0];
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

export const checkIn = async (student, selectedSeatNumber = null, selectedSeatFloor = null) => {
  let finalSeat = null;
  try {
    finalSeat = await validateCheckIn(student, selectedSeatNumber, selectedSeatFloor);
  } catch (error) {
    return { success: false, error: error.message };
  }

  try {
    const stripPlain = (v) => {
      const raw = String(v == null ? "" : v).trim().toUpperCase().replace(/\s+/g, "");
      const m = raw.match(/^[AB]?0*(\d+)[AB]?$/);
      if (m) return String(Number(m[1]));
      const m2 = raw.match(/^([A-Z]+)-?0*(\d+)$/);
      if (m2) return String(Number(m2[2]));
      return raw;
    };

    const rawSel = String(selectedSeatNumber || "").trim().toUpperCase();
    const isFirstByPrefix = rawSel.startsWith("P") || rawSel.startsWith("B") || rawSel.endsWith("B");
    const isGroundByPrefix = rawSel.startsWith("L") || rawSel.startsWith("A") || rawSel.endsWith("A");
    const floorHint = selectedSeatFloor || (isFirstByPrefix
      ? "First Floor"
      : (isGroundByPrefix
          ? "Ground Floor"
          : ((student && student.seatFloor) || "Ground Floor")));

    const plainNum = stripPlain(finalSeat);
    const resolvedFloor = floorHint.toLowerCase().includes("first") ? "First Floor" : "Ground Floor";

    // Resolve seat document strictly on the target floor
    const docId = resolvedFloor === "First Floor" ? `first-${plainNum}` : `ground-${plainNum}`;
    let seatDoc = null;
    try {
      const directSnap = await getDoc(doc(db, "seats", docId));
      if (directSnap.exists()) seatDoc = directSnap;
    } catch (_) {}

    if (!seatDoc) {
      const seatQ = query(collection(db, "seats"), where("floor", "==", resolvedFloor));
      const seatSnap = await getDocs(seatQ);
      seatDoc = seatSnap.docs.find(d => {
        const sn = d.data().seatNumber;
        return sn === finalSeat || stripPlain(sn) === plainNum;
      }) || null;
    }

    if (!seatDoc) {
      const seatQ = query(collection(db, "seats"), where("seatNumber", "==", finalSeat));
      const seatSnap = await getDocs(seatQ);
      if (!seatSnap.empty) {
        seatDoc = seatSnap.docs.find(d => (d.data().floor || "Ground Floor") === resolvedFloor) || seatSnap.docs[0];
      }
    }

    if (!seatDoc) return { success: false, error: `Seat ${finalSeat} (${resolvedFloor}) not found. Please pick another seat.` };

    const seatData = seatDoc.data() || {};
    if (seatData.status === "Maintenance" || seatData.status === "Inactive") {
      return { success: false, error: `Seat ${finalSeat} (${resolvedFloor}) is under maintenance. Please pick another seat.` };
    }

    const isFixedOwner = (seatData.assignedStudentId && seatData.assignedStudentId === student.id);

    // FIXED-SEAT ARRIVAL CONFLICT RESOLUTION (Requirement 5)
    if (isFixedOwner && seatData.currentOccupantId && seatData.currentOccupantId !== student.id) {
      // Fixed owner arrived while a rotational guest is occupying the chair!
      try {
        await updateDoc(seatDoc.ref, {
          status: "Conflict",
          conflict: {
            type: "fixed_owner_arrival",
            fixedStudentId: student.id,
            fixedStudentName: student.name,
            rotationalStudentId: seatData.currentOccupantId,
            rotationalStudentName: seatData.currentOccupantName || "Rotational Guest",
            sessionId: seatData.currentSessionId || null,
            reportedAt: Date.now()
          },
          lastUpdated: serverTimestamp()
        });
      } catch (_) {}

      // Notify staff
      try {
        await addDoc(collection(db, "notifications"), {
          type: "seat_conflict",
          title: "Fixed Owner Arrived",
          message: `${student.name} arrived for assigned Seat ${finalSeat} (${resolvedFloor}), currently occupied by ${seatData.currentOccupantName || 'a rotational guest'}. Reassignment needed.`,
          seatId: seatDoc.id,
          seatNumber: finalSeat,
          floor: resolvedFloor,
          createdAt: serverTimestamp(),
          unread: true
        });
      } catch (_) {}

      return {
        success: false,
        conflict: true,
        error: `Seat ${finalSeat} (${resolvedFloor}) is currently occupied by a rotational guest (${seatData.currentOccupantName || 'Student'}). Staff has been notified to reassign them for you.`
      };
    }

    // Rotational student arriving: check if seat is physically occupied
    if (!isFixedOwner && seatData.currentOccupantId && seatData.currentOccupantId !== student.id) {
      return { success: false, error: `Seat ${finalSeat} (${resolvedFloor}) is already occupied. Please pick another seat.` };
    }

    // Check rotational eligibility if this is an open/rotational check-in
    if (!isFixedOwner) {
      const rot = seatData.rotationalEligibility || "both";
      if (rot === "none") {
        return { success: false, error: `Seat ${finalSeat} is reserved for fixed seating only.` };
      }
    }

    const now = new Date();
    const payload = {
      studentId: student.id,
      studentName: student.name,
      seatNumber: finalSeat,
      seatFloor: resolvedFloor,
      planName: student.planName || "",
      date: getTodayStr(),
      checkIn: now.getTime(),
      checkOut: null,
      duration: 0,
      status: "Active",
      createdAt: serverTimestamp()
    };

    let attendanceRef = null;
    try {
      attendanceRef = await addDoc(collection(db, "attendance"), payload);
    } catch (e) {
      if (isPermissionError(e)) return { success: false, error: permissionHint() };
      return { success: false, error: e.message };
    }

    try {
      const occupantType = isFixedOwner ? "fixed" : "rotational";
      await updateDoc(seatDoc.ref, {
        status: "Occupied",
        currentOccupantId: student.id,
        currentOccupantName: student.name,
        currentPlanName: student.planName || "",
        currentCheckInTime: now.getTime(),
        currentSessionId: attendanceRef.id,
        occupantType,
        conflict: null,
        lastUpdated: serverTimestamp()
      });
    } catch (e) {
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

    // Free up the seat occupancy (best effort, floor-aware).
    // Preserves fixed assignment if present.
    if (attData.seatNumber) {
      try {
        const floorHint = attData.seatFloor || "";
        const stripPlain = (v) => {
          const raw = String(v == null ? "" : v).trim().toUpperCase().replace(/\s+/g, "");
          const m = raw.match(/^[AB]?0*(\d+)[AB]?$/);
          if (m) return String(Number(m[1]));
          const m2 = raw.match(/^([A-Z]+)-?0*(\d+)$/);
          if (m2) return String(Number(m2[2]));
          return raw;
        };
        const plainNum = stripPlain(attData.seatNumber);
        const resolvedFloor = (floorHint || "").toLowerCase().includes("first") ? "First Floor" : "Ground Floor";
        const docId = resolvedFloor === "First Floor" ? `first-${plainNum}` : `ground-${plainNum}`;

        let seatDoc = null;
        try {
          const directSnap = await getDoc(doc(db, "seats", docId));
          if (directSnap.exists()) seatDoc = directSnap;
        } catch (_) {}

        if (!seatDoc) {
          const seatQ = query(collection(db, "seats"), where("floor", "==", resolvedFloor));
          const seatSnap = await getDocs(seatQ);
          seatDoc = seatSnap.docs.find(d => {
            const sn = d.data().seatNumber;
            return sn === attData.seatNumber || stripPlain(sn) === plainNum;
          }) || null;
        }

        if (!seatDoc) {
          const seatQ = query(collection(db, "seats"), where("seatNumber", "==", attData.seatNumber));
          const seatSnap = await getDocs(seatQ);
          if (!seatSnap.empty) {
            seatDoc = (floorHint && seatSnap.docs.find(d => ((d.data() || {}).floor || "") === floorHint)) || seatSnap.docs[0];
          }
        }

        if (seatDoc) {
          const sData = seatDoc.data() || {};
          // Only clear if this student was the current occupant (or no occupant set)
          if (!sData.currentOccupantId || sData.currentOccupantId === attData.studentId) {
            const newStatus = sData.assignedStudentId ? "Reserved" : "Available";
            await updateDoc(seatDoc.ref, {
              status: newStatus,
              currentOccupantId: null,
              currentOccupantName: null,
              currentPlanName: null,
              currentCheckInTime: null,
              currentSessionId: null,
              occupantType: null,
              conflict: null,
              lastUpdated: serverTimestamp()
            });
          }
        }
      } catch (e) {
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
