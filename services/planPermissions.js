/**
 * Role-based UI visibility logic for Membership Plans
 */

export const enforcePlanUIPermissions = () => {
  const role = localStorage.getItem("userRole");
  
  // 1. "+ New Plan" button visibility (Owner only)
  const newPlanBtn = document.getElementById("btn-new-plan");
  if (newPlanBtn) {
    if (role !== "Owner/Admin") {
      newPlanBtn.style.display = "none";
    }
  }
};

/**
 * Checks if current user is allowed to edit/delete plans
 */
export const canEditPlans = () => {
  const role = localStorage.getItem("userRole");
  return role === "Owner/Admin";
};

/**
 * Checks if current user can view manual plans
 */
export const canViewManualPlans = () => {
  const role = localStorage.getItem("userRole");
  // Only Owner/Admin can see manual plans
  return role === "Owner/Admin";
};
