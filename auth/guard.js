import { onAuthStateChanged, logout } from "../services/authService.js";
import { getDocument } from "../services/firestoreService.js";
import { getRedirectUrlForRole } from "./login.js";
import { protectRoute } from "./middleware.js";

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
  const isPublicPage = normPath === "/" || normPath === "/index" || normPath.endsWith("/index.html") || normPath === "/login" || normPath.endsWith("login.html") || normPath === "/register" || normPath.endsWith("register.html") || normPath === "/forgot-password" || normPath.endsWith("forgot-password.html") || normPath === "/unauthorized" || normPath.endsWith("unauthorized.html");

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
        let userDoc = null;
        // Fetch role if not in localStorage or to ensure it's up to date
        let role = localStorage.getItem("userRole");
        if (!role) {
          // Role not cached — fetch from Firestore (student credential only:
          // admitted students live at students/{uid}, pending/new at users/{uid}).
          let docId = user.uid;

          // 1. Admitted students.
          try {
            userDoc = await retryWithBackoff(() => getDocument("students", user.uid));
          } catch (_) { /* ignore permission errors */ }

          // 2. Pending/new users (admin gives credentials).
          if (!userDoc) {
            try {
              userDoc = await retryWithBackoff(() => getDocument("users", user.uid));
            } catch (_) { /* ignore permission errors */ }
          }

          // 3. Fallback: self-heal via ensureStudentRecord (for newly created student accounts)
          if (!userDoc) {
            try {
              const { ensureStudentRecord } = await import("../services/onboardingService.js");
              docId = await ensureStudentRecord();
              userDoc = await retryWithBackoff(() => getDocument("students", docId));
            } catch (e) {
              console.warn("[guard] ensureStudentRecord self-heal:", e);
            }
          }

          // 4. Default to Student in the student portal
          if (!userDoc || !userDoc.role) {
            role = "Student";
          } else {
            role = userDoc.role;
          }

          localStorage.setItem("userRole", role);
          localStorage.setItem("userId", (userDoc && (userDoc.id || docId)) || user.uid);
        } else {
          // Role was already in localStorage (e.g. set right after registration).
          // Ensure userId is also stored.
          if (!localStorage.getItem("userId")) {
            localStorage.setItem("userId", user.uid);
          }
        }

        if (userDoc && (
          userDoc.loginRevoked === true ||
          userDoc.portalAccessDisabled === true ||
          userDoc.status === "Old" ||
          userDoc.status === "Old Student" ||
          userDoc.status === "disabled" ||
          userDoc.status === "Inactive"
        )) {
          localStorage.removeItem("userRole");
          localStorage.removeItem("userId");
          localStorage.removeItem("userName");
          await logout();
          window.location.href = "/login.html";
          return;
        }

        if (isPublicPage) {
          let userDocRevokeCheck = null;
          try {
            userDocRevokeCheck = await getDocument("students", user.uid);
            if (!userDocRevokeCheck) userDocRevokeCheck = await getDocument("users", user.uid);
          } catch (_) {}
          const isAccessDisabled = userDocRevokeCheck && (
            userDocRevokeCheck.loginRevoked === true ||
            userDocRevokeCheck.portalAccessDisabled === true ||
            userDocRevokeCheck.status === "Old" ||
            userDocRevokeCheck.status === "Old Student" ||
            userDocRevokeCheck.status === "disabled" ||
            userDocRevokeCheck.status === "Inactive"
          );
          if (isAccessDisabled) {
            localStorage.removeItem("userRole");
            localStorage.removeItem("userId");
            localStorage.removeItem("userName");
            await logout();
            if (loader) loader.style.display = "none";
            return;
          }
          // Redirect logged-in users away from login page to their dashboard
          window.location.href = getRedirectUrlForRole(role);
        } else {
          // ── Fast Unblock & Route Protection ────────────────────────
          protectRoute(role, currentPath);

          // Fast-render user role and cached greeting immediately (0ms delay)
          const roleEl = document.getElementById("current-user-role");
          const topbarRoleEl = document.getElementById("topbar-user-role");
          if (roleEl) roleEl.textContent = role;
          if (topbarRoleEl) topbarRoleEl.textContent = role;

          const cachedName = localStorage.getItem("userName");
          const validCachedName = (cachedName && !/^\d{10}$/.test(cachedName.trim()) && !cachedName.includes("@student.shreejilibrary.com"))
            ? cachedName.trim()
            : "";
          if (validCachedName) {
            const nameEl = document.getElementById("current-user-name");
            const topbarNameEl = document.getElementById("topbar-user-name");
            const topbarAvatarEl = document.getElementById("topbar-user-avatar");
            const greetEl = document.getElementById("dashboard-greeting");
            if (nameEl) nameEl.textContent = validCachedName;
            if (topbarNameEl) topbarNameEl.textContent = validCachedName;
            const inits = validCachedName.split(" ").filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("") || "S";
            if (topbarAvatarEl && !topbarAvatarEl.querySelector("img")) topbarAvatarEl.textContent = inits;
            const hour = new Date().getHours();
            const timeGreeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
            if (greetEl) greetEl.textContent = `${timeGreeting}, ${validCachedName.split(" ")[0]}!`;
          }

          // Unblock the page immediately — don't make the student wait on Firestore!
          if (loader) loader.style.display = "none";

          // ── Resolve display name in background (non-blocking) ──────
          (async () => {
            let userDoc2 = null;
            const actualDocId = localStorage.getItem("userId") || user.uid;
            try {
              userDoc2 = await getDocument("students", actualDocId);
              if (!userDoc2) userDoc2 = await getDocument("users", actualDocId);
              if (!userDoc2) userDoc2 = await getDocument("users", user.uid);
            } catch (_) { }

            if (userDoc2 && (
              userDoc2.loginRevoked === true ||
              userDoc2.portalAccessDisabled === true ||
              userDoc2.status === "disabled" ||
              userDoc2.status === "Inactive" ||
              userDoc2.status === "Old" ||
              userDoc2.status === "Old Student"
            )) {
              localStorage.removeItem("userRole");
              localStorage.removeItem("userId");
              localStorage.removeItem("userName");
              await logout();
              window.location.href = "/login.html";
              return;
            }

            const realDocName = (userDoc2 && (userDoc2.name || userDoc2.fullName || userDoc2.studentName))
              ? String(userDoc2.name || userDoc2.fullName || userDoc2.studentName).trim()
              : "";
            const cleanDocName = (realDocName && !/^\d{10}$/.test(realDocName) && !realDocName.includes("@student.shreejilibrary.com"))
              ? realDocName
              : "";
            const isSynthetic = user.email && user.email.endsWith("@student.shreejilibrary.com");
            const fallbackEmailName = (!isSynthetic && user.email) ? user.email.split("@")[0] : "";
            const validCached = (cachedName && !/^\d{10}$/.test(cachedName.trim()) && !cachedName.includes("@student.shreejilibrary.com"))
              ? cachedName.trim()
              : "";

            const displayName = cleanDocName || validCached || fallbackEmailName || "Student";

            if (displayName !== "Student") {
              localStorage.setItem("userName", displayName);
            }

            const initials = displayName !== "Student"
              ? displayName
                  .split(" ")
                  .filter(Boolean)
                  .slice(0, 2)
                  .map(w => w[0].toUpperCase())
                  .join("") || "S"
              : "S";

            const hour = new Date().getHours();
            const timeGreeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

            const nameEl = document.getElementById("current-user-name");
            const topbarNameEl = document.getElementById("topbar-user-name");
            const avatarEl = document.getElementById("current-user-avatar");
            const topbarAvatarEl = document.getElementById("topbar-user-avatar");
            const greetEl = document.getElementById("dashboard-greeting");

            if (nameEl) nameEl.textContent = displayName;
            if (topbarNameEl) topbarNameEl.textContent = displayName;
            if (avatarEl && !avatarEl.querySelector("img")) avatarEl.textContent = initials;
            if (topbarAvatarEl && !topbarAvatarEl.querySelector("img")) topbarAvatarEl.textContent = initials;
            if (greetEl) greetEl.textContent = `${timeGreeting}, ${displayName.split(" ")[0]}!`;
          })();
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
          const cachedRole = localStorage.getItem("userRole");
          if (cachedRole === "Student" && normPath.includes("/student/")) {
            console.warn("Recovering from Auth Guard error in student portal; allowing page to render.");
            if (loader) loader.style.display = "none";
            return;
          }
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
      // Protected page: if no role is cached, bounce immediately without showing UI
      if (!localStorage.getItem("userRole")) {
        localStorage.removeItem("userId");
        window.location.href = "/login.html";
        return;
      }
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
      }, 800);
      return;
    }
  });
};
