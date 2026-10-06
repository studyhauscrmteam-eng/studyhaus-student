import { collection, query, where, onSnapshot, addDoc, setDoc, getDocs, doc, updateDoc, getDoc, deleteDoc, writeBatch, serverTimestamp, orderBy } from "firebase/firestore";
import { db } from "../firebase/firebase.js";
import { validateSeatAssignment } from "./seatValidation.js";

// ===============================================
// SEAT INITIALIZATION & LISTENERS
// ===============================================

// ── Library room plan: exact spec positions (col 1-4, row 1-based) ──────────
// Ground Floor 4 cols × 18 rows (A1-A68), First Floor 4 cols × 11 rows (B1-B40).
// Used to seed col/row so the map is data-driven but looks identical.
const GROUND_COLS_RAW = [
  [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18],
  [null,34,33,32,31,30,29,28,27,26,25,24,67,23,22,21,20,19],
  [null,35,36,null,37,38,39,40,41,42,null,43,68,44,45,46,47,48],
  [66,65,64,63,62,61,60,59,58,57,56,55,54,53,52,51,50,49],
];
const FIRST_COLS_RAW = [
  [1,2,3,4,5,6,7,8,9,10,null],
  [null,20,19,18,17,16,15,14,13,12,11],
  [null,21,22,23,24,25,26,27,28,29,30],
  [40,39,38,37,36,35,34,33,32,31,null],
];

const PLAN_POSITION = (() => {
  const m = new Map();
  GROUND_COLS_RAW.forEach((colArr, ci) => {
    colArr.forEach((n, ri) => {
      if (n == null) return;
      m.set(`A${n}`, { floor: "Ground Floor", col: ci + 1, row: ri + 1 });
    });
  });
  FIRST_COLS_RAW.forEach((colArr, ci) => {
    colArr.forEach((n, ri) => {
      if (n == null) return;
      m.set(`B${n}`, { floor: "First Floor", col: ci + 1, row: ri + 1 });
    });
  });
  return m;
})();

export const seedInitialSeats = async () => {
  const seatsRef = collection(db, "seats");
  const snap = await getDocs(seatsRef);

  if (snap.empty) {
    console.log("Seeding library seat plan: A1-A68 Ground Floor, B1-B40 First Floor...");
    // Single batched write (was 108 sequential round-trips) — the map
    // appears in about a second instead of hanging on "0 seats".
    const batch = writeBatch(db);
    const plan = [
      { prefix: 'A', count: 68, floor: 'Ground Floor' },
      { prefix: 'B', count: 40, floor: 'First Floor' }
    ];

    for (const { prefix, count, floor } of plan) {
      for (let i = 1; i <= count; i++) {
        const name = `${prefix}${i}`;
        const pos = PLAN_POSITION.get(name) || {};
        // Deterministic doc ID = seat name: re-running seed (two tabs at
        // once, double-clicks) overwrites the same docs instead of cloning
        // duplicates. This is THE fix for "two same A1 seats".
        batch.set(doc(seatsRef, name), {
          seatNumber: name,
          floor,
          col: pos.col ?? null,
          row: pos.row ?? null,
          status: "Available",
          assignedStudentId: null,
          assignedStudentName: null,
          planType: null,
          lastUpdated: serverTimestamp()
        });
      }
    }
    await batch.commit();
  }
};

/**
 * Self-healing occupancy reconcile. Runs on every admin Seats page open.
 * Fixes the two mismatches that make counts lie against the map:
 *  1. GHOST occupied — seat says Occupied but no Active student claims it
 *     (stale after deletes/edits) → released to Available.
 *  2. UNMARKED claim — an Active student holds a seatNumber whose doc(s)
 *     still say Available (after rebuilds/direct edits) → marked Occupied
 *     with the student's name. Missing plan-valid docs are recreated.
 *  3. ORPHAN claim — an Active student holds a seat name that is not on the
 *     library plan at all → reported (returned) so the page can show WHY
 *     that student's seat can't appear on the map. Never auto-deleted here.
 * Never touches Reserved / Maintenance / Inactive seats, never edits student
 * docs. Best-effort: failures only log.
 * @returns {Promise<{released: number, claimed: number, orphans: Array}>}
 */
export const reconcileSeatOccupancy = async () => {
  const empty = { released: 0, claimed: 0, orphans: [] };
  try {
    const [seatsSnap, studentsSnap] = await Promise.all([
      getDocs(collection(db, "seats")),
      getDocs(query(collection(db, "students"), where("status", "==", "Active")))
    ]);
    if (seatsSnap.empty) return empty;

    // Active claims by normalized seat name.
    const claims = new Map(); // normName -> { id, name }
    studentsSnap.forEach(stu => {
      const data = stu.data() || {};
      const raw = data.seatNumber;
      if (!raw) return;
      const n = normalizePlanName(raw);
      if (!claims.has(n)) {
        claims.set(n, { id: stu.id, name: data.name || "Student", planValid: PLAN_SEAT_NAMES.has(n) });
      }
    });

    // Which normalized names already have a doc.
    const present = new Set();
    seatsSnap.forEach(d => {
      const n = normalizePlanName((d.data() || {}).seatNumber);
      if (PLAN_SEAT_NAMES.has(n)) present.add(n);
    });

    const batch = writeBatch(db);
    let released = 0, claimed = 0, created = 0;
    const orphans = [];
    seatsSnap.forEach(d => {
      const data = d.data() || {};
      const n = normalizePlanName(data.seatNumber);
      if (!PLAN_SEAT_NAMES.has(n)) return; // non-plan docs: cleanup owns these
      const claim = claims.get(n);
      if (data.status === "Occupied" && !claim) {
        batch.update(d.ref, {
          status: "Available",
          assignedStudentId: null,
          assignedStudentName: null,
          planType: null,
          lastUpdated: serverTimestamp()
        });
        released++;
      } else if (data.status === "Available" && claim) {
        batch.update(d.ref, {
          status: "Occupied",
          assignedStudentId: claim.id,
          assignedStudentName: claim.name,
          lastUpdated: serverTimestamp()
        });
        claimed++;
      }
    });

    // Recreate missing docs for plan-valid claims (plan doc gone entirely).
    const seatsRef = collection(db, "seats");
    claims.forEach((claim, n) => {
      if (!claim.planValid) {
        orphans.push({ studentName: claim.name, seatNumber: n });
        return;
      }
      if (!present.has(n)) {
        const want = PLAN_POSITION.get(n) || {};
        batch.set(doc(seatsRef, n), {
          seatNumber: n,
          floor: want.floor || (String(n).startsWith("B") ? "First Floor" : "Ground Floor"),
          col: want.col ?? null,
          row: want.row ?? null,
          status: "Occupied",
          assignedStudentId: claim.id,
          assignedStudentName: claim.name,
          planType: null,
          lastUpdated: serverTimestamp()
        });
        created++;
      }
    });

    if (released + claimed + created > 0) await batch.commit();
    if (created) claimed += created;
    return { released, claimed, orphans };
  } catch (e) {
    console.warn("[seats] reconcile skipped:", e?.message || e);
    return empty;
  }
};

// "A01" -> "A1" (same matching the seat map uses)
const normalizePlanName = (value) => {
  const raw = String(value == null ? "" : value).trim().toUpperCase().replace(/\s+/g, "");
  const m = raw.match(/^([A-Z]+)-?0*(\d+)$/);
  return m ? `${m[1]}${Number(m[2])}` : raw;
};

const PLAN_SEAT_NAMES = (() => {
  const names = new Set();
  for (let i = 1; i <= 68; i++) names.add(`A${i}`);
  for (let i = 1; i <= 40; i++) names.add(`B${i}`);
  return names;
})();

// One-time backend fix: rebuild EVERYTHING to match the library map.
// Deletes all seats, recreates A1-A68 (Ground) + B1-B40 (First) as Available.
// Student seats that fit the plan are kept (renamed to plan form, e.g. A01 -> A1);
// old seats that fit nowhere are cleared. Old attendance history is untouched.
// Run once from the browser console while logged in as staff:
//   await window.rebuildSeatPlan()
export const rebuildSeatPlan = async () => {
  if (!window.confirm("Rebuild the seat map backend?\n\nALL seats will be deleted and recreated as A1-A68 (Ground Floor) + B1-B40 (First Floor).\n\nStudent seats that fit the plan are kept (renamed to plan form). Old seats that fit nowhere are cleared.")) {
    return { success: false, error: "cancelled" };
  }

  const seatsRef = collection(db, "seats");
  const existing = await getDocs(seatsRef);
  await Promise.all(existing.docs.map(d => deleteDoc(doc(db, "seats", d.id))));

  for (const target of [{ prefix: "A", count: 68, floor: "Ground Floor" }, { prefix: "B", count: 40, floor: "First Floor" }]) {
    for (let i = 1; i <= target.count; i++) {
      const name = `${target.prefix}${i}`;
      const pos = PLAN_POSITION.get(name) || {};
      await setDoc(doc(seatsRef, name), {
        seatNumber: name,
        floor: target.floor,
        col: pos.col ?? null,
        row: pos.row ?? null,
        status: "Available",
        assignedStudentId: null,
        assignedStudentName: null,
        planType: null,
        lastUpdated: serverTimestamp()
      });
    }
  }

  const studentsSnap = await getDocs(collection(db, "students"));
  const batch = writeBatch(db);
  let kept = 0, cleared = 0;
  studentsSnap.forEach(stu => {
    const current = stu.data().seatNumber;
    if (!current) return;
    const normed = normalizePlanName(current);
    if (PLAN_SEAT_NAMES.has(normed)) {
      if (current !== normed) batch.update(stu.ref, { seatNumber: normed });
      kept++;
    } else {
      batch.update(stu.ref, { seatNumber: null });
      cleared++;
    }
  });
  await batch.commit();

  return { success: true, kept, cleared };
};

if (typeof window !== "undefined") window.rebuildSeatPlan = rebuildSeatPlan;

// Automatic backend reconcile: the map is a real playground, so the backend
// must hold EXACTLY the library plan. On every admin map open:
//  1. deletes seats that are NOT part of the plan ("2","3","4"… / R-names / dupes)
//  2. renames padded names to plan form ("A01" -> "A1")
//  3. creates any missing plan seats (A1-A68 + B1-B40) as Available at their
//     spec col/row — this kills the dashed "click-to-create" tiles forever
//  4. backfills col/row on plan seats that lack correct positions
// Student seat refs are fixed the same way (kept+renamed when fitting, cleared
// when not). Safe to run on every admin map open — no-ops once clean.
export const cleanupNonPlanSeats = async () => {
  try {
    const seatsRef = collection(db, "seats");
    const snap = await getDocs(seatsRef);
    if (snap.empty) return { success: true, deleted: 0, renamed: 0, created: 0, positioned: 0, clearedStudents: 0, fixedStudents: 0 };

    const exactNames = new Set();
    snap.forEach(d => { const n = d.data() && d.data().seatNumber; if (n) exactNames.add(n); });

    const toDeleteRefs = [];
    const deletedIds = new Set();
    const renames = [];

    // 0. DEDUPE identical normalized names ("two A1s") FIRST — the old code
    // never caught these. Keep the richest record (Occupied > Reserved >
    // Available, then one with an assignee, then one with a position),
    // adopt an assignee onto the keeper when it lacks one, delete the rest.
    // Students reference seats by NAME, so deleting dupe docs breaks nothing.
    const statusRank = (s) => s === "Occupied" ? 3 : s === "Reserved" ? 2 : s === "Available" ? 1 : 0;
    const byName = new Map();
    snap.forEach(d => {
      const name = d.data() && d.data().seatNumber;
      if (!name) return;
      const n = normalizePlanName(name);
      if (!PLAN_SEAT_NAMES.has(n)) return;
      if (!byName.has(n)) byName.set(n, []);
      byName.get(n).push(d);
    });
    const dedupeMerges = [];
    let deduped = 0;
    byName.forEach((docs) => {
      if (docs.length < 2) return;
      const sorted = [...docs].sort((a, b) => {
        const da = a.data() || {}, db = b.data() || {};
        return (statusRank(db.status) - statusRank(da.status))
          || ((db.assignedStudentId ? 1 : 0) - (da.assignedStudentId ? 1 : 0))
          || (((db.col != null) ? 1 : 0) - ((da.col != null) ? 1 : 0));
      });
      const keeper = sorted[0];
      const kd = keeper.data() || {};
      if (!kd.assignedStudentId) {
        const donor = sorted.find(d => (d.data() || {}).assignedStudentId);
        if (donor) dedupeMerges.push({ keeperRef: keeper.ref, donor: donor.data() });
      }
      sorted.slice(1).forEach(d => { toDeleteRefs.push(d.ref); deletedIds.add(d.id); deduped++; });
    });

    snap.forEach(d => {
      if (deletedIds.has(d.id)) return; // already condemned as a dupe
      const name = d.data() && d.data().seatNumber;
      if (!name) { toDeleteRefs.push(d.ref); return; }
      const n = normalizePlanName(name);
      if (!PLAN_SEAT_NAMES.has(n)) { toDeleteRefs.push(d.ref); return; }
      if (name !== n) {
        if (exactNames.has(n)) { toDeleteRefs.push(d.ref); }
        else { renames.push({ ref: d.ref, to: n }); exactNames.add(n); }
      }
    });

    await Promise.all(toDeleteRefs.map(r => deleteDoc(r)));
    await Promise.all(dedupeMerges.map(m => {
      const upd = {
        assignedStudentId: m.donor.assignedStudentId || null,
        assignedStudentName: m.donor.assignedStudentName || null,
        planType: m.donor.planType || null,
        lastUpdated: serverTimestamp()
      };
      if (m.donor.status === "Occupied") upd.status = "Occupied";
      return updateDoc(m.keeperRef, upd);
    }));
    await Promise.all(renames.map(r => updateDoc(r.ref, { seatNumber: r.to, lastUpdated: serverTimestamp() })));

    // Re-read survivors, then create missing plan seats + fix positions.
    const afterSnap = await getDocs(seatsRef);
    const present = new Set();
    const posFixes = [];
    afterSnap.forEach(d => {
      const data = d.data() || {};
      const n = normalizePlanName(data.seatNumber);
      if (PLAN_SEAT_NAMES.has(n)) {
        present.add(n);
        const want = PLAN_POSITION.get(n);
        if (want && (data.col !== want.col || data.row !== want.row || (data.floor || "Ground Floor") !== want.floor)) {
          posFixes.push({ ref: d.ref, want });
        }
      }
    });

    let created = 0;
    const missing = [...PLAN_SEAT_NAMES].filter(n => !present.has(n));
    await Promise.all(missing.map(async (n) => {
      const want = PLAN_POSITION.get(n) || {};
      // Deterministic ID: concurrent runs converge on the same doc instead
      // of cloning a second copy.
      await setDoc(doc(seatsRef, n), {
        seatNumber: n,
        floor: want.floor || (String(n).startsWith("B") ? "First Floor" : "Ground Floor"),
        col: want.col ?? null,
        row: want.row ?? null,
        status: "Available",
        assignedStudentId: null,
        assignedStudentName: null,
        planType: null,
        lastUpdated: serverTimestamp()
      });
      created++;
    }));
    await Promise.all(posFixes.map(p => updateDoc(p.ref, {
      col: p.want.col, row: p.want.row, floor: p.want.floor, lastUpdated: serverTimestamp()
    })));

    const studentsSnap = await getDocs(collection(db, "students"));
    const batch = writeBatch(db);
    let clearedStudents = 0, fixedStudents = 0;
    studentsSnap.forEach(stu => {
      const current = stu.data().seatNumber;
      if (!current) return;
      const n = normalizePlanName(current);
      if (!PLAN_SEAT_NAMES.has(n)) { batch.update(stu.ref, { seatNumber: null }); clearedStudents++; }
      else if (current !== n) { batch.update(stu.ref, { seatNumber: n }); fixedStudents++; }
    });
    await batch.commit();

    return { success: true, deleted: toDeleteRefs.length, deduped, renamed: renames.length, created, positioned: posFixes.length, clearedStudents, fixedStudents };
  } catch (e) {
    console.warn("cleanupNonPlanSeats skipped:", e);
    return { success: false, error: e.message };
  }
};

// ── Playground operations: seats are real backend docs with col/row ─────────
export const saveSeatPosition = async (seatId, col, row) => {
  try {
    await updateDoc(doc(db, "seats", seatId), { col, row, lastUpdated: serverTimestamp() });
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
};

export const renameSeat = async (seatId, newNumber) => {
  try {
    const normed = normalizePlanName(newNumber);
    if (!/^[AB]\d+$/.test(normed)) throw new Error("Seat number must look like A12 or B7.");
    const seatsSnap = await getDocs(collection(db, "seats"));
    let clash = false;
    seatsSnap.forEach(d => {
      if (d.id !== seatId && normalizePlanName(d.data().seatNumber) === normed) clash = true;
    });
    if (clash) throw new Error(`Seat ${normed} already exists.`);
    const seatRef = doc(db, "seats", seatId);
    const snap = await getDoc(seatRef);
    if (!snap.exists()) throw new Error("Seat not found.");
    await updateDoc(seatRef, { seatNumber: normed, lastUpdated: serverTimestamp() });
    const data = snap.data();
    if (data.assignedStudentId) {
      try { await updateDoc(doc(db, "students", data.assignedStudentId), { seatNumber: normed }); } catch (_) {}
    }
    return { success: true, seatNumber: normed };
  } catch (e) { return { success: false, error: e.message }; }
};

export const addSeatAt = async (floor, col, row) => {
  try {
    const seatsSnap = await getDocs(collection(db, "seats"));
    let occupied = false, maxNum = 0;
    const prefix = floor === "First Floor" ? "B" : "A";
    seatsSnap.forEach(d => {
      const s = d.data() || {};
      if ((s.floor || "Ground Floor") === floor && Number(s.col) === Number(col) && Number(s.row) === Number(row)) occupied = true;
      const n = normalizePlanName(s.seatNumber);
      if (n.startsWith(prefix)) { const num = Number(n.slice(prefix.length)); if (Number.isFinite(num) && num > maxNum) maxNum = num; }
    });
    if (occupied) throw new Error("That cell is already occupied.");
    const seatNumber = `${prefix}${maxNum + 1}`;
    await addDoc(collection(db, "seats"), {
      seatNumber, floor, col, row,
      status: "Available",
      assignedStudentId: null,
      assignedStudentName: null,
      planType: null,
      lastUpdated: serverTimestamp()
    });
    return { success: true, seatNumber };
  } catch (e) { return { success: false, error: e.message }; }
};

export const deleteSeatById = async (seatId) => {
  try {
    const seatRef = doc(db, "seats", seatId);
    const snap = await getDoc(seatRef);
    if (!snap.exists()) throw new Error("Seat not found.");
    const data = snap.data();
    if (data.assignedStudentId) {
      try { await updateDoc(doc(db, "students", data.assignedStudentId), { seatNumber: null }); } catch (_) {}
    }
    await deleteDoc(seatRef);
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
};

// NOTE: seat creation from the map UI is handled by addSeatAt (edit-layout
// mode, cell-anchored). The free-floating addSingleSeat helper is removed.

export const listenToAllSeats = (onUpdate) => {
  const q = query(collection(db, "seats"), orderBy("seatNumber"));
  return onSnapshot(q, (snapshot) => {
    const seats = [];
    snapshot.forEach(doc => seats.push({ id: doc.id, ...doc.data() }));
    onUpdate(seats);
  });
};

// ===============================================
// ADMIN ACTIONS
// ===============================================

export const assignSeat = async (seatId, student) => {
  try {
    const seatRef = doc(db, "seats", seatId);
    const snap = await getDoc(seatRef);
    if (!snap.exists()) throw new Error("Seat not found.");

    validateSeatAssignment(snap.data());

    // Update Seat (students may self-reserve an Available seat under new rules)
    try {
      await updateDoc(seatRef, {
        status: "Reserved", // It's assigned/reserved for this student
        assignedStudentId: student.id,
        assignedStudentName: student.name,
        planType: student.planName || "Unknown",
        lastUpdated: serverTimestamp()
      });
    } catch (e) {
      const msg = String((e && (e.code || e.message)) || e);
      if (/permission|insufficient/i.test(msg)) {
        throw new Error("Seat reservation denied. Please deploy the latest firestore.rules, or ask staff to assign the seat.");
      }
      throw e;
    }

    // Also update Student profile so they know their seat.
    // New self-admission users don't have a students/{uid} doc yet — skip quietly.
    try {
      const studentRef = doc(db, "students", student.id);
      await updateDoc(studentRef, {
        seatNumber: snap.data().seatNumber,
        updatedAt: serverTimestamp()
      });
    } catch (_) { /* admission flow creates the doc moments later */ }

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

export const unassignSeat = async (seatId) => {
  try {
    const seatRef = doc(db, "seats", seatId);
    const snap = await getDoc(seatRef);
    if (!snap.exists()) throw new Error("Seat not found.");

    const data = snap.data();
    if (data.assignedStudentId) {
      // Clear from student profile (best effort — doc may not exist yet)
      try {
        const studentRef = doc(db, "students", data.assignedStudentId);
        await updateDoc(studentRef, { seatNumber: null });
      } catch (_) {}
    }

    // Reset Seat
    await updateDoc(seatRef, {
      status: "Available",
      assignedStudentId: null,
      assignedStudentName: null,
      planType: null,
      lastUpdated: serverTimestamp()
    });

    return { success: true };
  } catch (error) {
    const msg = String((error && (error.code || error.message)) || error);
    if (/permission|insufficient/i.test(msg)) {
      return { success: false, error: "Seat release denied. Please deploy the latest firestore.rules." };
    }
    return { success: false, error: error.message };
  }
};

export const changeSeatStatus = async (seatId, newStatus) => {
  try {
    const seatRef = doc(db, "seats", seatId);
    await updateDoc(seatRef, {
      status: newStatus,
      lastUpdated: serverTimestamp()
    });
    return { success: true };
  } catch (error) {
    const msg = String((error && (error.code || error.message)) || error);
    if (/permission|insufficient/i.test(msg)) {
      return { success: false, error: "Seat update denied. Please deploy the latest firestore.rules." };
    }
    return { success: false, error: error.message };
  }
};
