import { collection, addDoc, query, onSnapshot, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase/firebase.js";

export const logWhatsAppMessage = async (logData) => {
  try {
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

    await addDoc(collection(db, "messageLogs"), {
      studentId: logData.studentId || "Unknown",
      studentName: logData.studentName || "Unknown",
      phone: logData.phone,
      templateName: logData.templateName || "Custom",
      message: logData.message,
      sentBy: logData.sentBy || "System",
      sentDate: dateStr,
      status: "Sent",
      createdAt: serverTimestamp()
    });
    return { success: true };
  } catch (error) {
    console.error("Failed to log message:", error);
    return { success: false, error: error.message };
  }
};

export const listenToMessageLogs = (onUpdate) => {
  const q = query(collection(db, "messageLogs"));
  return onSnapshot(q, (snapshot) => {
    const records = [];
    snapshot.forEach(doc => records.push({ id: doc.id, ...doc.data() }));
    // Sort descending by sentDate
    records.sort((a, b) => new Date(b.sentDate).getTime() - new Date(a.sentDate).getTime());
    onUpdate(records);
  });
};
