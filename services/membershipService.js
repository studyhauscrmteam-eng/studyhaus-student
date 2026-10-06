import { collection, onSnapshot, addDoc, deleteDoc, updateDoc, doc, getDocs, query } from "firebase/firestore";
import { db } from "../firebase/firebase.js";
import { validatePlan } from "./planValidation.js";
import { canEditPlans, canViewManualPlans, enforcePlanUIPermissions } from "./planPermissions.js";

const DEFAULT_PLANS = [
  {
    planName: "Regular Fixed Seat",
    price: 1000,
    duration: "1 Month",
    seatType: "Fixed",
    seatPreference: true,
    isManual: false,
    status: "Active",
    createdAt: new Date().toISOString()
  },
  {
    planName: "Rotational Seat",
    price: 800,
    duration: "1 Month",
    seatType: "Rotational",
    capacity: 30,
    seatPreference: false,
    isManual: false,
    status: "Active",
    createdAt: new Date().toISOString()
  },
  {
    planName: "Night Study",
    price: 700,
    duration: "1 Month",
    allowedStartTime: "19:00",
    allowedEndTime: "07:00",
    seatPreference: false,
    isManual: false,
    status: "Active",
    createdAt: new Date().toISOString()
  }
];

/**
 * Initializes the membership plans module
 */
export const initMembershipPlans = async () => {
  const grid = document.getElementById("membership-plans-grid");
  if (!grid) return; // Not on the memberships page

  if (!document.getElementById("add-plan-modal")) {
    const modalDiv = document.createElement("div");
    modalDiv.innerHTML = `
      <dialog id="add-plan-modal" class="card" style="border:none; border-radius:12px; padding:0; box-shadow:0 10px 30px rgba(0,0,0,0.5); background: var(--bg-card); color: var(--text-primary);">
        <div style="padding: 1.5rem; min-width: 400px; max-width: 500px; max-height: 85vh; overflow-y: auto;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;">
            <h2 style="margin: 0;">Add New Plan</h2>
            <button class="btn btn-ghost" onclick="document.getElementById('add-plan-modal').close()" style="padding: 0.25rem 0.5rem;">✕</button>
          </div>
          <form id="add-plan-form" onsubmit="event.preventDefault(); window.submitPlanForm()">
            <div class="form-group" style="margin-bottom: 1rem;">
              <label style="display:block; margin-bottom:0.25rem; font-size:0.875rem; font-weight:600; color:var(--text-secondary);">Plan Name</label>
              <input type="text" id="add-plan-name" required placeholder="e.g. Weekend Pass" class="input-field" style="width: 100%; box-sizing: border-box; padding: 0.5rem;" />
            </div>
            <div class="form-group" style="margin-bottom: 1rem;">
              <label style="display:block; margin-bottom:0.25rem; font-size:0.875rem; font-weight:600; color:var(--text-secondary);">Price (₹)</label>
              <input type="number" id="add-plan-price" required min="1" placeholder="e.g. 500" class="input-field" style="width: 100%; box-sizing: border-box; padding: 0.5rem;" />
            </div>
            <div class="form-group" style="margin-bottom: 1rem;">
              <label style="display:block; margin-bottom:0.25rem; font-size:0.875rem; font-weight:600; color:var(--text-secondary);">Duration</label>
              <input type="text" id="add-plan-duration" required placeholder="e.g. 1 Week, 1 Month" class="input-field" style="width: 100%; box-sizing: border-box; padding: 0.5rem;" />
            </div>
            <div class="form-group" style="margin-bottom: 1.5rem;">
              <label style="display:block; margin-bottom:0.25rem; font-size:0.875rem; font-weight:600; color:var(--text-secondary);">Notes (Optional)</label>
              <textarea id="add-plan-notes" rows="2" placeholder="Any additional notes..." class="input-field" style="width: 100%; box-sizing: border-box; padding: 0.5rem;"></textarea>
            </div>
            <div class="form-group" style="margin-bottom: 1.5rem;">
              <label style="display:flex; align-items:center; gap:0.6rem; font-size:0.875rem; font-weight:600; color:var(--text-secondary); cursor:pointer; margin:0;">
                <input type="checkbox" id="add-plan-seatpref" style="width:16px; height:16px; cursor:pointer;" />
                Seat Preference — students on this plan can pick their seat on the website map
              </label>
            </div>
            <div style="display: flex; justify-content: flex-end; gap: 0.5rem;">
              <button type="button" class="btn btn-ghost" onclick="document.getElementById('add-plan-modal').close()">Cancel</button>
              <button type="submit" class="btn btn-primary" id="btn-save-plan">Save Plan</button>
            </div>
          </form>
        </div>
      </dialog>
    `;
    document.body.appendChild(modalDiv.firstElementChild);
  }

  // 1. Enforce UI Permissions for this page
  enforcePlanUIPermissions();

  // 2. Setup the "New Plan" button (Owner only)
  const newPlanBtn = document.getElementById("btn-new-plan");
  if (newPlanBtn) {
    newPlanBtn.onclick = handleCreateManualPlan;
  }

  // 3. Ensure Default Plans exist
  await seedDefaultPlans();

  // 4. Start real-time listener for the UI
  listenToPlans();
};

/**
 * Seeds default plans if the collection is empty
 */
const seedDefaultPlans = async () => {
  try {
    const plansRef = collection(db, "membershipPlans");
    const snapshot = await getDocs(query(plansRef));
    
    if (snapshot.empty) {
      console.log("No plans found. Seeding default plans...");
      for (const plan of DEFAULT_PLANS) {
        await addDoc(plansRef, plan);
      }
    }
  } catch (error) {
    console.error("Error seeding default plans:", error);
  }
};

/**
 * Real-time listener that injects HTML into the grid
 */
const listenToPlans = () => {
  const grid = document.getElementById("membership-plans-grid");
  if (!grid) return; // Not on a page that has this element

  const plansRef = collection(db, "membershipPlans");

  onSnapshot(plansRef, (snapshot) => {
    if (snapshot.empty) {
      grid.innerHTML = `<div style="padding: 2rem; color: var(--text-muted);">No plans available.</div>`;
      return;
    }

    const showManual = canViewManualPlans();
    const canEdit = canEditPlans();
    let html = "";

    snapshot.forEach(docSnap => {
      const plan = docSnap.data();
      const id = docSnap.id;

      // Filter out manual plans if user is not Owner
      if (plan.isManual && !showManual) return;

      // Build features list
      let featuresHtml = `<div class="plan-feature">✓ ${plan.duration || 'N/A'}</div>`;
      if (plan.seatType) featuresHtml += `<div class="plan-feature">✓ ${plan.seatType} seat</div>`;
      if (plan.capacity) featuresHtml += `<div class="plan-feature">✓ Max Capacity: ${plan.capacity}</div>`;
      if (plan.seatPreference === true) featuresHtml += `<div class="plan-feature">✓ Seat selection allowed</div>`;
      if (plan.allowedStartTime) featuresHtml += `<div class="plan-feature">✓ Timings: ${plan.allowedStartTime} to ${plan.allowedEndTime}</div>`;
      if (plan.notes) featuresHtml += `<div class="plan-feature muted">${plan.notes}</div>`;

      // Build Action Buttons for Owner
      let actionsHtml = "";
      if (canEdit) {
        actionsHtml = `
          <div style="margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--border); display: flex; gap: 1rem; font-size: 0.85rem;">
            <a href="#" onclick="window.editPlan('${id}', '${plan.planName}', '${plan.price}'); return false;" style="color: var(--primary); text-decoration: none;" data-i18n="btn.edit">${window.t ? window.t("btn.edit") : "Edit"}</a>
            <a href="#" onclick="window.deletePlan('${id}', '${plan.planName}'); return false;" style="color: var(--danger); text-decoration: none;" data-i18n="btn.delete">${window.t ? window.t("btn.delete") : "Delete"}</a>
          </div>
        `;
      }

      // "Most Popular" comes from the plan itself (Featured toggle / badge in
      // Website-manager), with the legacy Rotational Seat fallback — so the
      // Membership card always matches what the website shows.
      const isPopular = plan.featured === true || plan.planName === "Rotational Seat";
      const cardClass = isPopular ? "plan-card featured" : "plan-card";
      const badgeHtml = isPopular ? `<div class="plan-badge">${plan.badge || "Popular"}</div>` : "";

      html += `
        <div class="${cardClass}">
          ${badgeHtml}
          <div class="plan-top">
            <div class="plan-name">${plan.planName} ${plan.isManual ? ' <span style="font-size:0.7em; color:var(--text-muted);">(Manual)</span>' : ''}</div>
            <div class="plan-price">₹${plan.price}<span>/${plan.duration != null ? (typeof plan.duration === 'number' ? plan.duration + ' days' : String(plan.duration).toLowerCase()) : 'custom'}</span></div>
          </div>
          <div class="plan-features">
            ${featuresHtml}
          </div>
          ${actionsHtml}
        </div>
      `;
    });

    grid.innerHTML = html;
  }, (error) => {
    console.error("Error listening to plans:", error);
    if (grid) grid.innerHTML = `<div style="color: var(--danger); padding: 1rem;">Failed to load plans.</div>`;
  });
};

/**
 * Handle Manual Plan Creation
 */
const handleCreateManualPlan = async () => {
  document.getElementById("add-plan-name").value = "";
  document.getElementById("add-plan-price").value = "";
  document.getElementById("add-plan-duration").value = "";
  document.getElementById("add-plan-notes").value = "";
  document.getElementById("add-plan-seatpref").checked = false;
  document.getElementById("add-plan-modal").showModal();
};

window.submitPlanForm = async () => {
  const name = document.getElementById("add-plan-name").value.trim();
  const price = document.getElementById("add-plan-price").value;
  const duration = document.getElementById("add-plan-duration").value.trim();
  const notes = document.getElementById("add-plan-notes").value.trim();
  const seatPreference = document.getElementById("add-plan-seatpref")?.checked === true;

  if (!name || !price || !duration) {
    window.showToast(window.t ? window.t('Please fill in all required fields.') || "Please fill in all required fields." : "Please fill in all required fields.", "warning");
    return;
  }

  const btn = document.getElementById("btn-save-plan");
  const originalText = btn.innerText;
  btn.innerText = "Saving...";
  btn.disabled = true;

  const newPlan = {
    planName: name,
    price: Number(price),
    duration: duration,
    notes: notes || "",
    seatPreference: seatPreference,
    isManual: false,
    status: "Active",
    createdAt: new Date().toISOString()
  };

  try {
    await validatePlan(newPlan);
    const plansRef = collection(db, "membershipPlans");
    await addDoc(plansRef, newPlan);
    document.getElementById("add-plan-modal").close();
    if(typeof showToast === 'function') showToast("Plan created successfully!");
  } catch (error) {
    window.showToast(window.t ? window.t('Error: ') || "Error: " : "Error: " + error.message, "error");
  } finally {
    btn.innerText = originalText;
    btn.disabled = false;
  }
};

/**
 * Global edit handler
 */
window.editPlan = async (id, currentName, currentPrice) => {
  const newPriceStr = await window.showCustomPrompt("Update Price", `Update price for ${currentName}:`, "Update");
  if (!newPriceStr) return;

  const newPrice = Number(newPriceStr);
  if (isNaN(newPrice) || newPrice <= 0) {
    window.showToast(window.t ? window.t('Invalid price.') || "Invalid price." : "Invalid price.", "error");
    return;
  }

  try {
    const docRef = doc(db, "membershipPlans", id);
    await updateDoc(docRef, {
      price: newPrice,
      updatedAt: new Date().toISOString()
    });
    window.showToast(window.t ? window.t('Plan updated successfully!') || "Plan updated successfully!" : "Plan updated successfully!", "success");
  } catch (error) {
    window.showToast(window.t ? window.t('Failed to update plan: ') || "Failed to update plan: " : "Failed to update plan: " + error.message, "error");
  }
};

/**
 * Global delete handler
 */
window.deletePlan = async (id, planName) => {
  const confirmed = await window.showCustomConfirm("Delete Plan", `Are you sure you want to delete '${planName}'?`, "Delete", true);
  if (confirmed) {
    try {
      const docRef = doc(db, "membershipPlans", id);
      await deleteDoc(docRef);
      window.showToast(window.t ? window.t('Plan deleted.') || "Plan deleted." : "Plan deleted.", "success");
    } catch (error) {
      window.showToast(window.t ? window.t('Failed to delete plan: ') || "Failed to delete plan: " : "Failed to delete plan: " + error.message, "error");
    }
  }
};
