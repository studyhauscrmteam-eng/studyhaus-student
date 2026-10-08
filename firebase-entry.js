import { testFirebaseConnection } from "./firebase/testConnection.js";
import { initAuthGuard } from "./auth/guard.js";
import { enforceModulePermissions } from "./auth/middleware.js";
import { handleLogout } from "./auth/logout.js";
import { initStudentPortalUI } from "./services/studentPortalUI.js";
import "./services/translationService.js";
import "./services/whatsappModalUI.js"; // Auto-injects modal styles and functions

// Expose the test function to the global window object
window.runFirebaseTest = testFirebaseConnection;

// Expose logout function globally so it can be called from onclick handlers in the UI
window.logout = handleLogout;

// Expose Document Upload logic globally
import { uploadGlobalDocument, loadGlobalDocuments, downloadBase64File } from "./services/documentUploadService.js";
window.uploadGlobalDocument = uploadGlobalDocument;
window.loadGlobalDocuments = loadGlobalDocuments;
window.downloadBase64File = downloadBase64File;

// Ensure downloadBase64File is available immediately (fallback)
if (typeof window.downloadBase64File !== 'function') {
  window.downloadBase64File = (base64Data, fileName) => {
    try {
      const matches = base64Data.match(/^data:([^;]+);base64,(.+)$/);
      if (!matches) {
        const link = document.createElement('a');
        link.href = base64Data;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        return;
      }
      const mimeType = matches[1];
      const base64 = matches[2];
      const byteString = atob(base64);
      const ab = new ArrayBuffer(byteString.length);
      const ia = new Uint8Array(ab);
      for (let i = 0; i < byteString.length; i++) {
        ia[i] = byteString.charCodeAt(i);
      }
      const blob = new Blob([ia], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Download failed:", e);
      const link = document.createElement('a');
      link.href = base64Data;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };
}

// Initialize Authentication Guard
initAuthGuard();

import { onAuthStateChanged } from "./services/authService.js";

let __crmInitDone = false;
const initCrmModules = () => {
  if (__crmInitDone) return;
  __crmInitDone = true;
  // Move all dialogs to body to prevent them from failing to open if their parent page is hidden
  document.querySelectorAll("dialog").forEach((d) => document.body.appendChild(d));

  const role = localStorage.getItem("userRole");
  if (!role) return;
  enforceModulePermissions(role);

  // Student Portal ONLY. Student-only copy: no staff/admin modules.
  initStudentPortalUI();
};

// Wait for real Firebase Auth (not just localStorage) before attaching
// any Firestore snapshot listeners. Starting them with request.auth == null
// is what caused the flood of permission-denied errors.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    onAuthStateChanged((user) => {
      if (user) initCrmModules();
    });
  });
} else {
  onAuthStateChanged((user) => {
    if (user) initCrmModules();
  });
}

// console.log("Firebase setup complete. Guard active.");
