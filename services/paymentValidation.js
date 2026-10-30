import { collection, query, where, getDocs, doc, getDoc } from "firebase/firestore";
import { auth, db } from "../firebase/firebase.js";

/**
 * Checks if a transaction ID already exists in uniqueness claims or payments.
 * Prevents students from reusing an old transaction ID while strictly handling
 * Firestore read permissions for non-staff students.
 */
export const validateTransactionId = async (transactionId) => {
  if (!transactionId || transactionId.trim() === "") {
    throw new Error("Transaction ID is required.");
  }

  const cleanTxn = String(transactionId).trim();
  const key = cleanTxn.toLowerCase();

  // 1. Check uniqueness claim (readable by any signed-in user via security rules)
  try {
    const claimSnap = await getDoc(doc(db, "uniqueness", "txn_" + key));
    if (claimSnap && claimSnap.exists()) {
      throw new Error(`Transaction ID ${cleanTxn} has already been used.`);
    }
  } catch (err) {
    if (err.message && err.message.includes("already been used")) {
      throw err;
    }
  }

  // 2. Check student's own payments (allowed by security rules: studentId == auth.uid)
  try {
    const currentUid = auth.currentUser ? auth.currentUser.uid : null;
    if (currentUid) {
      const ownQ = query(
        collection(db, "payments"),
        where("studentId", "==", currentUid),
        where("transactionId", "==", cleanTxn)
      );
      const ownSnap = await getDocs(ownQ);
      if (!ownSnap.empty) {
        throw new Error(`Transaction ID ${cleanTxn} has already been used.`);
      }
    }
  } catch (err) {
    if (err.message && err.message.includes("already been used")) {
      throw err;
    }
  }

  // 3. For staff (or if permissions permit), check global payments; catch permission denial gracefully
  try {
    const globalQ = query(
      collection(db, "payments"),
      where("transactionId", "==", cleanTxn)
    );
    const globalSnap = await getDocs(globalQ);
    if (!globalSnap.empty) {
      throw new Error(`Transaction ID ${cleanTxn} has already been used.`);
    }
  } catch (err) {
    if (err.message && err.message.includes("already been used")) {
      throw err;
    }
    // Permission denial for non-staff is expected because students can only query their own docs.
  }

  return true;
};
