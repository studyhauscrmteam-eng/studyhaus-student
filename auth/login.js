import { collection, query, where, getDocs } from "firebase/firestore";
import { db } from "../firebase/firebase.js";
import { login as authServiceLogin, loginWithPhone, setSessionPersistence, logout as authLogout } from "../services/authService.js";
import { getDocument } from "../services/firestoreService.js";
import { ROLES } from "./roles.js";
import { toUserFriendlyAuthError } from "./errorMessages.js";

/**
 * Helper to retry an operation with exponential backoff
 */
const retryWithBackoff = async (fn, retries = 3, delay = 500) => {
  try {
    return await fn();
  } catch (error) {
    if (retries <= 0) throw error;
    await new Promise((resolve) => setTimeout(resolve, delay));
    return retryWithBackoff(fn, retries - 1, delay * 2);
  }
};

/**
 * Get dashboard URL based on the user's role
 */
export const getRedirectUrlForRole = (rawRole) => {
  let role = rawRole;
  if (role === "Admin" || role === "owner" || role === "admin" || role === "Owner") {
    role = ROLES.OWNER;
  }

  switch (role) {
    case ROLES.OWNER:
      return "/admin/dashboard.html";
    case ROLES.MANAGER:
      return "/manager/dashboard.html";
    case ROLES.EMPLOYEE:
      return "/employee/dashboard.html";
    case ROLES.STUDENT:
      return "/unauthorized.html";
    default:
      return "/unauthorized.html";
  }
};

/**
 * Resolve the user's profile/role WITHOUT redirecting (shared lookup).
 * @returns {Promise<{userDoc, docId}>}
 */
const resolveUserRole = async (user) => {
  let userDoc = null;
  let docId = user.uid;

  // 1. Check the canonical 'users' collection first (where register.js writes)
  try {
    userDoc = await retryWithBackoff(() => getDocument("users", user.uid));
  } catch (_) { /* ignore permission errors */ }

  // 2. Also check role-named collections (Manager, Employee, Owner/Admin)
  //    — handles documents created manually in Firestore by an admin.
  //    "students" is checked FIRST: admitted students have students/{uid}
  //    and no users doc, and the other collections deny reads for them
  //    (permission-denied retries would stall the login for seconds).
  if (!userDoc || !userDoc.role) {
    const roleCollections = ["students", "Manager", "Employee", "Owner", "Admin"];
    for (const col of roleCollections) {
      try {
        const doc = await retryWithBackoff(() => getDocument(col, user.uid));
        if (doc) { userDoc = doc; break; }
      } catch (_) { /* ignore permission errors for unauthorized collections */ }
    }
  }

  // 3. Email-based search across role collections for manually created users
  if (!userDoc || !userDoc.role) {
    const searchCollections = ["users", "Manager", "Employee", "students"];
    for (const col of searchCollections) {
      try {
        const q = query(collection(db, col), where("email", "==", user.email));
        const snap = await getDocs(q);
        if (!snap.empty) {
          userDoc = snap.docs[0].data();
          docId = snap.docs[0].id;
          break;
        }
      } catch (_) { /* collection may not exist, skip */ }
    }
  }

  // 4. Default role to Student if a doc was found but role field is missing
  if (userDoc && !userDoc.role) {
    userDoc.role = "Student";
  }

  if (!userDoc || !userDoc.role) {
    if (user.email === "admin@studyhaus.com") {
      // Auto-heal the admin account if it got stuck due to previous permission errors
      const docData = {
        uid: user.uid,
        email: user.email,
        name: "Admin User",
        role: "Owner/Admin",
        status: "Active",
        createdAt: new Date().toISOString(),
      };
      const { setDoc, doc } = await import("firebase/firestore");
      await setDoc(doc(db, "users", user.uid), docData);
      userDoc = docData;
      docId = user.uid;
    } else {
      throw new Error(
        "User profile not found. Please contact the administration to complete your setup."
      );
    }
  }

  if (userDoc.status === "disabled" || userDoc.status === "Inactive" || userDoc.status === "Old" || userDoc.status === "Old Student") {
    throw new Error("Account Disabled, Inactive, or Moved to Old Students. Please contact administration.");
  }

  // Revoke gate: Clear login sets loginRevoked=true on the doc.
  // Revoked users are signed out and refused here.
  if (userDoc.loginRevoked === true) {
    try { await authLogout(); } catch (_) { }
    try { localStorage.removeItem("userRole"); localStorage.removeItem("userId"); } catch (_) { }
    throw new Error("This login has been revoked by the administrator. Please contact the office.");
  }

  return { userDoc, docId };
};

/**
 * Complete a login: resolve the user's profile/role, cache it in
 * localStorage, then redirect to that role's dashboard. Shared by the staff
 * email login and the Student Portal (phone/email) login.
 * @param {Object} user - authenticated Firebase user
 */
export const completeLogin = async (user) => {
  const { userDoc, docId } = await resolveUserRole(user);

  localStorage.setItem("userRole", userDoc.role);
  localStorage.setItem("userId", docId); // Store actual doc ID, whether UID or auto-id

  window.location.href = getRedirectUrlForRole(userDoc.role);
};

/**
 * Handle staff login flow (email + password)
 * @param {string} email 
 * @param {string} password 
 */
export const handleLogin = async (email, password) => {
  try {
    await setSessionPersistence();
    const user = await authServiceLogin(email, password);
    await completeLogin(user);
  } catch (error) {
    throw new Error(toUserFriendlyAuthError(error));
  }
};

/**
 * Handle Student Portal login (10-digit phone or email + password).
 * STUDENTS ONLY: any staff/admin account is signed straight back out —
 * this gate is what keeps non-students out of the student portal even if
 * they know a staff password. Resolves the role and redirects explicitly —
 * never leaves the login page hanging silently if profile lookup fails.
 * @param {string} identifier - phone number or email
 * @param {string} password 
 */
export const handlePhoneLogin = async (identifier, password) => {
  try {
    await setSessionPersistence();
    const user = await loginWithPhone(identifier, password);
    const { userDoc, docId } = await resolveUserRole(user);
    if (userDoc.role !== ROLES.STUDENT) {
      // Not a student — sign out immediately and refuse entry.
      try {
        const { logout } = await import("../services/authService.js");
        await logout();
      } catch (_) { }
      localStorage.removeItem("userRole");
      localStorage.removeItem("userId");
      throw new Error("This login is for students only. Staff, please use the admin portal.");
    }
    localStorage.setItem("userRole", userDoc.role);
    localStorage.setItem("userId", docId);
    window.location.href = getRedirectUrlForRole(userDoc.role);
  } catch (error) {
    throw new Error(toUserFriendlyAuthError(error));
  }
};
