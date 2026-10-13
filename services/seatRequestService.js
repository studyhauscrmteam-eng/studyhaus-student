import { collection, addDoc, updateDoc, runTransaction, query, where, onSnapshot, serverTimestamp, deleteDoc, doc, getDoc, getDocs } from "firebase/firestore";
import { getAuth } from "firebase/auth";
import { db } from "../firebase/firebase.js";
import { planAllowsSeatSelection } from "./planValidation.js";

// Seat-change requests: the student asks, staff approves. No direct self-swap.
// seatRequests/{autoId}: {studentId, studentName, phone, planId, planName,
//   fromSeat, fromFloor, toSeat, toFloor, reason, status, decidedBy,
//   decidedAt, createdAt, updatedAt}
// status: Pending | Approved | Rejected (student cancel = delete while Pending)

const GROUND_MAX = 68;
const FIRST_MAX = 40;

export const stripSeatPlain = (v) => {
  const raw = String(v == null ? "" : v).trim().toUpperCase().replace(/\s+/g, "");
  if (!raw) return "";
  const m = raw.match(/^[AB]?0*(\d+)[AB]?$/);
  if (m) return String(Number(m[1]));
  return raw;
};

const maxForFloor = (floor) => (floor === "First Floor" ? FIRST_MAX : GROUND_MAX);

/** Floor-aware seat lookup (plain numbers + legacy A/B docs). */
const findSeatDoc = async (number, floor) => {
  const plain = stripSeatPlain(number);
  for (const key of [plain, `A${plain}`, `B${plain}`]) {
    try {
      const s = await getDocs(query(collection(db, "seats"), where("seatNumber", "==", key)));
      for (const d of s.docs) {
        const sd = d.data() || {};
        if (stripSeatPlain(sd.seatNumber) === plain && (sd.floor || "Ground Floor") === floor) {
          return { ref: d.ref, data: sd };
        }
      }
    } catch (_) { /* try next key */ }
  }
  return null;
};

export const submitSeatChangeRequest = async (student, { toSeatNumber, toSeatFloor, reason }) => {
  try {
    if (!student || !student.id) throw new Error("Student profile not loaded yet.");
    if (student.status !== "Active") throw new Error("Only active members can change seats.");
    const fromSeat = stripSeatPlain(student.seatNumber);
    if (!fromSeat) throw new Error("You don't have a fixed seat to change from.");
    const fromFloor = student.seatFloor || "Ground Floor";

    const allowed = await planAllowsSeatSelection(student.planId);
    if (!allowed) throw new Error("Your plan does not include fixed-seat changes.");

    const toSeat = stripSeatPlain(toSeatNumber);
    const toFloor = toSeatFloor || "Ground Floor";
    if (!/^\d+$/.test(toSeat)) throw new Error("Pick a valid seat number.");
    const n = Number(toSeat);
    if (!(n >= 1 && n <= maxForFloor(toFloor))) {
      throw new Error(`Seat ${toSeat} is out of range for ${toFloor} (1-${maxForFloor(toFloor)}).`);
    }
    if (toSeat === fromSeat && toFloor === fromFloor) {
      throw new Error("That's already your seat.");
    }

    // Target must be genuinely free right now (plain numbers + legacy A/B safe).
    const myUid = (getAuth().currentUser || {}).uid || student.id;
    const seatsRef = collection(db, "seats");
    let match = null;
    for (const key of [toSeat, `A${toSeat}`, `B${toSeat}`]) {
      try {
        const s = await getDocs(query(seatsRef, where("seatNumber", "==", key)));
        for (const d of s.docs) {
          const sd = d.data() || {};
          const floor = sd.floor || "Ground Floor";
          if (stripSeatPlain(sd.seatNumber) === toSeat && floor === toFloor) { match = { ref: d.ref, data: sd }; break; }
        }
        if (match) break;
      } catch (_) { /* keep trying other keys */ }
    }
    if (!match) throw new Error(`Seat ${toSeat} was not found on ${toFloor}.`);
    if (match.data.status === "Occupied" || match.data.status === "Maintenance" || match.data.status === "Inactive") {
      throw new Error(`Seat ${toSeat} is ${String(match.data.status).toLowerCase()} right now. Pick another.`);
    }
    if (match.data.status === "Reserved" && match.data.assignedStudentId && match.data.assignedStudentId !== student.id) {
      throw new Error(`Seat ${toSeat} is reserved for someone else. Pick another.`);
    }
    if (match.data.status === "Pending" && match.data.assignedStudentId !== myUid) {
      throw new Error(`Seat ${toSeat} has a pending seat-change request. Pick another.`);
    }

    // One pending request at a time.
    try {
      const mine = await getDocs(query(
        collection(db, "seatRequests"),
        where("studentId", "==", student.id),
        where("status", "==", "Pending")
      ));
      if (!mine.empty) throw new Error("You already have a seat-change request waiting. Cancel it first to send a new one.");
    } catch (e) {
      if (/already have/.test(e.message)) throw e;
      // Query failed (rules/index) — fall through; server rules still guard.
    }

    // Hold the seat as Pending while the desk decides (atomic Available ->
    // Pending, so two students can never hold the same target). Released on
    // cancel/reject; the desk's approval turns it into a Reserved seat.
    try {
      await runTransaction(db, async (tx) => {
        const fresh = await tx.get(match.ref);
        const sd = fresh.data() || {};
        const heldByMe = sd.status === "Pending" && sd.assignedStudentId === myUid;
        if (!heldByMe && sd.status !== "Available") {
          throw new Error(`Seat ${toSeat} is no longer free. Pick another.`);
        }
        tx.update(match.ref, {
          status: "Pending",
          assignedStudentId: myUid,
          assignedStudentName: student.name || "",
          lastUpdated: serverTimestamp(),
        });
      });
    } catch (e) {
      if (e && /no longer free/.test(e.message)) throw e;
      // Rules not yet published (or a transient failure) — file the request
      // without the hold; the desk still sees it, and approve/reject/cancel
      // release guards make the hold optional.
      console.warn("[seatRequests] Pending hold skipped:", e && (e.message || e));
    }

    let requestCreated = false;
    try {
      await addDoc(collection(db, "seatRequests"), {
        studentId: student.id,
        studentName: student.name || "",
        phone: student.phone || "",
        planId: student.planId || "",
        planName: student.planName || "",
        fromSeat,
        fromFloor,
        toSeat,
        toFloor,
        reason: String(reason || "").trim().slice(0, 300),
        status: "Pending",
        decidedBy: "",
        decidedAt: null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      requestCreated = true;
    } finally {
      if (!requestCreated) {
        // Never leave an orphan hold: release the seat if the request failed.
        try {
          await updateDoc(match.ref, {
            status: "Available",
            assignedStudentId: null,
            assignedStudentName: null,
            lastUpdated: serverTimestamp(),
          });
        } catch (_) { /* best effort */ }
      }
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

export const listenToMySeatRequests = (studentId, onUpdate, onError) => {
  if (!studentId) return () => {};
  const q = query(collection(db, "seatRequests"), where("studentId", "==", studentId));
  return onSnapshot(q, (snapshot) => {
    const records = [];
    snapshot.forEach((d) => records.push({ id: d.id, ...d.data() }));
    records.sort((a, b) => {
      const ta = (a.createdAt && (a.createdAt.seconds || a.createdAt)) || 0;
      const tb = (b.createdAt && (b.createdAt.seconds || b.createdAt)) || 0;
      const na = typeof ta === "number" ? ta : new Date(ta).getTime();
      const nb = typeof tb === "number" ? tb : new Date(tb).getTime();
      return (nb || 0) - (na || 0);
    });
    try { onUpdate(records); } catch (e) { console.warn("[seatRequests] onUpdate failed:", e); }
  }, (err) => {
    const msg = (err && (err.message || err.code)) || String(err);
    if (/permission|insufficient/i.test(msg)) {
      console.warn("[seatRequests] listening denied — deploy the latest firestore.rules");
      try { onUpdate([]); } catch (_) {}
      if (typeof onError === "function") onError(msg);
      return;
    }
    if (typeof onError === "function") onError(msg);
    else console.warn("[seatRequests] listener error:", err);
  });
};

export const cancelSeatRequest = async (requestId, studentId) => {
  try {
    const ref = doc(db, "seatRequests", requestId);
    const snap = await getDoc(ref);
    if (!snap.exists()) throw new Error("Request not found.");
    const data = snap.data() || {};
    if (data.studentId !== studentId) throw new Error("Not your request.");
    if (data.status !== "Pending") throw new Error("Only waiting requests can be cancelled.");
    await deleteDoc(ref);
    // Release the Pending hold this request placed on the target seat.
    try {
      const myUid = (getAuth().currentUser || {}).uid || studentId;
      const target = await findSeatDoc(data.toSeat, data.toFloor || "Ground Floor");
      if (target && target.data.status === "Pending" && target.data.assignedStudentId === myUid) {
        await updateDoc(target.ref, {
          status: "Available",
          assignedStudentId: null,
          assignedStudentName: null,
          lastUpdated: serverTimestamp(),
        });
      }
    } catch (_) { /* best effort — the desk can also free the seat by hand */ }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};
