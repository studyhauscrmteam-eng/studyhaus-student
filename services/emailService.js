import { collection, addDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase/firebase.js";

/**
 * Email facility — Firestore "mail" collection pattern.
 *
 * The app itself never holds the Gmail App Password in code.
 * Install the Firebase "Trigger Email" extension (or any SMTP sender)
 * configured with your Gmail address + Google App Password, and it will
 * deliver every document written to the `mail` collection:
 *
 *   mail/{autoId} = { to, message: { subject, text, html }, meta… }
 *
 * See EMAIL_SETUP.md for the 10-minute setup guide.
 */

const queueEmail = async ({ to, subject, text = "", html = "", meta = {} }) => {
  if (!to || !subject) return { success: false, error: "Missing recipient or subject." };
  try {
    await addDoc(collection(db, "mail"), {
      to: Array.isArray(to) ? to : [to],
      message: { subject, text: text || stripTags(html), html: html || `<p>${escapeHtml(text)}</p>` },
      meta: { ...meta, queuedAt: new Date().toISOString() },
      createdAt: serverTimestamp(),
      delivery: { state: "PENDING" },
    });
    return { success: true };
  } catch (e) {
    console.warn("[email] queue failed:", e?.message || e);
    return { success: false, error: e?.message || "Could not queue email." };
  }
};

const escapeHtml = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const stripTags = (html) => String(html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

const layout = (title, lines, footerNote = "") => `
  <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
    <div style="background:#059669;color:#fff;padding:16px 20px;font-size:18px;font-weight:bold;">Studyhaus · ${escapeHtml(title)}</div>
    <div style="padding:20px;color:#0f172a;font-size:14px;line-height:1.6;">
      ${lines.map((l) => `<p style="margin:0 0 10px;">${l}</p>`).join("")}
      ${footerNote ? `<p style="margin-top:16px;color:#64748b;font-size:12px;">${footerNote}</p>` : ""}
    </div>
  </div>`;

export const sendAdmissionReceivedMail = (student) => {
  if (!student?.email) return Promise.resolve({ success: false, error: "No student email." });
  return queueEmail({
    to: student.email,
    subject: `Admission request received — ${student.name || "Studyhaus"}`,
    html: layout("Admission request received", [
      `Hi <b>${escapeHtml(student.name || "Student")}</b>,`,
      `Your admission request for <b>${escapeHtml(student.planName || "your plan")}</b> has been received and is <b>pending admin approval</b>.`,
      `Your admission number is <b>${escapeHtml(student.studentId || student.admissionNo || "—")}</b>.`,
      `We will email you again once the admin approves or rejects your request.`,
    ]),
    meta: { kind: "admission-received", studentId: student.id || "", phone: student.phone || "" },
  });
};

export const sendAdmissionApprovedMail = (student) => {
  if (!student?.email) return Promise.resolve({ success: false, error: "No student email." });
  return queueEmail({
    to: student.email,
    subject: `Admission approved — welcome to Studyhaus, ${student.name || ""}!`,
    html: layout("Admission approved", [
      `Hi <b>${escapeHtml(student.name || "Student")}</b>,`,
      `Good news! Your admission has been <b style="color:#059669;">approved</b>.`,
      `Admission number: <b>${escapeHtml(student.studentId || "—")}</b> · Seat: <b>${escapeHtml(student.seatNumber || "to be assigned")}</b> · Plan: <b>${escapeHtml(student.planName || "—")}</b>`,
      student.loginId
        ? `You can sign in to the student portal with Login ID <b>${escapeHtml(student.loginId)}</b>.`
        : `Please contact the desk for your portal login details.`,
    ]),
    meta: { kind: "admission-approved", studentId: student.id || "" },
  });
};

export const sendAdmissionRejectedMail = (student, reason = "") => {
  if (!student?.email) return Promise.resolve({ success: false, error: "No student email." });
  return queueEmail({
    to: student.email,
    subject: `Update on your Studyhaus admission request`,
    html: layout("Admission update", [
      `Hi <b>${escapeHtml(student.name || "Student")}</b>,`,
      `Your admission request was <b style="color:#b91c1c;">not approved</b> at this time.`,
      reason ? `Reason given by admin: <i>${escapeHtml(reason)}</i>` : `Please contact the desk if you need more details.`,
    ]),
    meta: { kind: "admission-rejected", studentId: student.id || "" },
  });
};

export const sendAdminNewAdmissionMail = (adminEmail, admission) => {
  if (!adminEmail) return Promise.resolve({ success: false, error: "No admin email configured." });
  return queueEmail({
    to: adminEmail,
    subject: `New admission request: ${admission.name || "Student"} — action needed`,
    html: layout("Action needed: new admission", [
      `A new admission request needs your decision.`,
      `Name: <b>${escapeHtml(admission.name || "—")}</b><br>Phone: <b>${escapeHtml(admission.phone || "—")}</b><br>Plan: <b>${escapeHtml(admission.planName || "—")}</b><br>Admission no: <b>${escapeHtml(admission.studentId || admission.admissionNo || "—")}</b>`,
      `Open the CRM → <b>Admissions → Pending approval</b> to Approve or Reject.`,
    ]),
    meta: { kind: "admin-new-admission", admissionId: admission.id || "" },
  });
};

/** Generic sender used by the student-profile "Send Email" button. */
export const sendCustomMail = ({ to, subject, body }) =>
  queueEmail({
    to,
    subject,
    html: layout(subject, [escapeHtml(body).replace(/\n/g, "<br>")]),
    meta: { kind: "custom" },
  });
