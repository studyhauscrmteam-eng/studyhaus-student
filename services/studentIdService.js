import { doc, runTransaction, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase/firebase.js";

const COUNTER_REF = () => doc(db, "counters", "students");
const PREFIX = "SH-";
const PAD = 4;

/**
 * Returns the next sequential student number, e.g. SH-0001, SH-0002 …
 * Uses a Firestore transaction so two admins adding at the same time
 * can never receive the same number.
 */
export const getNextStudentId = async () => {
  const next = await runTransaction(db, async (tx) => {
    const snap = await tx.get(COUNTER_REF());
    const current = snap.exists() ? Number(snap.data().next || 1) : 1;
    const safe = Number.isFinite(current) && current > 0 ? Math.floor(current) : 1;
    tx.set(COUNTER_REF(), { next: safe + 1, updatedAt: serverTimestamp() }, { merge: true });
    return safe;
  });
  return `${PREFIX}${String(next).padStart(PAD, "0")}`;
};

/**
 * Ensures a student/admission record has a unique sequential studentId.
 * Existing records keep their ID (never overwritten).
 * @returns {Promise<string>} the studentId
 */
export const ensureStudentId = async (data) => {
  if (data && data.studentId && String(data.studentId).trim() !== "") {
    return String(data.studentId).trim();
  }
  const id = await getNextStudentId();
  data.studentId = id;
  return id;
};
