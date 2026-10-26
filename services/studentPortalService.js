import { collection, query, where, onSnapshot, getDocs, doc, getDoc, updateDoc, addDoc, serverTimestamp } from "firebase/firestore";
import { getAuth, onAuthStateChanged } from "firebase/auth";
import { auth, db } from "../firebase/firebase.js";
import { notifyAdmins } from "./notificationService.js";
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
 * Submits student ID/detail changes for Admin approval (Task 5).
 * Does NOT directly update the student profile until approved.
 */
export const submitProfileUpdateRequest = async (student, requestedChanges) => {
  try {
    const authUid = (auth.currentUser ? auth.currentUser.uid : "") || student?.uid || student?.id || "";
    const targetStudentId = student?.id || authUid;
    if (!targetStudentId) throw new Error("Student profile not loaded. Please sign in again.");
    
    const authEmail = auth?.currentUser?.email;
    const cleanStudentEmail = (student?.email && !student.email.endsWith("@student.shreejilibrary.com")) ? student.email : "";
    const cleanAuthEmail = (authEmail && !authEmail.endsWith("@student.shreejilibrary.com")) ? authEmail : "";
    const realEmail = cleanStudentEmail || (student?.personalEmail && !student.personalEmail.endsWith("@student.shreejilibrary.com") ? student.personalEmail : "") || cleanAuthEmail || "";

    const payload = {
      studentId: targetStudentId,
      uid: authUid,
      loginId: student?.loginId || realEmail || student?.phone || "",
      studentName: student?.name || "Student",
      studentPhone: student?.phone || "",
      studentEmail: realEmail,
      oldData: {
        name: student.name || "",
        phone: student.phone || "",
        email: student.email || "",
        college: student.college || "",
        course: student.course || "",
        parentPhone: student.parentPhone || "",
        address: student.address || "",
        photo: student.profilePhotoUrl || student.photoUrl || student.photo || ""
      },
      requestedChanges: { ...requestedChanges },
      status: "Pending",
      createdAt: serverTimestamp(),
      reviewedAt: null,
      reviewedBy: null
    };

    const docRef = await addDoc(collection(db, "profileUpdateRequests"), payload);

    // Alert admin immediately in notifications & logs
    try {
      const keys = Object.keys(requestedChanges || {});
      const desc = keys.includes("photo") ? "profile photo" : (keys.includes("aadhaarFront") || keys.includes("aadhaarBack") ? "identity document" : keys.join(", "));
      await notifyAdmins({
        type: "profile-update",
        title: "Profile Change Request",
        body: `Student ${student.name || "Student"} (${student.phone || "—"}) requested updates to: ${desc}. Waiting for your approval.`,
        studentId: student.id
      });
    } catch (_) {}

    return { success: true, id: docRef.id };
  } catch (error) {
    console.error("submitProfileUpdateRequest error:", error);
    return { success: false, error: error.message };
  }
};

/**
 * Listens to profile update requests for this student
 */
export const listenToMyProfileUpdateRequests = (studentId, callback) => {
  if (!studentId) return () => {};
  const q = query(
    collection(db, "profileUpdateRequests"),
    where("studentId", "==", studentId)
  );
  return onSnapshot(q, (snap) => {
    const list = [];
    snap.forEach(d => list.push({ id: d.id, ...d.data() }));
    list.sort((a, b) => {
      const ta = a.createdAt?.toMillis ? a.createdAt.toMillis() : (a.createdAt || 0);
      const tb = b.createdAt?.toMillis ? b.createdAt.toMillis() : (b.createdAt || 0);
      return tb - ta;
    });
    callback(list);
  }, (err) => {
    console.warn("listenToMyProfileUpdateRequests error:", err);
    callback([]);
  });
};

/**
 * Deprecated direct update — routed through approval workflow (Task 5)
 */
export const updateStudentOwnProfile = async (studentId, updates) => {
  // Routes to submitProfileUpdateRequest
  return { success: false, error: "Profile updates require Admin approval. Please submit a change request." };
};

