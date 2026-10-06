import { collection, addDoc, getDocs, updateDoc, deleteDoc, doc } from "firebase/firestore";
import { db } from "../firebase/firebase.js";

const DEFAULT_TEMPLATES = [
  {
    name: "Birthday Wish",
    message: "Happy Birthday {StudentName}! Wishing you a wonderful year ahead from {LibraryName}."
  },
  {
    name: "Payment Reminder",
    message: "Hello {StudentName}, your pending amount is ₹{PendingAmount}. Kindly complete your payment before {RenewalDate}. Thank you."
  },
  {
    name: "Renewal Reminder",
    message: "Hello {StudentName}, your membership for {MembershipPlan} is due on {RenewalDate}. Please renew it on time."
  },
  {
    name: "Feedback Request",
    message: "Hello {StudentName}, we value your feedback. Please let us know how your experience at {LibraryName} has been."
  },
  {
    name: "Thank You Message",
    message: "Thank you {StudentName} for being a valued member of {LibraryName}."
  }
];

export const seedInitialTemplates = async () => {
  const role = localStorage.getItem("userRole");
  if (role === "Student") return;

  const templatesRef = collection(db, "messageTemplates");
  const snap = await getDocs(templatesRef);
  
  if (snap.empty) {
    console.log("Seeding default WhatsApp templates...");
    for (const t of DEFAULT_TEMPLATES) {
      await addDoc(templatesRef, t);
    }
  }
};

export const fetchAllTemplates = async () => {
  const templatesRef = collection(db, "messageTemplates");
  const snap = await getDocs(templatesRef);
  const templates = [];
  snap.forEach(doc => templates.push({ id: doc.id, ...doc.data() }));
  return templates;
};

export const addTemplate = async (templateData) => {
  const templatesRef = collection(db, "messageTemplates");
  const docRef = await addDoc(templatesRef, templateData);
  return { id: docRef.id, ...templateData };
};

export const updateTemplate = async (id, templateData) => {
  const docRef = doc(db, "messageTemplates", id);
  await updateDoc(docRef, templateData);
  return { id, ...templateData };
};

export const deleteTemplate = async (id) => {
  const docRef = doc(db, "messageTemplates", id);
  await deleteDoc(docRef);
};

