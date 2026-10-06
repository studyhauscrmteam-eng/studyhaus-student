import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { firebaseConfig } from "../config/firebaseConfig.js";

/**
 * Initialize Firebase Application
 * Connects the web app to the Firebase project using the configuration.
 */
const app = initializeApp(firebaseConfig);

/**
 * Initialize Firebase Authentication
 * Used for user login, logout, and session management.
 */
const auth = getAuth(app);

/**
 * Initialize Cloud Firestore
 * Used for database operations (reading/writing documents and collections).
 */
const db = getFirestore(app);

// Export all Firebase instances for use in services
export { app, auth, db };
