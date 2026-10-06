// ==================== DARK / LIGHT THEME TOGGLE ====================
function toggleTheme() {
  const isLight = document.body.classList.toggle('light-mode');
  const moon = document.getElementById('icon-moon');
  const sun = document.getElementById('icon-sun');

  if (isLight) {
    if (moon) moon.style.display = 'block';
    if (sun) sun.style.display = 'none';
  } else {
    if (moon) moon.style.display = 'none';
    if (sun) sun.style.display = 'block';
  }
  // Persist preference
  localStorage.setItem('theme', isLight ? 'light' : 'dark');
}

// Apply saved theme on load
(function applyTheme() {
  const isLight = localStorage.getItem('theme') === 'light';
  if (isLight) {
    document.body.classList.add('light-mode');
  }
  const moon = document.getElementById('icon-moon');
  const sun = document.getElementById('icon-sun');
  if (isLight) {
    if (moon) moon.style.display = 'block';
    if (sun) sun.style.display = 'none';
  } else {
    if (moon) moon.style.display = 'none';
    if (sun) sun.style.display = 'block';
  }
})();

// ==================== NAVIGATION ====================
function navigate(page) {
  // SPA Authorization check
  const role = localStorage.getItem("userRole");
  if (role === "Employee") {
    const restrictedPages = ["admissions", "documents", "expenses", "analytics", "reports", "settings", "staff", "old-students", "message-logs", "memberships"];
    if (restrictedPages.includes(page)) {
      if (typeof showToast === 'function') showToast("Access Denied: You do not have permission to view this page.", "error");
      return;
    }
  } else if (role === "Student") {
    const restrictedPages = ["admissions", "expenses", "analytics", "reports", "staff", "students", "seats", "message-logs", "memberships", "visitors", "attendance", "payments", "complaints"];
    if (restrictedPages.includes(page)) {
      if (typeof showToast === 'function') showToast("Access Denied.", "error");
      return;
    }
  }

  // Hide all pages
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  // Show target page
  const target = document.getElementById('page-' + page);
  if (target) target.classList.add('active');

  // Update sidebar active state
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.remove('active');
    if (item.getAttribute('data-page') === page) {
      item.classList.add('active');
    }
  });

  // Load dynamic data for specific pages
  if (page === 'documents' && typeof window.renderGlobalDocuments === 'function') {
    window.renderGlobalDocuments();
  }
  if (page === 'analytics' && typeof window.__renderAnalytics === 'function') {
    window.__renderAnalytics();
  }

  // On mobile, close sidebar after navigation
  if (window.innerWidth <= 768) {
    document.getElementById('sidebar').classList.remove('mobile-open');
  }
}

// ==================== SIDEBAR TOGGLE ====================
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (window.innerWidth <= 768) {
    sidebar.classList.toggle('mobile-open');
  } else {
    sidebar.classList.toggle('collapsed');
  }
}

// ==================== FILTER TABS ====================
document.querySelectorAll('.filter-tab').forEach(tab => {
  tab.addEventListener('click', function () {
    const group = this.closest('.filter-tabs');
    group.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
    this.classList.add('active');
  });
});

// ==================== SEAT CLICK ====================
document.querySelectorAll('.seat').forEach(seat => {
  seat.addEventListener('click', function () {
    const title = this.getAttribute('title') || 'Seat info';
    const parts = title.split(' - ');
    const seatId = parts[0];
    const info = parts[1] || 'No info';
    showToast(`${seatId}: ${info}`, 'info');
  });
});

// ==================== TOAST NOTIFICATION ====================
function showToast(message, type = 'success') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  toast.textContent = message;

  if (typeof toast.showPopover === 'function') {
    toast.setAttribute('popover', 'manual');
  }

  document.body.appendChild(toast);

  if (typeof toast.showPopover === 'function') {
    toast.showPopover();
  }

  // Animate in
  setTimeout(() => toast.classList.add('toast-visible'), 10);
  // Auto-dismiss
  setTimeout(() => {
    toast.classList.remove('toast-visible');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// Toast styles injected dynamically
const toastStyles = document.createElement('style');
toastStyles.textContent = `
  .toast {
    position: fixed; top: auto; left: auto; bottom: 1.5rem; right: 1.5rem; z-index: 99999;
    padding: 0.75rem 1.25rem; border-radius: 10px; border: none;
    font-size: 13.5px; font-weight: 600; color: #fff;
    box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    transform: translateY(20px); opacity: 0; margin: 0;
    transition: all 0.25s cubic-bezier(0.4,0,0.2,1);
    max-width: 320px;
  }

  .toast-visible { transform: translateY(0); opacity: 1; }
  .toast-success { background: #10b981; }
  .toast-info    { background: #3b82f6; }
  .toast-warning { background: #f59e0b; }
  .toast-error   { background: #f43f5e; }
`;
document.head.appendChild(toastStyles);

// Override native alert with custom toast
window.alert = function (msg) {
  let type = 'info';
  const lowerMsg = String(msg).toLowerCase();

  if (lowerMsg.includes('error') || lowerMsg.includes('fail') || lowerMsg.includes('invalid') || lowerMsg.includes('denied')) {
    type = 'error';
  } else if (lowerMsg.includes('success') || lowerMsg.includes('saved') || lowerMsg.includes('updated') || lowerMsg.includes('approved') || lowerMsg.includes('admitted')) {
    type = 'success';
  } else if (lowerMsg.includes('warning') || lowerMsg.includes('required') || lowerMsg.includes('missing') || lowerMsg.includes('please')) {
    type = 'warning';
  }

  window.showToast(msg, type);
};

// ==================== CUSTOM MODALS ====================
if (!document.getElementById('modal-styles')) {
  const modalStyles = document.createElement('style');
  modalStyles.id = 'modal-styles';
  modalStyles.textContent = `
    @keyframes smoothPopup {
      from { opacity: 0; transform: scale(0.95) translateY(-10px); }
      to { opacity: 1; transform: scale(1) translateY(0); }
    }
    .smooth-modal {
      animation: smoothPopup 0.25s cubic-bezier(0.4, 0, 0.2, 1) forwards;
    }
    .smooth-modal::backdrop {
      background: rgba(0,0,0,0.4);
      backdrop-filter: blur(4px);
      animation: fadeIn 0.25s ease-out forwards;
    }
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
  `;
  document.head.appendChild(modalStyles);
}

window.showCustomConfirm = (title, message, confirmText = "Confirm", isDanger = false) => {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "card smooth-modal";
    dialog.style.cssText = "border:none; border-radius:12px; padding:0; box-shadow:0 10px 30px rgba(0,0,0,0.5); background: var(--bg-card, #fff); color: var(--text-primary, #0f172a); max-width: 400px; margin: auto;";
    dialog.innerHTML = `
      <div style="padding: 1.5rem; text-align: center;">
        <h3 style="margin-bottom: 0.5rem; font-size: 1.25rem;">${title}</h3>
        <p style="color: var(--text-secondary, #475569); margin-bottom: 1.5rem; font-size: 0.95rem;">${message}</p>
        <div style="display: flex; gap: 1rem; justify-content: center;">
          <button class="btn btn-ghost" id="confirm-cancel" style="flex: 1; border: 1px solid var(--border, #e2e8f0); border-radius: 999px;">Cancel</button>
          <button class="btn btn-primary" id="confirm-ok" style="flex: 1; border: none; border-radius: 999px; color: #fff; ${isDanger ? 'background: #f43f5e;' : 'background: #0f172a;'}">${confirmText}</button>
        </div>
      </div>
    `;
    document.body.appendChild(dialog);
    dialog.showModal();
    dialog.querySelector("#confirm-cancel").onclick = () => { dialog.close(); dialog.remove(); resolve(false); };
    dialog.querySelector("#confirm-ok").onclick = () => { dialog.close(); dialog.remove(); resolve(true); };
  });
};

window.showCustomPrompt = (title, message, confirmText = "Submit", isDanger = false, defaultValue = "") => {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "card smooth-modal";
    dialog.style.cssText = "border:none; border-radius:12px; padding:0; box-shadow:0 10px 30px rgba(0,0,0,0.5); background: var(--bg-card, #fff); color: var(--text-primary, #0f172a); max-width: 400px; margin: auto;";
    dialog.innerHTML = `
      <div style="padding: 1.5rem;">
        <h3 style="margin-bottom: 0.5rem; font-size: 1.25rem; text-align: center;">${title}</h3>
        <p style="color: var(--text-secondary, #475569); margin-bottom: 1rem; font-size: 0.95rem; text-align: center;">${message}</p>
        <div class="form-group" style="margin-bottom: 1.5rem;">
          <input type="text" id="prompt-input" value="${defaultValue}" class="input-field" style="width: 100%; box-sizing: border-box; padding: 0.5rem; border:1px solid var(--border, #e2e8f0); border-radius:6px;" autofocus />
        </div>
        <div style="display: flex; gap: 1rem; justify-content: center;">
          <button class="btn btn-ghost" id="prompt-cancel" style="flex: 1; border: 1px solid var(--border, #e2e8f0); border-radius: 999px;">Cancel</button>
          <button class="btn btn-primary" id="prompt-ok" style="flex: 1; border: none; border-radius: 999px; color: #fff; ${isDanger ? 'background: #f43f5e;' : 'background: #0f172a;'}">${confirmText}</button>
        </div>
      </div>
    `;
    document.body.appendChild(dialog);
    dialog.showModal();
    dialog.querySelector("#prompt-cancel").onclick = () => { dialog.close(); dialog.remove(); resolve(null); };
    dialog.querySelector("#prompt-ok").onclick = () => {
      const val = dialog.querySelector("#prompt-input").value;
      dialog.close(); dialog.remove(); resolve(val);
    };
  });
};

// ==================== TASK CHECKBOXES ====================
document.querySelectorAll('.task-item input[type=checkbox]').forEach(cb => {
  cb.addEventListener('change', function () {
    const info = this.closest('.task-item').querySelector('.task-info');
    const badge = this.closest('.task-item').querySelector('.badge');
    if (this.checked) {
      info.classList.add('done');
      if (badge) {
        badge.className = 'badge badge-paid';
        badge.textContent = 'Done';
      }
      showToast('Task marked as complete ✓', 'success');
    } else {
      info.classList.remove('done');
      if (badge) {
        badge.className = 'badge badge-pending';
        badge.textContent = 'Open';
      }
    }
  });
});

// ==================== FORM INPUTS ====================
document.querySelectorAll('.form-group input, .form-group select, .form-group textarea').forEach(el => {
  el.addEventListener('focus', function () {
    this.closest('.form-group')?.querySelector('label')?.style.setProperty('color', '#10b981');
  });
  el.addEventListener('blur', function () {
    this.closest('.form-group')?.querySelector('label')?.style.removeProperty('color');
  });
});

// ==================== ADMISSION FORM STEPS ====================
const nextBtn = document.querySelector('.admission-form-card .btn-primary');
let currentStep = 1;
if (nextBtn) {
  nextBtn.addEventListener('click', function () {
    if (currentStep < 4) {
      currentStep++;
      updateStepper(currentStep);
      if (currentStep === 4) {
        this.textContent = 'Submit Admission';
        this.style.background = '#8b5cf6';
      }
    } else {
      showToast('Admission submitted successfully.', 'success');
      currentStep = 1;
      updateStepper(1);
      nextBtn.textContent = 'Next: Plan Selection →';
      nextBtn.style.background = '';
    }
  });
}

function updateStepper(step) {
  document.querySelectorAll('.step').forEach((s, i) => {
    s.classList.toggle('active', i < step);
  });
  const labels = ['Next: Plan Selection →', 'Next: Seat Assignment →', 'Next: Initial Payment →', 'Submit Admission'];
  if (nextBtn && step <= 4) {
    nextBtn.textContent = labels[step - 1];
  }
}

// ==================== SETTINGS SAVE ====================
const saveBtn = document.querySelector('#page-settings .btn-primary');
if (saveBtn) {
  saveBtn.addEventListener('click', () => showToast('Settings saved successfully!', 'success'));
}

// ==================== COLLECT PAYMENT BUTTONS ====================
document.querySelectorAll('.btn-xs').forEach(btn => {
  btn.addEventListener('click', function (e) {
    if (this.hasAttribute('onclick') || this.id) return;
    e.stopPropagation();
    const text = this.textContent.trim();
    if (text === 'Collect') showToast('Payment collected successfully!', 'success');
    else if (text === 'Receipt') showToast('Receipt downloaded!', 'info');
    else if (text === 'Download') showToast('Document downloaded!', 'info');
    else if (text === 'Generate PDF') showToast('Generating report…', 'info');
  });
});

// ==================== PRIMARY BUTTONS ====================
document.querySelectorAll('.btn-primary').forEach(btn => {
  if (!btn.closest('.admission-form-card') && btn.id !== 'save-settings') {
    btn.addEventListener('click', function (e) {
      if (this.hasAttribute('onclick') || this.id) return;
      const text = this.textContent.trim();
      if (text.includes('New admission') || text.includes('Add Student')) {
        navigate('admissions');
      } else if (text.includes('New Plan') || text.includes('Log') || text.includes('Add') || text.includes('Upload') || text.includes('Mark')) {
        showToast('Feature panel opening soon…', 'info');
      }
    });
  }
});

// ==================== KEYBOARD SHORTCUTS ====================
document.addEventListener('keydown', function (e) {
  if (e.key === '/' && !e.ctrlKey && !e.metaKey) {
    const search = document.querySelector('.topbar-search input');
    if (document.activeElement !== search) {
      e.preventDefault();
      search?.focus();
    }
  }
  if (e.key === 'Escape') {
    const search = document.querySelector('.topbar-search input');
    search?.blur();
    document.getElementById('lang-dropdown')?.classList.remove('open');
    if (window.innerWidth <= 768) {
      document.getElementById('sidebar').classList.remove('mobile-open');
    }
  }
});

// ==================== ANIMATE BARS ON ANALYTICS PAGE ====================
function animateBars() {
  const bars = document.querySelectorAll('#page-analytics .bar');
  bars.forEach((bar, i) => {
    bar.style.height = '0%';
    setTimeout(() => {
      bar.style.height = bar.style.getPropertyValue('--h') || getComputedStyle(bar).getPropertyValue('--h');
    }, i * 100 + 100);
  });
}

// Observe when analytics page becomes active
const analyticsPage = document.getElementById('page-analytics');
const observer = new MutationObserver((mutations) => {
  mutations.forEach(m => {
    if (m.target.classList.contains('active')) animateBars();
  });
});
if (analyticsPage) observer.observe(analyticsPage, { attributes: true, attributeFilter: ['class'] });



// ==================== NOTIFICATION READ ====================
document.querySelectorAll('.notif-item.unread').forEach(item => {
  item.addEventListener('click', function () {
    this.classList.remove('unread');
    const dot = this.querySelector('.dot-unread');
    if (dot) dot.remove();
    // Update badge count
    const unread = document.querySelectorAll('.notif-item.unread').length;
    const badge = document.querySelector('.nav-badge');
    if (badge) badge.textContent = unread || '';
    if (!unread && badge) badge.style.display = 'none';
  });
});

// ==================== DOCUMENTS (upload / list / download) ====================
// Loads the document service directly if firebase-entry.js hasn't exposed it
// (e.g. that module failed to evaluate for an unrelated reason).
const ensureDocService = async () => {
  if (typeof window.uploadGlobalDocument === 'function' &&
      typeof window.loadGlobalDocuments === 'function' &&
      typeof window.downloadBase64File === 'function') return true;
  try {
    const mod = await import('./services/documentUploadService.js');
    window.uploadGlobalDocument = mod.uploadGlobalDocument;
    window.loadGlobalDocuments = mod.loadGlobalDocuments;
    window.downloadBase64File = mod.downloadBase64File;
    return true;
  } catch (e) {
    console.error('Could not load document service:', e);
    return false;
  }
};

window.uploadGenericDocument = async (input) => {
  if (input.files && input.files.length > 0) {
    const file = input.files[0];
    if (typeof showToast === 'function') showToast(`Uploading ${file.name}...`, 'info');
    try {
      if (!(await ensureDocService())) {
        throw new Error("Document service could not be loaded.");
      }
      await window.uploadGlobalDocument(file, file.name, "Generic Document");
      if (typeof showToast === 'function') showToast('Document uploaded successfully!', 'success');
      input.value = ''; // reset
      if (typeof window.renderGlobalDocuments === 'function') {
        window.renderGlobalDocuments();
      }
    } catch (e) {
      console.error("Upload error:", e);
      if (typeof showToast === 'function') showToast(`Upload failed: ${e.message}`, 'error');
    }
  }
};

window.renderGlobalDocuments = async () => {
  const container = document.getElementById("document-list-container");
  if (!container) return;

  if (!document.getElementById("doc-spinner-style")) {
    const st = document.createElement("style");
    st.id = "doc-spinner-style";
    st.textContent = `@keyframes doc-spin { to { transform: rotate(360deg); } }
      #document-list-container .doc-spinner { width:28px; height:28px; border-radius:50%;
        border:3px solid rgba(128,128,128,.25); border-top-color: var(--primary, #8b5cf6);
        animation: doc-spin .8s linear infinite; }`;
    document.head.appendChild(st);
  }

  container.innerHTML = `<div style="text-align:center;padding:2rem;"><div class="doc-spinner" style="margin:0 auto;"></div><p style="margin-top:.75rem;color:var(--text-secondary);">Loading documents...</p></div>`;
  try {
    if (!(await ensureDocService())) {
      throw new Error("Document service could not be loaded.");
    }
    const docs = await window.loadGlobalDocuments();
    if (docs.length === 0) {
      container.innerHTML = `<div style="text-align:center;padding:3rem 1rem;border:1px dashed var(--border);border-radius:12px;background:var(--bg-card);">
        <div style="font-size:2rem;opacity:0.5;margin-bottom:1rem;">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        </div>
        <p style="color:var(--text-secondary);">No documents uploaded yet</p>
        <p style="color:var(--text-muted);font-size:13px;margin-top:.35rem;">Use the <strong>+ Upload</strong> button above to add one.</p>
      </div>`;
      return;
    }

    let html = `<div style="display:grid;gap:1rem;">`;
    window.__globalDocs = docs;
    const escapeHtml = (str) => String(str ?? '').replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
    docs.forEach((doc, index) => {
      const uploadedAt = doc.uploadedAt ? new Date(doc.uploadedAt) : null;
      const date = uploadedAt && !isNaN(uploadedAt) ? uploadedAt.toLocaleString() : 'Unknown date';
      const fileType = doc.fileType || '';
      let iconSvg = fileType.includes("image")
        ? `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>`
        : `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
      const title = escapeHtml(doc.title || doc.fileName || 'Untitled');
      const fileName = escapeHtml(doc.fileName || doc.title || 'document');
      html += `
      <div class="data-card" style="display:flex;align-items:center;padding:1rem;gap:1rem;background:var(--bg-card);border:1px solid var(--border);border-radius:12px;">
        <div style="background:var(--bg-hover);border-radius:8px;padding:10px;display:flex;align-items:center;justify-content:center;color:var(--primary);">${iconSvg}</div>
        <div style="flex:1;min-width:0;">
          <h4 style="margin:0;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${title}</h4>
          <p style="margin:4px 0 0;font-size:12px;color:var(--text-muted);">${date}</p>
        </div>
        <button type="button" onclick="window.__downloadDoc(${index})" class="btn btn-secondary" style="white-space:nowrap;display:inline-flex;align-items:center;gap:6px;border:none;cursor:pointer;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download
        </button>
      </div>
    `;
    });
    html += `</div>`;
    container.innerHTML = html;
  } catch (e) {
    console.error(e);
    container.innerHTML = `<p style="color:#ef4444;text-align:center;">Failed to load documents. ${escapeErr(e)}</p>`;
  }
};

const escapeErr = (e) => {
  const msg = (e && e.message) ? e.message : String(e);
  return /permission/i.test(msg)
    ? 'You do not have permission to view these documents.'
    : 'Please check your connection and try again.';
};

window.__downloadDoc = async (index) => {
  const d = (window.__globalDocs || [])[index];
  if (!d) {
    if (typeof showToast === 'function') showToast('Document not found.', 'error');
    return;
  }
  if (!d.base64Data) {
    if (typeof showToast === 'function') showToast('This document\'s data could not be loaded. It may still be syncing.', 'error');
    return;
  }
  if (typeof window.downloadBase64File !== 'function') {
    const ok = await ensureDocService();
    if (!ok) {
      if (typeof showToast === 'function') showToast('Downloader could not be loaded. Please refresh the page.', 'error');
      return;
    }
  }
  window.downloadBase64File(d.base64Data || '', d.fileName || d.title || 'document');
};


// ==================== LANGUAGE DROPDOWN (custom menu) ====================
function toggleLangMenu(e) {
  if (e) e.stopPropagation();
  document.getElementById('lang-dropdown')?.classList.toggle('open');
}

function syncLangUI() {
  const lang = (localStorage.getItem('appLanguage') || 'en').toLowerCase();
  const label = document.getElementById('lang-current');
  if (label) label.textContent = lang === 'gu' ? 'GU' : 'EN';
  document.querySelectorAll('.lang-item').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-lang') === lang);
  });
}

async function selectLanguage(lang) {
  try {
    const prefix = window.location.pathname.match(/\/(admin|employee|manager|student)\//) ? '../' : './';
    const m = await import(prefix + 'services/translationService.js');
    await m.setLanguage(lang);
  } catch (err) {
    console.error('Language switch failed:', err);
  }
  syncLangUI();
  document.getElementById('lang-dropdown')?.classList.remove('open');
}

document.addEventListener('click', (e) => {
  if (!e.target.closest?.('.lang-dropdown')) {
    document.getElementById('lang-dropdown')?.classList.remove('open');
  }
});

// ==================== COLLAPSED SIDEBAR TOOLTIPS ====================
// Copies each nav item's text label into data-tip so the icon-only
// (collapsed) sidebar shows a hover tooltip. Re-synced on language change.
function syncNavTips() {
  document.querySelectorAll('.nav-item[data-page]').forEach(item => {
    const label = item.querySelector('span:not(.nav-badge)');
    const text = label ? label.textContent.trim() : '';
    if (text) item.setAttribute('data-tip', text);
    else item.removeAttribute('data-tip');
  });
}

window.addEventListener('languageChanged', syncLangUI);
window.addEventListener('languageChanged', syncNavTips);

document.addEventListener('DOMContentLoaded', () => {
  const defaultPage = document.body.getAttribute('data-default-page') || 'dashboard';
  navigate(defaultPage);
  syncLangUI();
  syncNavTips();
  // Stagger metric cards animation
  document.querySelectorAll('.metric-card').forEach((card, i) => {
    card.style.opacity = '0';
    card.style.transform = 'translateY(12px)';
    setTimeout(() => {
      card.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
      card.style.opacity = '1';
      card.style.transform = 'translateY(0)';
    }, i * 60);
  });


});
