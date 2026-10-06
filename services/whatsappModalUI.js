import { fetchAllTemplates, seedInitialTemplates } from "./messageTemplateService.js";
import { sendWhatsAppMessage, replacePlaceholders } from "./whatsappService.js";

// Ensure templates are seeded
seedInitialTemplates();

let templates = [];
let modalInjected = false;

export const openWhatsAppModal = async (studentData) => {
  if (!modalInjected) injectModal();
  
  if (templates.length === 0) {
    templates = await fetchAllTemplates();
  }

  const role = localStorage.getItem("userRole");
  const canCustom = (role === "Owner/Admin" || role === "Manager");

  const modal = document.getElementById("wa-modal");
  const tplSelect = document.getElementById("wa-template");
  const msgPreview = document.getElementById("wa-preview");
  const sendBtn = document.getElementById("wa-send-btn");
  
  // Populate dropdown
  let html = `<option value="">-- Select a Template --</option>`;
  templates.forEach(t => {
    html += `<option value="${t.id}">${t.name}</option>`;
  });
  if (canCustom) {
    html += `<option value="custom">-- Custom Message --</option>`;
  }
  tplSelect.innerHTML = html;
  
  tplSelect.onchange = () => {
    const val = tplSelect.value;
    if (!val) {
      msgPreview.value = "";
      msgPreview.readOnly = true;
      return;
    }
    if (val === "custom") {
      msgPreview.value = "";
      msgPreview.readOnly = false;
      msgPreview.placeholder = "Type your custom message here...";
    } else {
      const t = templates.find(x => x.id === val);
      if (t) {
        msgPreview.value = replacePlaceholders(t.message, studentData);
        msgPreview.readOnly = true;
      }
    }
  };

  sendBtn.onclick = async () => {
    const val = tplSelect.value;
    if (!val) return window.showToast("Select a template.", "warning");
    
    let templateName = "Custom";
    if (val !== "custom") {
      const t = templates.find(x => x.id === val);
      templateName = t ? t.name : "Template";
    }

    const finalMessage = msgPreview.value.trim();
    if (!finalMessage) return window.showToast("Message cannot be empty.", "warning");

    // The send service automatically logs and opens new tab
    const success = await sendWhatsAppMessage(studentData, templateName, finalMessage);
    if (success) {
      closeWhatsAppModal();
    }
  };

  modal.style.display = "flex";
};

export const closeWhatsAppModal = () => {
  const modal = document.getElementById("wa-modal");
  if (modal) modal.style.display = "none";
};

const injectModal = () => {
  if (document.getElementById("wa-modal")) return;
  
  const modalHtml = `
    <div id="wa-modal" class="modal-overlay" style="display:none; z-index:1000; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); justify-content:center; align-items:center;">
      <div class="modal-content" style="background:var(--bg-card); border-radius:8px; width:400px; padding:2rem;">
        <h2>Send WhatsApp Message</h2>
        <div style="margin-top:1rem;">
          <label style="display:block; margin-bottom:0.5rem; font-size:0.875rem;">Select Template</label>
          <select id="wa-template" class="input-field" style="width:100%;"></select>
        </div>
        <div style="margin-top:1rem;">
          <label style="display:block; margin-bottom:0.5rem; font-size:0.875rem;">Message Preview</label>
          <textarea id="wa-preview" class="input-field" style="width:100%; height:120px; resize:none;" readonly></textarea>
        </div>
        <div style="margin-top:1.5rem; display:flex; gap:1rem; justify-content:flex-end;">
          <button class="btn btn-secondary" onclick="document.getElementById('wa-modal').style.display='none'">Cancel</button>
          <button class="btn btn-primary" id="wa-send-btn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M22 2L11 13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            Send WhatsApp
          </button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', modalHtml);
  modalInjected = true;
};

// Global Exposure for inline onclick hooks
window.openWhatsAppModal = openWhatsAppModal;
window.sendWhatsAppMessage = sendWhatsAppMessage;
