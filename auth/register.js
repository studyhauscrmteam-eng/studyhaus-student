import { register as authServiceRegister, setSessionPersistence, login as authServiceLogin } from "../services/authService.js";
import { doc, setDoc, getDoc } from "firebase/firestore";
import { db } from "../firebase/firebase.js";
import { ROLES } from "./roles.js";

/**
 * Convert Firebase registration errors into user-friendly messages
 */
const toUserFriendlyRegisterError = (error) => {
  const code = error?.code || "";
  switch (code) {
    case "auth/email-already-in-use":
      return "An account with this email already exists. Try logging in instead.";
    case "auth/invalid-email":
      return "Please enter a valid email address.";
    case "auth/weak-password":
      return "Password must be at least 6 characters long.";
    case "auth/network-request-failed":
      return "Network error. Check your internet connection and try again.";
    case "auth/operation-not-allowed":
      return "Email/Password sign-up is disabled. Contact your administrator.";
    default:
      return error?.message || "Registration failed. Please try again.";
  }
};

/**
 * Get dashboard URL based on role
 */
const getDashboardUrl = (rawRole) => {
  let role = rawRole;
  if (role === "Admin" || role === "owner" || role === "admin" || role === "Owner") {
    role = ROLES.OWNER;
  }
  switch (role) {
    case ROLES.STUDENT:  return "/student/dashboard.html";
    default:
      // Student-only copy: no staff dashboards here.
      return "/unauthorized.html";
  }
};

/**
 * Handle user registration flow
 * @param {string} fullName
 * @param {string} email
 * @param {string} password
 * @param {string} role - Selected role from the form
 * @param {Object} studentData - Extra student details (only for Students)
 */
export const handleRegister = async (fullName, email, password, role, studentData = null) => {
  try {
    await setSessionPersistence();

    let user;
    let firestoreDocExists = false;

    try {
      // 1. Try to create a new Firebase Auth user
      user = await authServiceRegister(email, password);
    } catch (authError) {
      if (authError?.code === "auth/email-already-in-use") {
        // ── RECOVERY PATH ──────────────────────────────────────────────────
        // The Auth user already exists (a previous registration attempt
        // created the Auth account but failed to write the Firestore doc).
        // Try to sign in with the SAME credentials to recover the session.
        try {
          user = await authServiceLogin(email, password);
        } catch (loginError) {
          // Wrong password — the account belongs to someone else
          throw new Error("An account with this email already exists. Please log in with your existing password.");
        }

        // Check if the Firestore document was already created
        const existingDoc = await getDoc(doc(db, "users", user.uid));
        if (existingDoc.exists()) {
          // Doc exists — just log them in directly
          const data = existingDoc.data();
          const existingRole = data.role || role;
          localStorage.setItem("userRole", existingRole);
          localStorage.setItem("userId", user.uid);
          window.location.href = getDashboardUrl(existingRole);
          return;
        }

        // Doc does NOT exist — fall through to create it below
        firestoreDocExists = false;
      } else {
        throw authError; // Re-throw any other auth error
      }
    }

    // 2. Write user profile to Firestore users collection
    //    (runs for both new users and recovered accounts with missing docs)
    if (!firestoreDocExists) {
      const docData = {
        uid: user.uid,
        email: email,
        name: fullName,
        role: role,
        status: "Active", // Let them be active in users collection, studentPortalService handles the rest
        createdAt: new Date().toISOString(),
      };
      
      // Merge student specific fields if provided
      if (role === "Student" && studentData) {
        Object.assign(docData, studentData);
      }

      await setDoc(doc(db, "users", user.uid), docData);
    }

    // 3. Store role and userId in localStorage immediately so the auth guard
    //    does NOT need to re-fetch from Firestore (avoids race condition where
    //    the freshly-written doc is not yet readable by security rules).
    localStorage.setItem("userRole", role);
    localStorage.setItem("userId", user.uid);

    // 4. Redirect directly to the correct dashboard
    window.location.href = getDashboardUrl(role);

  } catch (error) {
    console.error("Registration Error:", error);
    // Clean up localStorage if something went wrong mid-way
    localStorage.removeItem("userRole");
    localStorage.removeItem("userId");
    // If the error already has a user-friendly message, use it directly
    if (error.message && !error.code) {
      throw error;
    }
    throw new Error(toUserFriendlyRegisterError(error));
  }
};
