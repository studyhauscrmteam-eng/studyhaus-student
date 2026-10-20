import { collection, addDoc, query, onSnapshot, serverTimestamp, orderBy, deleteDoc, doc, getDocs, where } from "firebase/firestore";
import { db } from "../firebase/firebase.js";

/**
 * Creates a new announcement in Firestore
 */
export const createAnnouncement = async (data) => {
  try {
    const announcementData = {
      title: data.title,
      message: data.message,
      audience: data.audience || "All Students", // "All Students", "Active Only", etc.
      scheduledFor: data.scheduledFor || null, // Optional future date
      type: data.type || "info", // "info", "warning", "success"
      createdBy: data.createdBy,
      createdAt: serverTimestamp(),
      status: "Active"
    };

    if (data.targetStudentIds && data.audience === "Specific Students") {
      announcementData.targetStudentIds = data.targetStudentIds;
    }

    const docRef = await addDoc(collection(db, "announcements"), announcementData);
    return { success: true, id: docRef.id };
  } catch (error) {
    console.error("Error creating announcement:", error);
    return { success: false, error: error.message };
  }
};

export const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Normalizes timestamp when announcement was announced/published
 */
export const getAnnouncementAnnounceTime = (a) => {
  if (!a) return null;
  if (a.scheduledFor) {
    const t = new Date(a.scheduledFor).getTime();
    if (!Number.isNaN(t)) return t;
  }
  if (a.createdAt?.seconds) return a.createdAt.seconds * 1000;
  if (typeof a.createdAt === "string") {
    const t = Date.parse(a.createdAt);
    if (!Number.isNaN(t)) return t;
  }
  return null;
};

/**
 * Checks whether an announcement has exceeded its 1-day (24h) lifespan since announced
 */
export const isAnnouncementExpired = (a, now = Date.now()) => {
  const annTime = getAnnouncementAnnounceTime(a);
  if (!annTime) return false;
  return (now - annTime) >= ONE_DAY_MS;
};

/**
 * A future `scheduledFor` means "publish at this time". Live = no schedule,
 * an unparseable schedule, or a schedule at/before now — and NOT expired (> 1 day old).
 */
export const isAnnouncementLive = (a, now = Date.now()) => {
  if (!a) return false;
  if (isAnnouncementExpired(a, now)) return false;
  if (!a.scheduledFor) return true;
  const t = new Date(a.scheduledFor).getTime();
  return Number.isNaN(t) || t <= now;
};

/**
 * Gets all active students for dropdown selection
 */
export const getAllStudentsForDropdown = async () => {
  try {
    const q = query(collection(db, "students"), where("status", "==", "Active"));
    const snap = await getDocs(q);
    return snap.docs.map(doc => ({ id: doc.id, name: doc.data().name || "Unknown", phone: doc.data().phone || "" }));
  } catch (err) {
    console.error("Error fetching students for dropdown:", err);
    return [];
  }
};

/**
 * Listens to all announcements in real-time, auto-filtering announcements older than 1 day
 */
export const listenToAnnouncements = (onUpdate) => {
  const q = query(collection(db, "announcements"), orderBy("createdAt", "desc"));
  return onSnapshot(q, (snapshot) => {
    const now = Date.now();
    const announcements = [];
    snapshot.forEach(doc => {
      const item = { id: doc.id, ...doc.data() };
      if (!isAnnouncementExpired(item, now)) {
        announcements.push(item);
      }
    });
    onUpdate(announcements);
  });
};

/**
 * Deletes an announcement
 */
export const deleteAnnouncement = async (id) => {
  try {
    await deleteDoc(doc(db, "announcements", id));
    return { success: true };
  } catch (error) {
    console.error("Error deleting announcement:", error);
    return { success: false, error: error.message };
  }
};
