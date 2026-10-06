/**
 * Convert Firebase / app errors into user-friendly login messages.
 */
export const toUserFriendlyAuthError = (error) => {
  const code = error?.code || "";

  switch (code) {
    case "auth/invalid-email":
      return "Please enter a valid email address.";
    case "auth/user-disabled":
      return "This account has been disabled. Contact your administrator.";
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "Incorrect email or password.";
    case "auth/too-many-requests":
      return "Too many failed attempts. Please wait a few minutes and try again.";
    case "auth/network-request-failed":
      return "Network error. Check your internet connection and try again.";
    case "auth/unauthorized-domain":
      return "This website is not authorized in Firebase. Add your domain under Authentication → Settings → Authorized domains.";
    case "permission-denied":
      return "Firestore access denied. Deploy firestore.rules and make sure your user has a role document in the users collection.";
    default:
      return error?.message || "Login failed. Please try again.";
  }
};
