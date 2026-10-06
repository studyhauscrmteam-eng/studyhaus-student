import { ROLES, hasPermission } from "./roles.js";

/**
 * Route-based protection middleware
 * Checks if the user's role allows them to access the current URL path.
 * @param {string} role - Current user's role
 * @param {string} path - Current URL path
 */
export const protectRoute = (role, path) => {
  const norm = String(path || "").toLowerCase();

  // Unauthorized page is viewable (go-back button lives there).
  if (norm.includes("unauthorized.html")) return;

  // Student pages are students-only.
  if (norm.includes("/student/")) {
    if (role !== ROLES.STUDENT) {
      window.location.href = "/unauthorized.html";
    }
    return;
  }

  // Root always goes to the student dashboard.
  if (norm === "/" || norm.endsWith("/index.html")) {
    window.location.href = getDefaultRoute(role);
    return;
  }

  // Public auth pages: leave alone.
  if (norm.endsWith("login.html") || norm === "/login"
    || norm.endsWith("forgot-password.html") || norm === "/forgot-password"
    || norm.endsWith("unauthorized.html") || norm === "/unauthorized") return;

  // Anything else does not exist in this student-only copy.
  console.warn(`Access denied for role: ${role} on path: ${path}`);
  window.location.href = "/unauthorized.html";
};

/**
 * Student-only copy: every login lands on the student dashboard.
 */
const getDefaultRoute = () => {
  return "/student/dashboard.html";
};

/**
 * Module-level protection middleware
 * Can be used by the UI to hide/show specific navigation items or sections
 * @param {string} role - Current user's role
 */
export const enforceModulePermissions = (role) => {
  // Select all navigation items that have a data-page attribute
  const navItems = document.querySelectorAll('[data-page]');

  navItems.forEach(item => {
    const moduleName = item.getAttribute('data-page');
    if (!hasPermission(role, moduleName)) {
      // Hide the navigation item if the role doesn't have permission
      item.style.display = 'none';
    }
  });
};
