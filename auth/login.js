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
 * Student-only copy: every login lands on the student dashboard.
 */
export const getRedirectUrlForRole = () => {
  return "/student/dashboard.html";
};

/**
 * Resolve the student's profile WITHOUT redirecting (shared lookup).
 * Student credential only: students/{uid} (admitted) then users/{uid}
 * (pending/new). No credential -> Login not created.
 * @returns {Promise<{userDoc, docId}>}
 */
const resolveUserRole = async (user) => {
    let userDoc = null;
    let docId = user.uid;

    // 1. Admitted students live at students/{uid}.
    try {
      userDoc = await retryWithBackoff(() => getDocument("students", user.uid));
    } catch (_) { /* ignore permission errors */ }

    // 2. Pending/new users live at users/{uid} (admin gives credentials).
    if (!userDoc) {
      try {
        userDoc = await retryWithBackoff(() => getDocument("users", user.uid));
        if (userDoc) docId = user.uid;
      } catch (_) { /* ignore permission errors */ }
    }

    // No credential in either place -> Login not created.
    if (!userDoc) {
      throw new Error(
        "Login not created. Please contact the administration to complete your setup."
      );
    }

    if (userDoc.status === "disabled" || userDoc.status === "Inactive" || userDoc.status === "Old" || userDoc.status === "Old Student") {
      throw new Error("Account Disabled, Inactive, or Moved to Old Students. Please contact administration.");
    }

    // Revoke gate (read-only): admin Clear sets loginRevoked=true.
    // Revoked users are signed out and refused here. No writes.
    if (userDoc.loginRevoked === true) {
      try { await authLogout(); } catch (_) { }
      try { localStorage.removeItem("userRole"); localStorage.removeItem("userId"); } catch (_) { }
      throw new Error("This login has been revoked by the administrator. Please contact the office.");
    }

    return { userDoc, docId };
};

/**
 * Complete a login: resolve the student's profile, cache it in
 * localStorage, then redirect to the student dashboard.
 * @param {Object} user - authenticated Firebase user
 */
export const completeLogin = async (user) => {
    const { userDoc, docId } = await resolveUserRole(user);

    localStorage.setItem("userRole", userDoc.role || ROLES.STUDENT);
    localStorage.setItem("userId", docId); // Store actual doc ID, whether UID or auto-id

    window.location.href = getRedirectUrlForRole();
};

/**
 * Handle email login flow (email + password)
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
 * @param {string} identifier - phone number or email
 * @param {string} password
 */
export const handlePhoneLogin = async (identifier, password) => {
  try {
    await setSessionPersistence();
    const user = await loginWithPhone(identifier, password);
    const { userDoc, docId } = await resolveUserRole(user);
    if (userDoc.role && userDoc.role !== ROLES.STUDENT) {
      // Not a student — sign out immediately and refuse entry.
      try {
        const { logout } = await import("../services/authService.js");
        await logout();
      } catch (_) {}
      localStorage.removeItem("userRole");
      localStorage.removeItem("userId");
      throw new Error("This login is for students only.");
    }
    localStorage.setItem("userRole", userDoc.role || ROLES.STUDENT);
    localStorage.setItem("userId", docId);
    window.location.href = getRedirectUrlForRole();
  } catch (error) {
    throw new Error(toUserFriendlyAuthError(error));
  }
};
