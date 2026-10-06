import { collection, query, where, getDocs } from "firebase/firestore";
import { db } from "../firebase/firebase.js";

/**
 * Checks if a transaction ID already exists in the payments collection.
 * Prevents students from reusing an old transaction ID.
 */
export const validateTransactionId = async (transactionId) => {
  if (!transactionId || transactionId.trim() === "") {
    throw new Error("Transaction ID is required.");
  }

  const paymentsRef = collection(db, "payments");
  const q = query(paymentsRef, where("transactionId", "==", transactionId.trim()));
  const snap = await getDocs(q);

  if (!snap.empty) {
    throw new Error(`Transaction ID ${transactionId} has already been used.`);
  }

  return true;
};
