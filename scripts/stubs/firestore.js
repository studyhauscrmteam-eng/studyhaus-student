/**
 * Test double for the bare specifier `firebase/firestore`.
 *
 * seatMapUI.js imports getDocs/collection/query/where at module scope but the
 * SIGNUP branch never calls them (it only uses listenToAllSeats), so throwing
 * on call is a feature: if a future edit makes signup reach for Firestore
 * directly, this test fails loudly instead of silently passing.
 */
const boom = (name) => () => {
  throw new Error(
    `seat-map render test: signup mode called Firestore directly (${name}). ` +
      "Signups must read seats through listenToAllSeats."
  );
};

export const getDocs = boom("getDocs");
export const collection = boom("collection");
export const query = boom("query");
export const where = boom("where");
export const orderBy = boom("orderBy");
export const doc = boom("doc");
export const getDoc = boom("getDoc");
export const setDoc = boom("setDoc");
export const updateDoc = boom("updateDoc");
export const onSnapshot = boom("onSnapshot");
export const serverTimestamp = boom("serverTimestamp");
export const writeBatch = boom("writeBatch");
export const runTransaction = boom("runTransaction");
