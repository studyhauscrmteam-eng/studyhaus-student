export const ROLES = {
  OWNER: "Owner/Admin",
  MANAGER: "Manager",
  EMPLOYEE: "Employee",
  STUDENT: "Student"
};

// Define module permissions for each role based on requirements
export const PERMISSIONS = {
  [ROLES.OWNER]: ["*"], // Can access every module
  [ROLES.MANAGER]: [
    "dashboard",
    "students",
    "renewals",
    "complaints",
    "expenses",
    "reports",
    "attendance",
    "payments",
    "seats",
    "notifications"
  ],
  [ROLES.EMPLOYEE]: [
    "dashboard",
    "visitors",
    "students",
    "renewals",
    "attendance",
    "payments",
    "complaints",
    "seats",
    "notifications"
  ],
  [ROLES.STUDENT]: [
    "student-portal",
    "student-payments",
    "student-attendance",
    "student-complaints",
    "student-profile",
    "notifications"
  ]
};

/**
 * Check if a role has access to a specific module (page)
 * @param {string} role - The user's role
 * @param {string} module - The module trying to be accessed
 * @returns {boolean} True if access is allowed, false otherwise
 */
export const hasPermission = (role, module) => {
  if (!role || !PERMISSIONS[role]) return false;
  if (PERMISSIONS[role].includes("*")) return true;
  return PERMISSIONS[role].includes(module);
};
