import { doc, getDoc, deleteDoc, setDoc, updateDoc, collection, query, where, getDocs } from "firebase/firestore";
import { db } from "../firebase/firebase.js";

/**
 * Approve a pending admission
 * Moves the document from 'admissions' to 'students' collection
 * Assigns seat if selected
 */
export const approveAdmission = async (admissionId) => {
  try {
    const admissionRef = doc(db, "admissions", admissionId);
    const docSnap = await getDoc(admissionRef);
    
    if (!docSnap.exists()) {
      throw new Error("Admission record not found.");
    }
    
    const data = docSnap.data();
    data.approvalStatus = "Approved";
    data.status = "Active";
    data.updatedAt = new Date().toISOString();
    // Pending admissions from logged-in portal students are written at
    // admissions/{authUid} — carry the uid onto the student doc so the
    // portal knows a real login account exists. Pure website forms carry NO
    // uid (no account was created), so leave it out: stamping a fake uid
    // would later block the admin from creating the portal login.
    if (data.uid) {
      data.uid = admissionId;
    } else {
      delete data.uid;
    }

    // Every approved student carries a unique sequential admission number.
    // Website requests already have one; older records get one now.
    if (!data.studentId || String(data.studentId).trim() === "") {
      try {
        const { ensureStudentId } = await import("./studentIdService.js");
        const tmp = { ...data };
        await ensureStudentId(tmp);
        data.studentId = tmp.studentId;
        data.admissionNo = tmp.admissionNo || tmp.studentId;
      } catch (e) {
        console.warn("Could not assign admission number:", e?.message || e);
      }
    }
    if (!data.admissionNo) data.admissionNo = data.studentId || "";

    // Final duplicate guard (staff can read all collections): the same phone
    // or email must never enter the main students list twice.
    try {
      const phoneQ = query(collection(db, "students"), where("phone", "==", data.phone));
      const phoneSnap = await getDocs(phoneQ);
      if (phoneSnap.docs.some(d => d.id !== admissionId)) {
        throw new Error(`Phone number ${data.phone} is already registered for another student.`);
      }
      const normEmail = String(data.email || "").trim().toLowerCase();
      if (normEmail) {
        const emailQ = query(collection(db, "students"), where("email", "==", normEmail));
        const emailSnap = await getDocs(emailQ);
        const dup = emailSnap.docs.some(d => d.id !== admissionId);
        if (dup) throw new Error(`Email ${data.email} is already registered for another student.`);
      }
    } catch (e) {
      if (/already registered/.test(e?.message || "")) return { success: false, error: e.message };
      console.warn("Pre-approval duplicate check skipped:", e?.message || e);
    }

    // Handle seat assignment if seat was selected.
    // Seat Preference guard: a plan without seat selection keeps the
    // admission seat-free even if a seat number arrived with the request.
    // (Staff run with full read rights here, so this check is authoritative.)
    let assignedSeat = data.seatAssigned || data.seatNumber;
    if (assignedSeat && data.planId) {
      try {
        const { planAllowsSeatSelection } = await import("./planValidation.js");
        const allowed = await planAllowsSeatSelection(data.planId);
        if (!allowed) {
          assignedSeat = null;
          delete data.seatAssigned;
          delete data.seatNumber;
        }
      } catch (_) { /* fail open only when the plan can't be read */ }
    }
    if (assignedSeat) {
      // Find and update the seat
      const seatQ = query(collection(db, "seats"), where("seatNumber", "==", assignedSeat));
      const seatSnap = await getDocs(seatQ);
      if (!seatSnap.empty) {
        const seatDoc = seatSnap.docs[0];
        const seatData = seatDoc.data();
        
        // Check if seat is available or reserved for this student
        if (seatData.status === "Available" || 
            (seatData.status === "Reserved" && seatData.assignedStudentId === admissionId)) {
          
          // Update seat to Occupied
          await updateDoc(seatDoc.ref, {
            status: "Occupied",
            assignedStudentId: admissionId,
            assignedStudentName: data.name,
            planType: data.planName,
            lastUpdated: new Date().toISOString()
          });
          
          // Ensure student data has seat number
          data.seatNumber = assignedSeat;
        }
      }
    }

    // Create in students collection
    const studentRef = doc(db, "students", admissionId);
    await setDoc(studentRef, data, { merge: true });

    // Update the corresponding user document to Active
    const userRef = doc(db, "users", admissionId);
    try {
      await updateDoc(userRef, { status: "Active" });
    } catch (e) {
      console.warn("Could not update users document (it may not exist if created via manual admin admission):", e);
    }

    // Remove from admissions collection
    await deleteDoc(admissionRef);

    // Inform the student by email (best-effort — approval already succeeded).
    try {
      const { sendAdmissionApprovedMail } = await import("./emailService.js");
      sendAdmissionApprovedMail({ id: admissionId, ...data }).catch(() => {});
    } catch (_) { /* email is best-effort */ }

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

/**
 * Reject an admission
 * Releases any reserved seat
 */
export const rejectAdmission = async (admissionId, reason) => {
  try {
    const admissionRef = doc(db, "admissions", admissionId);
    const docSnap = await getDoc(admissionRef);
    
    // Release seat if assigned
    if (docSnap.exists()) {
      const data = docSnap.data();
      const assignedSeat = data.seatAssigned || data.seatNumber;
      if (assignedSeat) {
        const seatQ = query(collection(db, "seats"), where("seatNumber", "==", assignedSeat));
        const seatSnap = await getDocs(seatQ);
        if (!seatSnap.empty) {
          const seatDoc = seatSnap.docs[0];
          const seatData = seatDoc.data();
          
          // Only release if reserved for this student
          if (seatData.status === "Reserved" && seatData.assignedStudentId === admissionId) {
            await updateDoc(seatDoc.ref, { 
              status: "Available", 
              assignedStudentId: null,
              assignedStudentName: null,
              planType: null,
              lastUpdated: new Date().toISOString() 
            });
          }
        }
      }
    }
    
    await updateDoc(admissionRef, {
      approvalStatus: "Rejected",
      rejectReason: reason || "",
      status: "Rejected",
      updatedAt: new Date().toISOString()
    });

    const userRef = doc(db, "users", admissionId);
    try {
      await updateDoc(userRef, { status: "Rejected" });
    } catch (e) {
      console.warn("Could not update users document:", e);
    }

    // Inform the student by email (best-effort — rejection already recorded).
    try {
      const rejectedData = docSnap.exists() ? docSnap.data() : {};
      const { sendAdmissionRejectedMail } = await import("./emailService.js");
      sendAdmissionRejectedMail({ id: admissionId, ...rejectedData }, reason || "").catch(() => {});
    } catch (_) { /* email is best-effort */ }

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

/**
 * Request Changes for an admission
 */
export const requestChangesAdmission = async (admissionId, notes) => {
  try {
    const admissionRef = doc(db, "admissions", admissionId);
    await updateDoc(admissionRef, {
      approvalStatus: "Changes Requested",
      adminNotes: notes || "",
      updatedAt: new Date().toISOString()
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};
