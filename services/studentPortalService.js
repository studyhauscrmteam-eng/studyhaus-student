import { collection, query, where, onSnapshot, getDocs, doc, getDoc, updateDoc, serverTimestamp } from "firebase/firestore";
import { getAuth, onAuthStateChanged } from "firebase/auth";
import { db } from "../firebase/firebase.js";

/**
 * Initializes the Student Portal listener based on the currently logged-in Firebase Auth user.
 * It maps the Auth user email to the students collection.
 */
export const listenToStudentPortalData = (onDataUpdate, onError) => {
  const auth = getAuth();
  
  onAuthStateChanged(auth, async (user) => {
    if (user && user.email) {

      // 1. Try the students collection first (added by admin via Admissions)
      // Since student documents use the user.uid as their ID, we can do a direct getDoc
      const studentDocRef = doc(db, "students", user.uid);
      
      onSnapshot(studentDocRef, async (studentDoc) => {
        if (studentDoc.exists()) {
          // Found in students collection — full profile available.
          // Merge profile photo from studentDocuments if the denormalised
          // copy is missing (older uploads only wrote there).
          const base = { id: studentDoc.id, ...studentDoc.data() };
          if (!base.profilePhotoUrl && !base.photoUrl) {
            try {
              const docsSnap = await getDoc(doc(db, "studentDocuments", studentDoc.id));
              if (docsSnap.exists()) {
                const dd = docsSnap.data();
                const photo = dd.photo || dd.profilePhoto || dd.selfie || null;
                if (photo) { base.profilePhotoUrl = photo; base.photoUrl = photo; }
              }
            } catch (_) { /* photo fallback is best-effort */ }
          }
          onDataUpdate(base);
          return;
        }

        // 2. Fallback: check the users collection (registered via register.html)
        try {
          const userDocRef = doc(db, "users", user.uid);
          const userDoc = await getDoc(userDocRef);

          if (userDoc.exists()) {
            const userData = userDoc.data();
            const admRef = doc(db, "admissions", user.uid);
            const admSnap = await getDoc(admRef);

            if (admSnap.exists() && admSnap.data().status === "Pending") {
              const admDoc = admSnap;
              const admData = admDoc.data();
              onDataUpdate({
                id: admDoc.id,
                name: admData.name || userData.name || user.email.split("@")[0],
                email: admData.email || user.email,
                role: "Student",
                status: "Pending",
                planName: admData.planName || "Not Assigned",
                seatNumber: admData.seatAssigned || null,
                _fromUsersCollection: true,
                _isPendingAdmission: true
              });
            } else {
              // Build a minimal student-like profile from the users doc
              onDataUpdate({
                id: userDoc.id,
                name: userData.name || user.email.split("@")[0],
                email: userData.email || user.email,
                role: userData.role || "Student",
                status: "Pending", // Was "Active" before, but they are not yet admitted
                planName: "Not Assigned",
                seatNumber: null,
                paymentDueDate: null,
                parentPhone: userData.parentPhone || "",
                address: userData.address || "",
                _fromUsersCollection: true,
                _isNewUser: true
              });
            }
          } else {
            onError("No student profile found. Please contact your admin to complete your enrollment.");
          }
        } catch (fallbackErr) {
          onError("Failed to load your profile: " + fallbackErr.message);
        }
      }, (err) => {
        onError("Failed to fetch student data: " + err.message);
      });

    } else {
      onError("No user signed in or missing email.");
    }
  });
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
