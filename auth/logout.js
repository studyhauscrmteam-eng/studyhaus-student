import { logout as authServiceLogout } from "../services/authService.js";

/**
 * Handle user logout flow
 */
export const handleLogout = async () => {
  try {
    // console.log("Loading... Logging out");

    // 1. Clear local session data
    localStorage.removeItem("userRole");
    localStorage.removeItem("userId");

    // 2. Sign out of Firebase
    await authServiceLogout();

    // 3. Redirect to login page
    window.location.href = "/login.html";

  } catch (error) {
    console.error("Logout Error:", error);
    alert("Failed to log out. Please try again.");
  }
};
