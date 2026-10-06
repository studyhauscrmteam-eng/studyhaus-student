import { doc, getDoc, setDoc, onSnapshot } from "firebase/firestore";
import { db } from "../firebase/firebase.js";

const SETTINGS_DOC_ID = "global_settings";
const SETTINGS_COLLECTION = "settings";

/**
 * Fetches the global settings from Firestore
 */
export const getSettings = async () => {
  try {
    const docRef = doc(db, SETTINGS_COLLECTION, SETTINGS_DOC_ID);
    const docSnap = await getDoc(docRef);
    if (docSnap.exists()) {
      return docSnap.data();
    } else {
      return {};
    }
  } catch (error) {
    // Students are not allowed to read settings (rules: staff only) and the
    // callers already fall back to defaults — don't spam their console.
    if (error && error.code !== "permission-denied") {
      console.error("Error fetching settings:", error);
    }
    return {};
  }
};

/**
 * Saves global settings to Firestore
 */
export const saveSettings = async (settingsData) => {
  try {
    const docRef = doc(db, SETTINGS_COLLECTION, SETTINGS_DOC_ID);
    await setDoc(docRef, settingsData, { merge: true });
    return true;
  } catch (error) {
    console.error("Error saving settings:", error);
    throw error;
  }
};

/**
 * Listens to settings changes (useful for live updates)
 */
export const listenToSettings = (callback) => {
  const docRef = doc(db, SETTINGS_COLLECTION, SETTINGS_DOC_ID);
  return onSnapshot(docRef, (docSnap) => {
    if (docSnap.exists()) {
      callback(docSnap.data());
    } else {
      callback({});
    }
  });
};
