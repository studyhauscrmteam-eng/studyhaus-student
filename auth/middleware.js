import { ROLES, hasPermission } from "./roles.js";

/**
 * Route-based protection middleware
 * Checks if the user's role allows them to access the current URL path.
 * @param {string} role - Current user's role
 * @param {string} path - Current URL path
 */
export const protectRoute = (rawRole, path) => {
  // Normalize role to handle common aliases
  let role = rawRole;
  if (role === "Admin" || role === "owner" || role === "admin" || role === "Owner") {
    role = ROLES.OWNER;
  }

  // If unauthorized page, anyone logged in can view it (usually to see the "Go Back" button)
  if (path.includes("unauthorized.html")) return;

  // Student portal is students-only. Staff (including Owner) are bounced to
  // their own dashboard — no viewing, no testing inside.
  if (path.includes("/student/") && role !== ROLES.STUDENT) {
    window.location.href = getDefaultRoute(role);
    return;
  }

  // Enforce URL path restrictions based on folder structure
  let isAllowed = false;

  if (role === ROLES.OWNER) {
    // Owner can access everything, but typically stays in /admin/
    isAllowed = true;
  } else if (role === ROLES.MANAGER) {
    // Manager should ideally be in /manager/
    if (path.includes("/manager/")) isAllowed = true;
  } else if (role === ROLES.EMPLOYEE) {
    // Employee should be in /employee/
    if (path.includes("/employee/")) isAllowed = true;
  } else if (role === ROLES.STUDENT) {
    // Student should be in /student/
    if (path.includes("/student/")) isAllowed = true;
  }

  // If the user tries to access the root index.html manually after login, redirect them to their correct dashboard
  if (path === "/" || path.endsWith("/index.html")) {
    window.location.href = getDefaultRoute(role);
    return;
  }

  if (!isAllowed) {
    console.warn(`Access denied for role: ${role} on path: ${path}`);
    window.location.href = "/unauthorized.html";
  }
};

/**
 * Helper to get default route for redirecting from root
 */
const getDefaultRoute = (rawRole) => {
  let role = rawRole;
  if (role === "Admin" || role === "owner" || role === "admin" || role === "Owner") {
    role = ROLES.OWNER;
  }

  switch (role) {
    case ROLES.STUDENT: return "/student/dashboard.html";
    default: return "/unauthorized.html";
  }
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
