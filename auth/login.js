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
 *
 * Order: students/{uid} -> users/{uid} -> self-heal via ensureStudentRecord().
 * The third step is what permanently removes the old "Login not created"
 * dead end: every authenticated account is guaranteed exactly one student
 * record (adopting a pre-portal record when one provably belongs to them).
 *
 * @returns {Promise<{userDoc, docId}>}
 */
const resolveUserRole = async (user) => {
    let userDoc = null;
    let docId = user.uid;

    // 1. The canonical record: students/{uid}.
    try {
      userDoc = await retryWithBackoff(() => getDocument("students", user.uid));
    } catch (_) { /* ignore permission errors */ }

    // 2. Fallback for accounts that only have a credential stub.
    if (!userDoc) {
      try {
        const uDoc = await retryWithBackoff(() => getDocument("users", user.uid));
        if (uDoc) {
          if (uDoc.studentId) {
            const sDoc = await retryWithBackoff(() => getDocument("students", uDoc.studentId));
            if (sDoc) {
              userDoc = sDoc;
              docId = uDoc.studentId;
            } else {
              userDoc = uDoc;
            }
          } else {
            userDoc = uDoc;
          }
        }
      } catch (_) { /* ignore permission errors */ }
    }

    // 3. Self-heal — create/adopt the record rather than refusing the login.
    if (!userDoc) {
      try {
        const { ensureStudentRecord } = await import("../services/onboardingService.js?v=2");
        docId = await ensureStudentRecord();
        userDoc = await retryWithBackoff(() => getDocument("students", docId));
      } catch (e) {
        console.error("[login] self-heal failed:", e);
      }
    }

    if (!userDoc) {
      throw new Error(
        "We could not open your profile. Please try signing in again, or contact the administration."
      );
    }

    // Old Students / Disabled / Inactive: portal access is strictly disabled.
    // Credentials are NOT deleted; access to the student portal is blocked.
    const isOldStudent = userDoc.status === "Old" || userDoc.status === "Old Student" || userDoc.portalAccessDisabled === true;
    if (isOldStudent) {
      try { await authLogout(); } catch (_) { }
      try { localStorage.removeItem("userRole"); localStorage.removeItem("userId"); localStorage.removeItem("userName"); } catch (_) { }
      throw new Error("Your student portal access has been disabled because you are registered as an Old Student. Please contact library administration to reactivate your account.");
    }

    if (userDoc.status === "disabled" || userDoc.status === "Inactive") {
      try { await authLogout(); } catch (_) { }
      try { localStorage.removeItem("userRole"); localStorage.removeItem("userId"); localStorage.removeItem("userName"); } catch (_) { }
      throw new Error("This account has been disabled. Please contact administration.");
    }

    // Revoke gate (read-only): admin Clear sets loginRevoked=true.
    // Revoked users are signed out and refused here. No writes.
    if (userDoc.loginRevoked === true) {
      try { await authLogout(); } catch (_) { }
      try { localStorage.removeItem("userRole"); localStorage.removeItem("userId"); localStorage.removeItem("userName"); } catch (_) { }
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

    const realName = (userDoc && (userDoc.name || userDoc.fullName || userDoc.studentName))
      ? String(userDoc.name || userDoc.fullName || userDoc.studentName).trim()
      : "";
    if (realName && !/^\d{10}$/.test(realName) && !realName.includes("@student.shreejilibrary.com")) {
      localStorage.setItem("userName", realName);
    }
    const realEmail = (userDoc && (userDoc.personalEmail || userDoc.email))
      ? String(userDoc.personalEmail || userDoc.email).trim()
      : "";
    if (realEmail && !realEmail.endsWith("@student.shreejilibrary.com") && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(realEmail)) {
      localStorage.setItem("userEmail", realEmail.toLowerCase());
    }
    if (userDoc?.phone) {
      localStorage.setItem("userPhone", String(userDoc.phone).replace(/\D/g, "").slice(-10));
    }

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

    const realName = (userDoc && (userDoc.name || userDoc.fullName || userDoc.studentName))
      ? String(userDoc.name || userDoc.fullName || userDoc.studentName).trim()
      : "";
    if (realName && !/^\d{10}$/.test(realName) && !realName.includes("@student.shreejilibrary.com")) {
      localStorage.setItem("userName", realName);
    }
    const realEmail = (userDoc && (userDoc.personalEmail || userDoc.email))
      ? String(userDoc.personalEmail || userDoc.email).trim()
      : "";
    if (realEmail && !realEmail.endsWith("@student.shreejilibrary.com") && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(realEmail)) {
      localStorage.setItem("userEmail", realEmail.toLowerCase());
    }
    if (userDoc?.phone) {
      localStorage.setItem("userPhone", String(userDoc.phone).replace(/\D/g, "").slice(-10));
    }

    window.location.href = getRedirectUrlForRole();
  } catch (error) {
    throw new Error(toUserFriendlyAuthError(error));
  }
};
