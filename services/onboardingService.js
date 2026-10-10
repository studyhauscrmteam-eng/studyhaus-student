/**
 * First-time onboarding state machine (see docs/FLOW-AND-DATA-SPEC.md §3).
 *
 * Guarantees this module is responsible for:
 *   1. ONE document per person. `students/{uid}` is the canonical record for
 *      everyone who has a portal login. Signing up adopts an existing
 *      pre-portal record instead of creating a second one.
 *   2. Resume, never restart. Every step is derived from the record itself, so
 *      a student who abandons the wizard continues exactly where they stopped.
 *   3. Never destroy. Adopting a legacy record marks it `mergedInto` — it is
 *      never deleted.
 *
 * The wizard never writes `status` or `approvalStatus` after account creation:
 * those are reserved for the admin (enforced by firestore.rules).
 */
import {
  doc, getDoc, setDoc, updateDoc, runTransaction, serverTimestamp, collection
} from "firebase/firestore";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword
} from "firebase/auth";
import { db } from "../firebase/firebase.js";
import { normalizePhone, phoneToAuthEmail, isValidPhone } from "./phoneUtils.js";

/* ------------------------------------------------------------------ states */
export const STATE = {
  SIGNUP: "SIGNUP",
  REJECTED: "REJECTED",
  DETAILS: "DETAILS",
  DOCUMENTS: "DOCUMENTS",
  PLAN: "PLAN",
  SEAT: "SEAT",
  PAYMENT: "PAYMENT",
  PENDING: "PENDING",
  DASHBOARD: "DASHBOARD"
};

/** Ordered so the progress bar and the "resume at step N" logic agree. */
export const WIZARD_STEPS = [
  { key: STATE.DETAILS, label: "Details", hint: "Personal information" },
  { key: STATE.DOCUMENTS, label: "Documents", hint: "Aadhaar & selfie" },
  { key: STATE.PLAN, label: "Plan", hint: "Choose membership" },
  { key: STATE.SEAT, label: "Seat", hint: "Pick your seat" },
  { key: STATE.PAYMENT, label: "Payment", hint: "Pay later or pay now" }
];

const has = (v) => v !== undefined && v !== null && String(v).trim() !== "";

/* ------------------------------------------------------- completion checks */
export const detailsComplete = (s = {}) =>
  has(s.name) && has(s.phone) && has(s.dob) && has(s.gender) &&
  has(s.college) && has(s.course) && has(s.address);

export const docsComplete = (d = {}) =>
  has(d.aadhaarFront) && has(d.aadhaarBack) && has(d.photo);

/** Pay Later -> a due date. Pay Now -> a reference AND its screenshot. */
export const paymentComplete = (s = {}) => {
  if (!has(s.paymentMethod)) return false;
  if (s.paymentMethod === "Pay Later") return has(s.paymentDueDate);
  return has(s.transactionId) && has(s.paymentScreenshotUrl);
};

/** A plan only demands the seat map when it is a fixed/seat-preferred plan. */
export const planRequiresSeat = (plan) =>
  !!plan && plan.seatPreference === true;

/**
 * Pure function: record -> which screen the portal should show.
 * No I/O, so it is safe to call from a live Firestore snapshot listener.
 */
export const resolvePortalState = (student, documents, plan) => {
  if (!student) return STATE.SIGNUP;
  if (!student.uid && !student._isNewUser) {
    // No account yet — but the portal only runs after auth, so treat as new.
    return STATE.DETAILS;
  }
  if (student.approvalStatus === "Rejected") return STATE.REJECTED;

  // Approved (or an active legacy member that pre-dates approvalStatus) is a
  // member, not an onboarding case — they must never be pushed back into the
  // wizard or have their record overwritten.
  const isApproved =
    student.approvalStatus === "Approved" ||
    (student.status === "Active" && !student.approvalStatus);
  if (isApproved) return STATE.DASHBOARD;

  if (!detailsComplete(student)) return STATE.DETAILS;
  if (!docsComplete(documents || {})) return STATE.DOCUMENTS;
  if (!has(student.planId)) return STATE.PLAN;
  if (planRequiresSeat(plan) && !has(student.seatNumber)) return STATE.SEAT;
  if (!paymentComplete(student)) return STATE.PAYMENT;
  return STATE.PENDING;
};

/** Map a state to its 1-based step number (states outside the wizard -> 0). */
export const stepIndexOf = (state) => {
  const i = WIZARD_STEPS.findIndex((s) => s.key === state);
  return i === -1 ? 0 : i + 1;
};

/* -------------------------------------------------- existing-record lookup */
const readRef = async (ref) => {
  try {
    const snap = await getDoc(ref);
    return snap.exists() ? { id: snap.id, ref: snap.ref, data: snap.data() } : null;
  } catch (_) {
    // Rules deny reading another person's record — that is the expected answer.
    return null;
  }
};

/**
 * Find a pre-portal `students` record that provably belongs to this person so
 * signup can ADOPT it instead of creating a duplicate.
 *
 * Candidates come from the `uniqueness` index built by the migration:
 *   uniqueness/email_<email>  -> { ownerPath }
 *   uniqueness/phone_<phone>  -> { owners: [...] }
 * The identity match is re-checked against the caller's auth email here AND
 * enforced by firestore.rules, so a record can never be stolen.
 */
export const findAdoptableRecord = async ({ phone, email, uid }) => {
  const candidates = [];
  const authEmail = getAuth().currentUser?.email || "";

  if (email) {
    const c = await readRef(doc(db, "uniqueness", "email_" + email.toLowerCase()));
    if (c && c.data.ownerPath) candidates.push(c.data.ownerPath);
  }
  if (phone) {
    const p = await readRef(doc(db, "uniqueness", "phone_" + phone));
    if (p && Array.isArray(p.data.owners)) candidates.push(...p.data.owners);
  }

  for (const path of candidates) {
    const parts = String(path).split("/");
    if (parts.length !== 2) continue;
    const found = await readRef(doc(db, parts[0], parts[1]));
    if (!found) continue;

    const d = found.data;
    if (d.mergedInto) continue;               // already a retired duplicate
    if (d.uid && d.uid !== uid) continue;     // belongs to somebody else
    if (d.uid === uid) return found;          // already ours (retry after a crash)

    // Provable identity: the auth email must be this record's email, or the
    // alias form of this record's phone number.
    const matches =
      (has(d.email) && d.email.toLowerCase() === authEmail) ||
      (has(d.phone) && phoneToAuthEmail(normalizePhone(d.phone)) === authEmail);
    if (!matches) continue;

    return found;
  }
  return null;
};

/* ------------------------------------------------------------------ signup */
/**
 * Create the Auth account, then write `users/{uid}` + `students/{uid}` in ONE
 * transaction (adopting a legacy record when one matches).
 *
 * Auth creation cannot participate in a Firestore transaction, so it happens
 * first; if the transaction later fails we simply run again — the second call
 * finds the account already exists, signs into it, and repairs the records.
 *
 * @returns {Promise<{uid, studentId, adopted, authEmail}>}
 */
export const completeSignup = async ({ identifier, password, name }) => {
  const raw = String(identifier || "").trim();
  const digits = raw.replace(/\D/g, "");
  const isPhone = !raw.includes("@") && digits.length === 10;

  let phone = "";
  let email = "";
  if (isPhone) {
    if (!isValidPhone(digits)) throw new Error("Please enter a valid 10-digit mobile number.");
    phone = normalizePhone(digits);
    email = "";
  } else {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
      throw new Error("Please enter a valid email address or a 10-digit mobile number.");
    }
    email = raw.toLowerCase();
  }

  const authEmail = isPhone ? phoneToAuthEmail(phone) : email;

  // 1) Auth account first — this is what makes login possible at all.
  let cred;
  try {
    cred = await createUserWithEmailAndPassword(getAuth(), authEmail, password);
  } catch (err) {
    if (err.code !== "auth/email-already-in-use") {
      if (err.code === "auth/weak-password") throw new Error("Password must be at least 6 characters.");
      throw err;
    }
    // Either our own half-finished signup (step 2 failed) or a real duplicate.
    try {
      cred = await signInWithEmailAndPassword(getAuth(), authEmail, password);
    } catch (_) {
      throw new Error(
        isPhone
          ? "This mobile number already has an account. Please sign in instead."
          : "This email already has an account. Please sign in instead."
      );
    }
  }
  const uid = cred.user.uid;

  // 2) Look for a record to adopt BEFORE creating a new one.
  const existing = await findAdoptableRecord({ phone, email, uid });

  const studentDocId = uid;

  // 3) Sequential admission number (SH-xxxx).
  //    Allocated BEFORE the transaction: `studentId` / `admissionNo` are
  //    staff-only fields on UPDATE, so a later `updateDoc` would be rejected by
  //    the security rules — the number has to arrive inside the CREATE payload
  //    of students/{uid}. Adopting an existing record keeps that record's
  //    number, so we only allocate when the person is genuinely new.
  let studentId = existing && has(existing.data.studentId)
    ? String(existing.data.studentId)
    : "";
  if (!studentId) {
    try {
      const { getNextStudentId } = await import("./studentIdService.js");
      studentId = await getNextStudentId();
    } catch (e) {
      console.warn("[onboarding] studentId allocation skipped:", e.message);
      studentId = "";
    }
  }

  // 4) Single transaction: claim identity + write both documents atomically.
  const adopted = await runTransaction(db, async (tx) => {
    const studentsRef = doc(db, "students", studentDocId);
    const usersRef = doc(db, "users", uid);

    // ALL READS FIRST. Firestore rejects any tx.get() issued after a tx.set(),
    // and reading here (instead of below) is what unblocks account creation:
    // the old docs snapshot never depends on the writes above it.
    const oldDocsRef = existing ? doc(db, "studentDocuments", existing.id) : null;
    const oldDocsSnap = oldDocsRef ? await tx.get(oldDocsRef) : null;

    // Same for the uniqueness claims: EVERY read in this transaction has to be
    // issued before the first tx.set(), or Firestore aborts the whole thing.
    // A client may only CREATE a claim (never rewrite one), so we must know
    // what already exists before a single write happens.
    const emailClaimRef = email ? doc(db, "uniqueness", "email_" + email) : null;
    const emailClaimSnap = emailClaimRef ? await tx.get(emailClaimRef) : null;
    const phoneClaimRef = phone ? doc(db, "uniqueness", "phone_" + phone) : null;
    const phoneClaimSnap = phoneClaimRef ? await tx.get(phoneClaimRef) : null;

    const base = {
      uid,
      authEmail,
      loginId: isPhone ? phone : email,
      role: "Student",
      isStudentSubmission: true,
      source: existing && existing.data.source ? existing.data.source : "Portal",
      termsAccepted: true,
      updatedAt: serverTimestamp()
    };
    if (has(name)) base.name = name;

    if (existing) {
      if (existing.id !== studentDocId) {
        // Move: canonical record follows the person to students/{uid}.
        const moved = { ...existing.data, ...base };
        delete moved.mergedInto;
        moved.needsReview = false;
        // The admission number follows the person; if the legacy record never
        // had one, the freshly allocated number is stamped here (this write is
        // the CREATE of students/{uid}, where studentId is allowed).
        if (!has(moved.studentId)) { moved.studentId = studentId; }
        if (!has(moved.admissionNo)) { moved.admissionNo = studentId; }
        // Lifecycle rule: an already-approved member keeps their approval (they
        // are only claiming a portal login). Anyone not yet approved re-applies
        // through the wizard — adoption must never bypass admin approval.
        const wasApproved =
          existing.data.approvalStatus === "Approved" || existing.data.status === "Active";
        if (!wasApproved) {
          moved.status = "Pending";
          moved.approvalStatus = "Pending";
        }
        tx.set(studentsRef, moved, { merge: true });

        // Retire the shell WITHOUT deleting it: it points at the survivor.
        tx.set(existing.ref, {
          mergedInto: "students/" + studentDocId,
          needsReview: true,
          status: "Old",
          studentId: "",
          admissionNo: "",
          uid: "",
          authEmail: "",
          updatedAt: serverTimestamp()
        }, { merge: true });

        // Move identity documents too so Aadhaar/selfie follow the person.
        // oldDocsSnap was already read at the top of this transaction.
        if (oldDocsSnap && oldDocsSnap.exists()) {
          tx.set(doc(db, "studentDocuments", studentDocId), oldDocsSnap.data(), { merge: true });
          tx.set(oldDocsRef, { studentId: "", migratedTo: "studentDocuments/" + studentDocId }, { merge: true });
        }
      } else {
        tx.set(studentsRef, base, { merge: true });
      }
    } else {
      // Brand-new member — born at students/{uid}, exactly as the rules expect.
      tx.set(studentsRef, {
        ...base,
        name: has(name) ? name : "",
        phone,
        email,
        dob: "", gender: "", parentPhone: "", college: "", course: "",
        address: "", remarks: "",
        planId: "", planName: "", seatNumber: "", seatId: "",
        paymentMethod: "", transactionId: "", paymentDueDate: "",
        paymentScreenshotUrl: "",
        status: "Pending",
        approvalStatus: "Pending",
        // Owner rule: the admin's admission alert / Pending-approval badge must
        // stay SILENT until this student has filed the entire onboarding form.
        // See submitPaymentAndApplication for the flip to true.
        applicationReady: false,
        studentId,
        admissionNo: studentId,
        createdAt: serverTimestamp()
      }, { merge: false });
    }

    tx.set(usersRef, {
      uid,
      email: authEmail,
      name: has(name) ? name : (existing && existing.data.name) || "",
      role: "Student",
      status: "Pending",
      loginId: isPhone ? phone : email,
      createdAt: serverTimestamp()
    }, { merge: true });

    // Identity claims are CREATE-ONLY from a client: the security rules allow
    // staff to rewrite claims but a student to create them, so re-`set`-ing an
    // existing claim would abort the whole transaction. An existing claim
    // already points at the right record — that is all we need it for.
    // Claims were read at the very top; only the CREATE happens down here,
    // after every other write in this transaction.
    if (emailClaimRef && !emailClaimSnap.exists()) {
      tx.set(emailClaimRef, {
        kind: "email",
        uid,
        ownerPath: "students/" + studentDocId,
        createdAt: serverTimestamp()
      });
    }
    if (phoneClaimRef && !phoneClaimSnap.exists()) {
      tx.set(phoneClaimRef, {
        kind: "phone-index",
        owners: ["students/" + studentDocId],
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    }
    // An existing claim is migration output and is only ever READ — appending
    // to it would be a forbidden update. It stays valid regardless: entries
    // pointing at a record that now carries a uid are simply not adoptable.

    return !!existing;
  });

  return { uid, studentId, adopted, authEmail };
};

/* --------------------------------------------------------------- self-heal */
/**
 * Guarantee a signed-in user resolves to exactly one `students` document.
 * Runs on every portal load — this is what makes login *reliably* work even
 * for accounts created before this migration.
 *
 * @returns {Promise<string>} the student document id
 */
export const ensureStudentRecord = async () => {
  const user = getAuth().currentUser;
  if (!user) throw new Error("You are not signed in.");

  const uid = user.uid;
  const existing = await readRef(doc(db, "students", uid));
  if (existing) return existing.id;

  const authEmail = (user.email || "").toLowerCase();
  const phone = authEmail.endsWith("@student.shreejilibrary.com")
    ? authEmail.split("@")[0]
    : "";
  const email = phone ? "" : authEmail;

  const adopt = await findAdoptableRecord({ phone, email, uid });
  if (adopt && adopt.id !== uid) {
    // Same move as in completeSignup — one transaction, never a duplicate.
    await runTransaction(db, async (tx) => {
      const target = doc(db, "students", uid);

      // ALL READS FIRST - Firestore forbids a read after a write in the same
      // transaction, which is what used to kill this adoption (and with it,
      // account creation).
      const oldDocsRef = doc(db, "studentDocuments", adopt.id);
      const oldDocsSnap = await tx.get(oldDocsRef);
      const moved = { ...adopt.data, uid, authEmail, role: "Student", updatedAt: serverTimestamp() };
      delete moved.mergedInto;
      // Keep an approved member approved; otherwise re-open for the wizard.
      const wasApproved =
        adopt.data.approvalStatus === "Approved" || adopt.data.status === "Active";
      if (!wasApproved) { moved.status = "Pending"; moved.approvalStatus = "Pending"; }
      tx.set(target, moved, { merge: true });
      tx.set(adopt.ref, {
        mergedInto: "students/" + uid,
        needsReview: true,
        status: "Old",
        studentId: "",
        admissionNo: "",
        uid: "",
        updatedAt: serverTimestamp()
      }, { merge: true });

      if (oldDocsSnap.exists()) {
        tx.set(doc(db, "studentDocuments", uid), oldDocsSnap.data(), { merge: true });
        tx.set(oldDocsRef, { studentId: "", migratedTo: "studentDocuments/" + uid }, { merge: true });
      }

      tx.set(doc(db, "users", uid), {
        uid, email: authEmail, role: "Student", status: "Pending",
        name: adopt.data.name || "", loginId: adopt.data.loginId || phone || email,
        createdAt: serverTimestamp()
      }, { merge: true });
    });
    return uid;
  }

  if (adopt && adopt.id === uid) return uid;

  // Nothing to adopt — create a fresh pending record for this account.
  await setDoc(doc(db, "students", uid), {
    uid,
    authEmail,
    loginId: phone || email,
    name: "", phone, email,
    dob: "", gender: "", parentPhone: "", college: "", course: "",
    address: "", remarks: "",
    planId: "", planName: "", seatNumber: "", seatId: "",
    paymentMethod: "", transactionId: "", paymentDueDate: "", paymentScreenshotUrl: "",
    role: "Student",
    status: "Pending",
    approvalStatus: "Pending",
    // Not yet an application — nothing for the admin to see until the wizard's
    // final submit flips this (see submitPaymentAndApplication).
    applicationReady: false,
    isStudentSubmission: true,
    source: "Portal",
    studentId: "", admissionNo: "",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  }, { merge: false });

  await setDoc(doc(db, "users", uid), {
    uid, email: authEmail, role: "Student", status: "Pending",
    name: "", loginId: phone || email, createdAt: serverTimestamp()
  }, { merge: true });

  return uid;
};

/* ------------------------------------------------------------- step writers */
/** Writable fields for a student editing their own record (rules mirror this). */
const PROFILE_FIELDS = [
  "name", "phone", "email", "dob", "gender", "parentPhone",
  "college", "course", "address", "remarks",
  "planId", "planName", "seatNumber", "seatId",
  "paymentMethod", "transactionId", "paymentDueDate", "paymentScreenshotUrl"
];

const pick = (obj, keys) => {
  const out = {};
  keys.forEach((k) => { if (obj[k] !== undefined) out[k] = obj[k]; });
  return out;
};

export const saveDetails = async (studentId, details) => {
  try {
    const payload = pick(details, PROFILE_FIELDS);
    if (payload.email) payload.email = String(payload.email).trim().toLowerCase();
    if (payload.phone) payload.phone = normalizePhone(payload.phone);
    await updateDoc(doc(db, "students", studentId), {
      ...payload,
      updatedAt: serverTimestamp()
    });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
};

export const savePlan = async (studentId, plan) => {
  try {
    await updateDoc(doc(db, "students", studentId), {
      planId: plan.id || "",
      planName: plan.planName || "",
      // Choosing a non-seat plan releases any seat picked earlier.
      ...(planRequiresSeat(plan) ? {} : { seatNumber: "", seatId: "" }),
      updatedAt: serverTimestamp()
    });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
};

/**
 * Claim a seat atomically. Fails cleanly when somebody else took it first —
 * this is the single guarantee against two students holding one seat.
 * The seat doc id is the seat NUMBER (seats/A17).
 */
export const reserveSeat = async (studentId, seatNumber, studentName) => {
  try {
    await runTransaction(db, async (tx) => {
      const seatRef = doc(db, "seats", seatNumber);
      const seatSnap = await tx.get(seatRef);
      if (!seatSnap.exists()) throw new Error("That seat no longer exists.");
      const seat = seatSnap.data();
      const uid = getAuth().currentUser.uid;

      const free =
        seat.status === "Available" ||
        seat.status === "Reserved" && seat.assignedStudentId === uid;
      if (!free) throw new Error(`Seat ${seatNumber} was just taken. Please pick another.`);

      tx.update(seatRef, {
        status: "Reserved",
        assignedStudentId: uid,
        assignedStudentName: studentName || "",
        lastUpdated: serverTimestamp()
      });
      tx.update(doc(db, "students", studentId), {
        seatNumber,
        seatId: seatNumber,
        updatedAt: serverTimestamp()
      });
    });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
};

/** Release a seat the student previously reserved (e.g. they changed plan). */
export const releaseSeat = async (seatNumber) => {
  if (!seatNumber) return { success: true };
  try {
    await runTransaction(db, async (tx) => {
      const seatRef = doc(db, "seats", seatNumber);
      const snap = await tx.get(seatRef);
      if (!snap.exists()) return;
      const seat = snap.data();
      const uid = getAuth().currentUser.uid;
      if (seat.status === "Occupied") return;          // already in use at the desk
      if (seat.assignedStudentId && seat.assignedStudentId !== uid) return; // not ours
      tx.update(seatRef, {
        status: "Available",
        assignedStudentId: "",
        assignedStudentName: "",
        lastUpdated: serverTimestamp()
      });
    });
    return { success: true };
  } catch (e) {
    console.warn("[onboarding] release seat:", e.message);
    return { success: false, error: e.message };
  }
};

/**
 * Persist the payment choice AND flip the application to "submitted".
 * For Pay Now the UPI reference is claimed in the same transaction so the same
 * reference can never be submitted twice.
 *
 * Idempotent: re-submitting an already-submitted application is a no-op.
 */
export const submitPaymentAndApplication = async (studentId, { paymentMethod, transactionId, paymentDueDate, paymentScreenshotUrl }) => {
  try {
    const auth = getAuth();
    const uid = auth.currentUser.uid;
    const now = serverTimestamp();

    await runTransaction(db, async (tx) => {
      const studentRef = doc(db, "students", studentId);
      const snap = await tx.get(studentRef);
      if (!snap.exists()) throw new Error("Your record could not be found. Please refresh.");
      const current = snap.data();

      // READ FIRST: the transaction-ID claim must be read before tx.update()
      // below, because Firestore allows no read at all once a write has been
      // issued in the same transaction.
      const key = String(transactionId || "").trim().toLowerCase();
      const claimRef =
        paymentMethod === "Paid" && transactionId && key !== "rc-imp"
          ? doc(db, "uniqueness", "txn_" + key)
          : null;
      const claimSnap = claimRef ? await tx.get(claimRef) : null;

      if (current.approvalStatus === "Approved") {
        throw new Error("This application has already been approved.");
      }

      const payload = {
        paymentMethod,
        transactionId: transactionId || "",
        paymentScreenshotUrl: paymentScreenshotUrl || "",
        termsAccepted: true,
        updatedAt: now,
        // THE gate for the admin's admission alert. This is the last step of
        // the onboarding wizard, so flipping it here is exactly "after the
        // student fills the entire onboarding form — then and only then".
        // `submittedAt` is also where the admin's 7-day auto-expire counts
        // from, so a long-abandoned sign-up still gets its full week.
        applicationReady: true,
        submittedAt: now
      };
      // Pay Later records a due date; Pay Now clears any due date left over
      // from an earlier attempt so the pending screen can never show both.
      payload.paymentDueDate = paymentMethod === "Pay Later" ? (paymentDueDate || "") : "";

      tx.update(studentRef, payload);

      if (claimRef) {
        if (claimSnap.exists()) {
          const owner = claimSnap.data().ownerPath || "";
          const mine = owner === "students/" + studentId || owner === uid;
          if (!mine) throw new Error("That transaction ID has already been used.");
          // Already ours — claims are create-only for clients, so there is
          // nothing to rewrite; re-asserting an existing claim would be denied.
        } else {
          tx.set(claimRef, {
            kind: "transactionId",
            ownerPath: "students/" + studentId,
            createdAt: now
          });
        }
      }
    });

    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
};

/** Read the student's uploaded identity documents (Aadhaar/selfie/screenshot). */
export const loadStudentDocuments = async (studentId) => {
  try {
    const snap = await getDoc(doc(db, "studentDocuments", studentId));
    return snap.exists() ? snap.data() : {};
  } catch (e) {
    console.warn("[onboarding] documents:", e.message);
    return {};
  }
};
