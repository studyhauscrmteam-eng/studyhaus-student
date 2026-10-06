import { collection, query, where, getDocs } from "firebase/firestore";
import { db } from "../firebase/firebase.js";
import { checkRotationalCapacity } from "./planValidation.js";

/**
 * Validates a new student admission request.
 * Throws errors if validation fails.
 */
export const validateStudentData = async (data) => {
  if (!data.name || data.name.trim() === "") throw new Error("Full Name is required.");
  if (!data.phone || data.phone.trim() === "") throw new Error("Phone Number is required.");
  if (!data.dob) throw new Error("Date of Birth is required.");
  if (!data.gender) throw new Error("Gender is required.");
  if (!data.planId) throw new Error("Membership Plan is required.");
  
  if (!data.paymentMethod) throw new Error("Payment Option must be selected.");
  if (data.paymentMethod === "Pay Later" && !data.paymentDueDate) {
    throw new Error("Due Date is required for Pay Later option.");
  }
  if (data.paymentMethod === "Pay Now" && (!data.transactionId || data.transactionId.trim() === "")) {
    throw new Error("Transaction ID is required for Pay Now option.");
  }

  // Terms and conditions
  if (!data.termsAccepted) throw new Error("You must accept the Terms & Conditions.");

  // Check capacity if plan is Rotational
  if (data.planName === "Rotational Seat") {
    const isAvailable = await checkRotationalCapacity();
    if (!isAvailable) {
      throw new Error("The Rotational Seat plan has reached its maximum capacity (30 students).");
    }
  }

  // Duplicate checks in both 'students' and 'admissions'.
  // Admin submissions AND website/student submissions both get checked so the
  // same phone number or email can never exist twice. For student
  // self-submissions the student's own pending record (same uid) is excluded.
  // NOTE: students can only read their own doc per Firestore rules, so if the
  // check fails on permissions for a student submission we let it through —
  // the admin-side approval step re-checks with staff permissions and blocks
  // any duplicate from ever reaching the main students list.
  const isStudent = !!data.isStudentSubmission;
  try {
    await checkDuplicates(data.phone, data.email, isStudent ? data.uid || data._selfUid || null : null);
  } catch (e) {
    if (isStudent && /permission|denied|insufficient/i.test(e?.message || "")) {
      // fall through — enforced again at approval time by staff
    } else {
      throw e;
    }
  }
  return true;
};

/**
 * Checks if phone or email already exists in system.
 * Email comparison is case-insensitive (stored lowercased).
 */
const checkDuplicates = async (phone, email, excludeId = null) => {
  const normEmail = email && String(email).trim() !== "" ? String(email).trim().toLowerCase() : "";
  const collections = ["students", "admissions"];

  for (const colName of collections) {
    // Check phone
    const phoneQ = query(collection(db, colName), where("phone", "==", phone));
    const phoneSnap = await getDocs(phoneQ);
    const phoneDup = phoneSnap.docs.find(d => d.id !== excludeId);
    if (phoneDup) {
      throw new Error(`Phone number ${phone} is already registered.`);
    }

    // Check email if provided (case-insensitive: stored lowercased; the
    // exact query below is indexed and instant no matter how big the data
    // grows — never full-scan the collections here).
    if (normEmail) {
      const emailQ = query(collection(db, colName), where("email", "==", normEmail));
      const emailSnap = await getDocs(emailQ);
      const dup = emailSnap.docs.find(d => d.id !== excludeId);
      if (dup) {
        throw new Error(`Email ${email} is already registered.`);
      }
    }
  }
};
