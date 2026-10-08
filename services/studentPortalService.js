import { collection, query, where, onSnapshot, getDocs, doc, getDoc, updateDoc, serverTimestamp } from "firebase/firestore";
import { getAuth, onAuthStateChanged } from "firebase/auth";
import { db } from "../firebase/firebase.js";
import { ensureStudentRecord } from "./onboardingService.js";

/**
 * Live view of the signed-in student's profile + uploaded documents.
 *
 * IMPORTANT — this is the fix for "login not working":
 *   * It calls `ensureStudentRecord()` first, which guarantees exactly one
 *     `students/{uid}` document exists for the account — adopting a legacy
 *     record or creating a fresh one if needed. Login can no longer dead-end
 *     at "Login not created".
 *   * It remembers the resolved id in localStorage.userId so every other
 *     listener (attendance, payments, complaints) keys off the same record.
 *   * It subscribes to `studentDocuments/{id}` as well, which is what the
 *     onboarding state machine needs to know whether Aadhaar/selfie are filed.
 */
export const listenToStudentPortalData = (onDataUpdate, onError) => {
  const auth = getAuth();
  let unsubStudent = null;
  let unsubDocs = null;

  const stopAll = () => {
    if (unsubStudent) { unsubStudent(); unsubStudent = null; }
    if (unsubDocs) { unsubDocs(); unsubDocs = null; }
  };

  const detach = onAuthStateChanged(auth, async (user) => {
    stopAll();

    if (!user) {
      onError("No user signed in. Please log in again.");
      return;
    }

    let studentId;
    try {
      studentId = await ensureStudentRecord();
      localStorage.setItem("userId", studentId);
      localStorage.setItem("userRole", "Student");
    } catch (e) {
      console.error("[portal] ensureStudentRecord:", e);
      onError("We could not open your profile: " + (e.message || e));
      return;
    }

    const state = { profile: null, documents: {} };

    const emit = () => {
      if (!state.profile) return;              // wait for the profile itself
      const base = { ...state.profile, _documents: state.documents };
      // Older uploads only stored the photo inside studentDocuments.
      if (!base.profilePhotoUrl && !base.photoUrl) {
        const photo = state.documents.photo || state.documents.profilePhoto || state.documents.selfie;
        if (photo) { base.profilePhotoUrl = photo; base.photoUrl = photo; }
      }
      onDataUpdate(base);
    };

    unsubDocs = onSnapshot(doc(db, "studentDocuments", studentId), (snap) => {
      state.documents = snap.exists() ? snap.data() : {};
      emit();
    }, (err) => {
      console.warn("[portal] documents listener:", err);
      state.documents = {};
      emit();
    });

    unsubStudent = onSnapshot(doc(db, "students", studentId), (snap) => {
      if (!snap.exists()) {
        onError("Your student profile could not be found. Please contact the front desk.");
        return;
      }
      state.profile = { id: snap.id, ...snap.data() };
      emit();
    }, (err) => {
      onError("Failed to fetch student data: " + err.message);
    });
  });

  // Caller stores this; safe to call more than once.
  return () => { detach(); stopAll(); };
};


/**
 * Updates the student's personal editable fields
 */
export const updateStudentOwnProfile = async (studentId, updates) => {
  try {
    const docRef = doc(db, "students", studentId);
    
    // Explicitly pick only allowed fields for safety
    const safeUpdates = {
      updatedAt: serverTimestamp()
    };
    if (updates.email !== undefined) safeUpdates.email = updates.email;
    if (updates.address !== undefined) safeUpdates.address = updates.address;
    if (updates.parentPhone !== undefined) safeUpdates.parentPhone = updates.parentPhone;

    await updateDoc(docRef, safeUpdates);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};
