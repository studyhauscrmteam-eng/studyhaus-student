import { collection, query, where, getDocs, doc, getDoc } from "firebase/firestore";
import { db } from "../firebase/firebase.js";

/**
 * Validates a plan before creation or update.
 */
export const validatePlan = async (planData) => {
  if (!planData.planName || planData.planName.trim() === "") {
    throw new Error("Plan name is required.");
  }

  if (Number(planData.price) <= 0) {
    throw new Error("Price must be greater than zero.");
  }

  if (planData.capacity !== undefined && Number(planData.capacity) < 0) {
    throw new Error("Capacity must be positive.");
  }

  // Duplicate plan name check
  // Note: For updates, you would normally exclude the current plan ID, but 
  // since we're keeping it simple and using prompts, we will just check if a plan 
  // with the exact same name exists (and it's not the same plan being edited).
  const plansRef = collection(db, "membershipPlans");
  const q = query(plansRef, where("planName", "==", planData.planName.trim()));
  const snapshot = await getDocs(q);
  
  // If editing, we ignore the match if it has the same ID
  const duplicate = snapshot.docs.find(doc => doc.id !== planData.id);
  if (duplicate) {
    throw new Error(`A plan named '${planData.planName}' already exists.`);
  }

  return true;
};

/**
 * Fetch one membership plan by ID (null when missing/unreadable).
 */
export const getPlanById = async (planId) => {
  if (!planId) return null;
  try {
    const snap = await getDoc(doc(db, "membershipPlans", planId));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  } catch (_) {
    return null;
  }
};

/**
 * Whether a plan lets the student PICK their seat on the map.
 * Missing flag (older plans) means view-only → false.
 * Accepts a plan object OR a plan ID.
 */
export const planAllowsSeatSelection = async (planOrId) => {
  const plan = typeof planOrId === "string" ? await getPlanById(planOrId) : (planOrId || null);
  return !!(plan && plan.seatPreference === true);
};

/**
 * Checks if the Rotational Plan capacity (30) is reached.
 * Returns true if available, false if full.
 */
export const checkRotationalCapacity = async () => {
  // We need to count active students who have the Rotational plan
  const q = query(
    collection(db, "students"),
    where("status", "==", "Active"),
    where("planName", "==", "Rotational Seat")
  );
  
  const snapshot = await getDocs(q);
  return snapshot.size < 30;
};
