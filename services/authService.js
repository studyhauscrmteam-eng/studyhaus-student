import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged as firebaseOnAuthStateChanged,
  sendPasswordResetEmail,
  setPersistence,
  browserLocalPersistence,
  getAuth
} from "firebase/auth";
import { initializeApp, deleteApp } from "firebase/app";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "../firebase/firebase.js";
import { firebaseConfig } from "../config/firebaseConfig.js";
import { normalizePhone, phoneToAuthEmail, authEmailToPhone, isValidPhone } from "./phoneUtils.js";

/**
 * Configure Firebase to persist session locally
 * @returns {Promise<void>}
 */
export const setSessionPersistence = async () => {
  try {
    await setPersistence(auth, browserLocalPersistence);
  } catch (error) {
    console.error("Error setting persistence:", error.message);
    throw error;
  }
};

/**
 * Log in a user with email and password
 * @param {string} email - The user's email address
 * @param {string} password - The user's password
 * @returns {Promise<Object>} The authenticated user object
 */
export const login = async (email, password) => {
  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    return userCredential.user;
  } catch (error) {
    throw error;
  }
};

/**
 * Register a new user with email and password
 * @param {string} email - The new user's email address
 * @param {string} password - The new user's password
 * @returns {Promise<Object>} The newly created user object
 */
export const register = async (email, password) => {
  try {
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    return userCredential.user;
  } catch (error) {
    console.error("Error during registration:", error.message);
    throw error;
  }
};

/**
 * Log out the currently authenticated user
 * @returns {Promise<void>}
 */
export const logout = async () => {
  try {
    await signOut(auth);
  } catch (error) {
    console.error("Error during logout:", error.message);
    throw error;
  }
};

/**
 * Send password reset email
 * @param {string} email - The user's email address
 * @returns {Promise<void>}
 */
export const resetPassword = async (email) => {
  try {
    await sendPasswordResetEmail(auth, email);
  } catch (error) {
    console.error("Error sending reset email:", error.message);
    throw error;
  }
};

/**
 * Get the currently authenticated user (if any)
 * @returns {Object|null} The user object or null if not logged in
 */
export const getCurrentUser = () => {
  return auth.currentUser;
};

/**
 * Listen for authentication state changes (login, logout)
 * @param {function} callback - Function to execute when auth state changes
 * @returns {function} Unsubscribe function to stop listening
 */
export const onAuthStateChanged = (callback) => {
  return firebaseOnAuthStateChanged(auth, callback);
};

/**
 * Login with phone number or email (normalizes to Firebase Auth email format)
 * @param {string} identifier - Phone number in any format or email
 * @param {string} password - User's password
 * @returns {Promise<Object>} The authenticated user object
 */
export const loginWithPhone = async (identifier, password) => {
  // Check if it's a phone number (contains only digits, spaces, +, -, parentheses)
  const isPhone = /^[\d\s\-\+\(\)]{10,}$/.test(identifier);
  
  let authEmail;
  if (isPhone) {
    if (!isValidPhone(identifier)) {
      throw new Error("Invalid phone number. Please enter a valid 10-digit number.");
    }
    authEmail = phoneToAuthEmail(identifier);
  } else {
    // Assume it's an email
    authEmail = identifier.trim();
  }

  try {
    return await login(authEmail, password);
  } catch (error) {
    // Firebase email matching can be case-sensitive. Accounts created from
    // the admin panel are stored lowercased — retry with the lowercase form
    // so typing the ID exactly as shown on the student card always works.
    const code = error?.code || "";
    const lower = authEmail.toLowerCase();
    if (!isPhone && authEmail !== lower &&
        (code === "auth/invalid-credential" || code === "auth/user-not-found" || code === "auth/wrong-password")) {
      return login(lower, password);
    }
    throw error;
  }
};

/**
 * Register with phone number
 * @param {string} phone - Phone number in any format
 * @param {string} password - User's password
 * @returns {Promise<Object>} The newly created user object
 */
export const registerWithPhone = async (phone, password) => {
  if (!isValidPhone(phone)) {
    throw new Error("Invalid phone number. Please enter a valid 10-digit number.");
  }
  const authEmail = phoneToAuthEmail(phone);
  return register(authEmail, password);
};

/**
 * Get current user's phone number from auth email
 * @returns {string|null} 10-digit phone or null
 */
export const getCurrentUserPhone = () => {
  const user = auth.currentUser;
  if (!user?.email) return null;
  return authEmailToPhone(user.email);
};

// Re-export phone utilities for convenience
export { normalizePhone, phoneToAuthEmail, authEmailToPhone, isValidPhone } from "./phoneUtils.js";

/**
 * Create a real Firebase Auth account for an admitted student, so they can
 * sign in to the Student Portal with their Login ID + Password.
 *
 * IMPORTANT: this runs on a SECONDARY Firebase app instance. Creating a user
 * on the main instance would silently sign the currently logged-in admin out
 * (Firebase switches the session to the newly created user).
 *
 * @param {string} loginId - 10-digit phone number or an email address
 * @param {string} password - portal password (min 6 characters)
 * @returns {Promise<{uid: string, authEmail: string}>}
 */
export const createPortalAccount = async (loginId, password) => {
  const id = String(loginId || "").trim();
  const pass = String(password || "").trim();

  if (!id) throw new Error("Login ID is required to create a portal login.");
  if (!pass || pass.length < 6) throw new Error("Portal password must be at least 6 characters.");

  const isPhone = /^[\d\s\-\+\(\)]{10,}$/.test(id);
  let authEmail;
  if (isPhone) {
    if (!isValidPhone(id)) {
      throw new Error("Login ID must be a valid 10-digit phone number or an email address.");
    }
    authEmail = phoneToAuthEmail(id);
  } else {
    if (!id.includes("@")) {
      throw new Error("Login ID must be a phone number or an email address.");
    }
    authEmail = id.toLowerCase();
  }

  const secondaryApp = initializeApp(firebaseConfig, `portal-account-${Date.now()}`);
  try {
    const secondaryAuth = getAuth(secondaryApp);

    // If an account with these EXACT credentials already exists (e.g. the
    // student registered earlier), reuse it — a sign-in gives us the uid.
    try {
      const existing = await signInWithEmailAndPassword(secondaryAuth, authEmail, pass);
      const uid = existing.user.uid;
      await signOut(secondaryAuth).catch(() => {});
      // Never adopt a staff/admin account as a student login.
      const staffSnap = await getDoc(doc(db, "users", uid)).catch(() => null);
      if (staffSnap && staffSnap.exists()) {
        throw new Error(`"${id}" already belongs to a STAFF account. Use a different Login ID for this student.`);
      }
      return { uid, authEmail };
    } catch (verifyErr) {
      const vcode = verifyErr?.code || "";
      const notFound =
        vcode === "auth/invalid-credential" ||
        vcode === "auth/user-not-found" ||
        vcode === "auth/wrong-password";
      if (!notFound) throw verifyErr; // network/config problem — do not try to create
    }

    const cred = await createUserWithEmailAndPassword(secondaryAuth, authEmail, pass);
    await signOut(secondaryAuth).catch(() => {});
    return { uid: cred.user.uid, authEmail };
  } catch (error) {
    if (error?.code === "auth/email-already-in-use") {
      throw new Error(`"${id}" already has an account with a DIFFERENT password. If it's a staff/admin Login ID, use a different one — otherwise try the student's original password.`);
    }
    throw new Error(error?.message || "Portal account could not be created.");
  } finally {
    await deleteApp(secondaryApp).catch(() => {});
  }
};

/**
 * TEST a student's portal credentials WITHOUT touching the signed-in admin
 * session (runs on a secondary Firebase app instance).
 * @returns {Promise<{ok: boolean, authEmail: string, reason?: string}>}
 */
export const verifyPortalCredentials = async (loginId, password) => {
  const id = String(loginId || "").trim();
  const pass = String(password || "").trim();
  if (!id || !pass) {
    return { ok: false, authEmail: "", reason: "Enter BOTH Login ID and Password to test." };
  }

  const isPhone = /^[\d\s\-\+\(\)]{10,}$/.test(id);
  let authEmail;
  if (isPhone) {
    if (!isValidPhone(id)) {
      return { ok: false, authEmail: "", reason: "Login ID must be a valid 10-digit phone or an email." };
    }
    authEmail = phoneToAuthEmail(id);
  } else {
    authEmail = id.toLowerCase();
  }

  const secondaryApp = initializeApp(firebaseConfig, `verify-${Date.now()}`);
  try {
    const secondaryAuth = getAuth(secondaryApp);
    await signInWithEmailAndPassword(secondaryAuth, authEmail, pass);
    await signOut(secondaryAuth).catch(() => {});
    return { ok: true, authEmail };
  } catch (error) {
    const code = error?.code || "";
    if (code === "auth/invalid-credential" || code === "auth/user-not-found" || code === "auth/wrong-password") {
      return {
        ok: false,
        authEmail,
        reason: `No account matches "${authEmail}" + this password. Fill both fields and press Save Changes to create the login.`
      };
    }
    return { ok: false, authEmail, reason: error?.message || "Test failed." };
  } finally {
    await deleteApp(secondaryApp).catch(() => {});
  }
};
