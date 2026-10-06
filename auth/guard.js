import { onAuthStateChanged, logout } from "../services/authService.js";
import { getDocument } from "../services/firestoreService.js";
import { getRedirectUrlForRole } from "./login.js?v=login2";
import { protectRoute } from "./middleware.js?v=mid2";
import { collection, query, where, getDocs } from "firebase/firestore";
import { db } from "../firebase/firebase.js";

/**
 * Retry a Firestore read with exponential backoff.
 * Guards against transient PERMISSION_DENIED from the Firestore rules engine
 * (e.g. circular get() resolution on a freshly-written document).
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
 * Initialize Authentication Guard
 * Listens to Firebase Auth state.
 * - Redirects to login if unauthenticated on a protected page.
 * - Redirects to dashboard if authenticated on login page.
 * - Runs middleware to check role permissions if authenticated.
 */
export const initAuthGuard = () => {
  const currentPath = window.location.pathname;
  const normPath = (currentPath.replace(/\/$/, "") || "/").toLowerCase();
  const isPublicPage = normPath === "/" || normPath === "/index" || normPath.endsWith("/index.html") || normPath === "/login" || normPath.endsWith("login.html") || normPath === "/forgot-password" || normPath.endsWith("forgot-password.html") || normPath === "/unauthorized" || normPath.endsWith("unauthorized.html");

  // Only overlay the loader on protected pages. Public login renders
  // immediately with no white blink; loader still shows on Sign in submit.
  const loader = document.getElementById("global-loader");
  if (loader && !isPublicPage) loader.style.display = "flex";

  // Wait briefly for Firebase session restore before bouncing protected
  // pages. First onAuthStateChanged(null) fires while restoring — immediate
  // redirect causes dashboard refresh double-bounce (dashboard→login→dashboard).
  let __nullTimer = null;

  onAuthStateChanged(async (user) => {
    if (user) {
      if (__nullTimer) { clearTimeout(__nullTimer); __nullTimer = null; }
      // User is logged in
      try {
        // Fetch role if not in localStorage or to ensure it's up to date
        let role = localStorage.getItem("userRole");
        if (!role) {
          // Role not cached — fetch from Firestore
          let userDoc = null;
          let docId = user.uid;

          // 1. Canonical 'users' collection
          try {
            userDoc = await retryWithBackoff(() => getDocument("users", user.uid));
          } catch (_) { /* ignore permission errors */ }

          // 2. Role-named collections (Manager, Employee, etc.) by UID.
          //    "students" first: admitted students live at students/{uid} and
          //    the other collections deny reads for them (slow retries).
          if (!userDoc || !userDoc.role) {
            const roleCollections = ["students", "Manager", "Employee", "Owner", "Admin"];
            for (const col of roleCollections) {
              try {
                const doc = await getDocument(col, user.uid);
                if (doc) { userDoc = doc; break; }
              } catch (_) { /* ignore permission errors for unauthorized collections */ }
            }
          }

          // 3. Email-based search across all known collections
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
              } catch (_) { /* skip missing collections */ }
            }
          }

          // 4. Default to Student if role field is missing
          if (userDoc && !userDoc.role) {
            userDoc.role = "Student";
          }

          if (userDoc && userDoc.role) {
            role = userDoc.role;
            localStorage.setItem("userRole", role);
            localStorage.setItem("userId", docId);
          } else {
            // No role found in DB — sign out cleanly
            throw new Error("User role not found.");
          }
        } else {
          // Role was already in localStorage (e.g. set right after registration).
          // Ensure userId is also stored.
          if (!localStorage.getItem("userId")) {
            localStorage.setItem("userId", user.uid);
          }
        }

        if (isPublicPage) {
          // Redirect logged-in users away from login page to their dashboard
          window.location.href = getRedirectUrlForRole(role);
        } else {
          // ── Resolve display name ──────────────────────────────────────
          // Priority: Firestore name → email prefix → "User"
          let userDoc2 = null;
          const actualDocId = localStorage.getItem("userId") || user.uid;
          try {
            userDoc2 = await getDocument("students", actualDocId);
            if (!userDoc2) userDoc2 = await getDocument("users", actualDocId);
            if (!userDoc2) userDoc2 = await getDocument("users", user.uid);
          } catch (_) { }

          if (userDoc2 && (userDoc2.status === "disabled" || userDoc2.status === "Inactive" || userDoc2.status === "Old" || userDoc2.status === "Old Student")) {
            localStorage.setItem("forceUnauthorized", "true");
            await logout();
            return;
          }

          const displayName = (userDoc2 && userDoc2.name)
            ? userDoc2.name
            : (user.email ? user.email.split("@")[0] : "User");

          // Initials for avatar (e.g. "Admin User" → "AU")
          const initials = displayName
            .split(" ")
            .filter(Boolean)
            .slice(0, 2)
            .map(w => w[0].toUpperCase())
            .join("") || "?";

          // Time-based greeting
          const hour = new Date().getHours();
          const timeGreeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

          // ── Update DOM ────────────────────────────────────────────────
          const nameEl = document.getElementById("current-user-name");
          const topbarNameEl = document.getElementById("topbar-user-name");
          const roleEl = document.getElementById("current-user-role");
          const topbarRoleEl = document.getElementById("topbar-user-role");
          const avatarEl = document.getElementById("current-user-avatar");
          const topbarAvatarEl = document.getElementById("topbar-user-avatar");
          const greetEl = document.getElementById("dashboard-greeting");

          if (nameEl) nameEl.textContent = displayName;
          if (topbarNameEl) topbarNameEl.textContent = displayName;
          if (roleEl) roleEl.textContent = role;
          if (topbarRoleEl) topbarRoleEl.textContent = role;
          // Don't clobber a photo avatar already rendered by the portal —
          // only write initials into text-only placeholders.
          if (avatarEl && !avatarEl.querySelector("img")) avatarEl.textContent = initials;
          if (topbarAvatarEl && !topbarAvatarEl.querySelector("img")) topbarAvatarEl.textContent = initials;
          if (greetEl) greetEl.textContent = `${timeGreeting}, ${displayName.split(" ")[0]}!`;

          // If on a protected page, check permissions
          protectRoute(role, currentPath);
          if (loader) loader.style.display = "none";
        }
      } catch (error) {
        console.error("Auth Guard Error:", error);
        // Only clear localStorage if this is a genuine "no role" error,
        // not a transient Firestore permission/network error on a fresh doc.
        if (error.message === "User role not found.") {
          localStorage.removeItem("userRole");
          localStorage.removeItem("userId");
        }
        if (!isPublicPage) {
          window.location.href = "/unauthorized.html";
        } else if (loader) {
          loader.style.display = "none";
        }
      }
    } else {
      // User is NOT logged in (or session still restoring).
      if (isPublicPage) {
        localStorage.removeItem("userRole");
        localStorage.removeItem("userId");
        if (loader) loader.style.display = "none";
        return;
      }
      // Protected page: wait for session restore before bouncing.
      // If a user arrives within the window, the timer is cancelled above.
      if (__nullTimer) return;
      __nullTimer = setTimeout(() => {
        __nullTimer = null;
        localStorage.removeItem("userRole");
        localStorage.removeItem("userId");

        if (localStorage.getItem("forceUnauthorized") === "true") {
          localStorage.removeItem("forceUnauthorized");
          window.location.href = "/unauthorized.html";
          return;
        }

        // Student-only copy: everything goes to normal login.
        window.location.href = "/login.html";
      }, 1200);
      return;
    }
  });
};
