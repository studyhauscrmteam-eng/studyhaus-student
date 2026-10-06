import { collection, addDoc, serverTimestamp, query, where, orderBy, limit, onSnapshot, updateDoc, doc, getDocs } from "firebase/firestore";
import { db } from "../firebase/firebase.js";

/**
 * In-app admin notifications (bell/badge + pending queue).
 * Collection: notifications/{autoId}
 * { type, title, body, admissionId, studentId, createdAt, read, forRoles }
 */

export const notifyAdmins = async ({ type, title, body, admissionId = "", studentId = "" }) => {
  try {
    await addDoc(collection(db, "notifications"), {
      type: type || "info",
      title: title || "Notification",
      body: body || "",
      admissionId,
      studentId,
      read: false,
      forRoles: ["Owner/Admin", "Manager"],
      createdAt: serverTimestamp(),
    });
  } catch (e) {
    console.warn("[notifications] queue failed:", e?.message || e);
  }
};

export const notifyNewAdmission = (admission) =>
  notifyAdmins({
    type: "new-admission",
    title: "New admission request",
    body: `${admission.name || "A student"} (${admission.phone || "no phone"}) requested "${admission.planName || "a plan"}". Open Admissions → Pending approval.`,
    admissionId: admission.id || admission.uid || "",
  });

/**
 * Live count of unread admin notifications for the Pending badge.
 */
export const listenToUnreadNotifications = (onUpdate) => {
  try {
    const q = query(collection(db, "notifications"), where("read", "==", false));
    return onSnapshot(
      q,
      (snap) => {
        let count = 0;
        snap.forEach(() => count++);
        onUpdate(count);
      },
      () => onUpdate(0)
    );
  } catch {
    onUpdate(0);
    return () => {};
  }
};

/**
 * Live list of the latest admin notifications (for the Notifications page).
 */
export const listenToAdminNotifications = (onUpdate, max = 20) => {
  try {
    const q = query(collection(db, "notifications"), orderBy("createdAt", "desc"), limit(max));
    return onSnapshot(
      q,
      (snap) => {
        const list = [];
        snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
        onUpdate(list);
      },
      () => onUpdate([])
    );
  } catch {
    onUpdate([]);
    return () => {};
  }
};

export const markNotificationRead = async (id) => {
  try {
    await updateDoc(doc(db, "notifications", id), { read: true });
  } catch (e) {
    console.warn("[notifications] mark-read failed:", e?.message || e);
  }
};

export const markAllNotificationsRead = async () => {
  try {
    const q = query(collection(db, "notifications"), where("read", "==", false));
    const snap = await getDocs(q);
    await Promise.all(snap.docs.map((d) => updateDoc(d.ref, { read: true })));
  } catch (e) {
    console.warn("[notifications] mark-all-read failed:", e?.message || e);
  }
};
