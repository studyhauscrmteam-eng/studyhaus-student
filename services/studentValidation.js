import { collection, query, where, getDocs, doc, getDoc } from "firebase/firestore";
import { db } from "../firebase/firebase.js";
import { checkRotationalCapacity } from "./planValidation.js";

/**
 * Validates a new student admission request.
 * Throws errors if validation fails.
 */
export const validateStudentData = async (data) => {
  if (!data.name || data.name.trim() === "") throw new Error("Full Name is required.");
  if (!data.phone || data.phone.trim() === "") throw new Error("Phone Number is required.");

  // Owner rule: the parent's mobile may NEVER be the student's own number —
  // it is the fallback contact we use when the student cannot be reached, so
  // it has to reach somebody else. Digits only, 10 like every other number.
  const digits = (v) => String(v || "").replace(/\D/g, "");
  const ownPhone = digits(data.phone);
  const parentPhone = digits(data.parentPhone);
  if (parentPhone) {
    if (parentPhone.length !== 10) {
      throw new Error("Parent's mobile number must be exactly 10 digits.");
    }
    if (parentPhone === ownPhone) {
      throw new Error("Parent's mobile number cannot be the same as the student's own number.");
    }
  }

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

  // Duplicate checks.
  //
  // 1) FIRST: the "one request per phone/email" claim. This is the ONE place
  //    a student is always allowed to read, so unlike the collection query in
  //    step 2 it can never be skipped. Before this existed, a student
  //    submission hit permission-denied on `students`, the error was swallowed
  //    below, and the same number could send request after request.
  const normEmail = data.email ? String(data.email).trim().toLowerCase() : "";
  await checkRequestNotAlreadyFiled(data.phone, normEmail);

  // 2) Then the full collection scan. Admin submissions AND website/student
  //    submissions both get checked so the same phone number or email can
  //    never exist twice. For student self-submissions the student's own
  //    pending record (same uid) is excluded. Students may only read their own
  //    doc per Firestore rules, so a permission failure here is tolerated —
  //    step 1 and the admin-side approval re-check still hold the line.
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

/** Read a uniqueness claim; unreadable (permission) counts as "not filed". */
const readClaim = async (id) => {
  try {
    const snap = await getDoc(doc(db, "uniqueness", id));
    return snap.exists() ? (snap.data() || {}) : null;
  } catch (e) {
    if (/permission|denied|insufficient/i.test(e?.message || "")) return null;
    throw e;
  }
};

/**
 * Friendly block: the same number / email may only send ONE request.
 * Throws the message the applicant should see.
 */
export const checkRequestNotAlreadyFiled = async (phone, email) => {
  const normEmail = email ? String(email).trim().toLowerCase() : "";
  if (phone) {
    if (await readClaim(`req_adm_${phone}`)) {
      throw new Error(
        `We already have a request from ${phone} — no second one can be filed. We'll call you.`
      );
    }
  }
  if (normEmail && await readClaim(`req_admmail_${normEmail}`)) {
    throw new Error(
      `We already have a request from ${normEmail} — no second one can be filed. We'll call you.`
    );
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
