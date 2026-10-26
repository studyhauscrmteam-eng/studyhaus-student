/**
 * First-time onboarding wizard (see docs/FLOW-AND-DATA-SPEC.md §3).
 *
 * Renders exactly one screen at a time, derived from the record itself:
 *
 *   Details -> Documents -> Plan -> Seat (only for seat-preferred plans)
 *           -> Payment  -> "Pending admin approval"
 *
 * Nothing here is stored in sessionStorage: every step persists to Firestore
 * before advancing, so closing the tab resumes at the same step instead of
 * restarting (and therefore never creates a second record).
 *
 * After the admin approves, `resolvePortalState` returns DASHBOARD and this
 * module is never rendered again.
 */
import {
  STATE, WIZARD_STEPS, detailsComplete, docsComplete, paymentComplete,
  planRequiresSeat, saveDetails, saveLibraryType, savePlan, reserveSeat, releaseSeat,
  submitPaymentAndApplication, loadStudentDocuments
} from "./onboardingService.js";
import { fetchPlansForDropdown } from "./admissionService.js";

// Official Terms & Conditions (Matches terms.html exactly)
const ONB_TERMS_RULES = {
  en: [
    { title: "1. Non-Refundable & Non-Transferable Fees", desc: "All membership fees once paid are strictly non-refundable, non-transferable, and non-extendable under any circumstances except at management's sole discretion." },
    { title: "2. Seat Allocation & Reservation", desc: "Seat bookings are subject to document verification and library management approval. Seat numbers are allocated strictly based on selected plan availability." },
    { title: "3. Strict Study Hall Silence", desc: "Absolute pin-drop silence must be maintained in the study hall at all times. Group discussions, talking, and whispering are strictly prohibited." },
    { title: "4. Outside Footwear Prohibited", desc: "Outside footwear (shoes, sandals) is strictly prohibited inside the study hall. Members must keep their designated desk clean and organized." },
    { title: "5. Mobile Phone Discipline", desc: "Mobile phones must be kept on 100% silent mode (not even vibration). Attending phone calls inside the study area is strictly prohibited; use designated areas only." },
    { title: "6. Food & Beverages Restrictions", desc: "Eating meals, snacks, or outside food inside the reading hall is prohibited. Water bottles are allowed. Refreshments are permitted only in designated areas." },
    { title: "7. Personal Belongings Responsibility", desc: "Students are solely responsible for their personal belongings (laptops, books, chargers, cash). Management accepts no responsibility for lost or unattended items." },
    { title: "8. Care for Library Property & Facilities", desc: "Handle library assets, desks, chairs, AC units, and charging sockets with care. Any damage caused will be charged to the student and may result in immediate expulsion." },
    { title: "9. Document Verification & Admission Rights", desc: "Management reserves the right to verify identity documents (Aadhaar Card) and cancel admission without refund if the code of conduct is violated." },
    { title: "10. Governing Law & Jurisdiction", desc: "These terms are governed by the laws of India. Any disputes shall be subject to the exclusive jurisdiction of the competent courts in Bhavnagar, Gujarat." }
  ],
  gu: [
    { title: "૧. બિન-રિફંડેબલ અને અ-બદલીપાત્ર ફી", desc: "એકવાર ચૂકવેલ સભ્યપદ ફી કોઈપણ સંજોગોમાં પરત (Non-refundable), ટ્રાન્સફર (Non-transferable) કે મુદત વધારી (Non-extendable) શકાશે નહીં." },
    { title: "૨. સીટ ફાળવણી અને અનામત", desc: "સીટ બુકિંગ મેનેજમેન્ટની ચકાસણી અને મંજૂરીને આધીન છે. સીટ પસંદ કરેલ પ્લાનની ઉપલબ્ધતા મુજબ જ ફાળવવામાં આવશે." },
    { title: "૩. અભ્યાસ ખંડમાં સંપૂર્ણ શાંતિ", desc: "સ્ટડી હોલમાં હંમેશા સંપૂર્ણ શાંતિ જાળવવી ફરજિયાત છે. અંદરોઅંદર વાતચીત, ચર્ચા કે ધીમેથી બોલવાની પણ સખત મનાઈ છે." },
    { title: "૪. બહારના પગરખાં પર પ્રતિબંધ", desc: "અભ્યાસ ખંડની અંદર બહારના પગરખાં (બૂટ/ચંપલ) પહેરીને પ્રવેશવાની સખત મનાઈ છે. ડેસ્ક અને લાઈબ્રેરી પરિસર સ્વચ્છ રાખવું." },
    { title: "૫. મોબાઇલ ફોન અને કોલ્સ નિયમ", desc: "મોબાઇલ ફોન ૧૦૦% સાયલન્ટ મોડ પર રાખવો (વાઇબ્રેશન પણ નહીં). હોલની અંદર ફોન ઉપાડવાની સખત મનાઈ છે; કોલ માટે નિયત લોબી/બાલ્કનીનો જ ઉપયોગ કરવો." },
    { title: "૬. ખાનપાન પર પ્રતિબંધ", desc: "અભ્યાસ ખંડમાં નાસ્તો, જમવાનું કે બહારનો ખોરાક ખાવાની સખત મનાઈ છે. માત્ર પાણીની બોટલ રાખવાની છૂટ છે. નાસ્તા માટે ટેરેસ/રીફ્રેશમેન્ટ એરિયાનો ઉપયોગ કરવો." },
    { title: "૭. વ્યક્તિગત સામાનની સુરક્ષા", desc: "પોતાના લેપટોપ, પુસ્તકો, ચાર્જર અને અંગત સામાનની સંપૂર્ણ જવાબદારી વિદ્યાર્થીની પોતાની રહેશે. ચોરી કે નુકસાન માટે મેનેજમેન્ટ જવાબદાર રહેશે નહીં." },
    { title: "૮. મિલકત અને ઇલેક્ટ્રિકલ જાળવણી", desc: "ફર્નિચર, લાઇટ, પંખા, એસી અને ચાર્જિંગ પોઇન્ટ્સનો કાળજીપૂર્વક ઉપયોગ કરવો. કોઈપણ નુકસાન બદલ દંડ થશે અને સભ્યપદ રદ થઈ શકે છે." },
    { title: "૯. દસ્તાવેજ ચકાસણી અને અધિકાર", desc: "ઓળખ કાર્ડ (આધાર કાર્ડ) ની ચકાસણી કરવાનો અને ગેરવર્તણૂક જણાયે કોઈપણ રિફંડ વિના સભ્યપદ રદ કરવાનો અંતિમ અધિકાર મેનેજમેન્ટનો રહેશે." },
    { title: "૧૦. કાયદાકીય ક્ષેત્રાધિકાર", desc: "આ નિયમો ભારતના કાયદાઓ દ્વારા સંચાલિત છે. કોઈપણ વિવાદ ભાવનગર, ગુજરાતની સક્ષમ અદાલતોના અધિકારક્ષેત્ર હેઠળ રહેશે." }
  ]
};

const esc = (v) => String(v === null || v === undefined ? "" : v)
  .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const toast = (msg, type = "info") => {
  if (window.showToast) window.showToast(msg, type);
  else alert(msg);
};

const FLD = "width:100%;padding:10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-card);color:var(--text-primary);";
const LBL = "font-size:13px;font-weight:600;display:block;margin-bottom:6px;";

const field = (id, label, control, required = false, half = true) => `
  <div class="form-group" style="margin:0;${half ? "" : "grid-column:1 / -1;"}">
    <label for="${id}" style="${LBL}">${label}${required ? ' <span style="color:#e53e3e;">*</span>' : ""}</label>
    ${control}
  </div>`;

const input = (id, type, value, attrs = "") =>
  `<input type="${type}" id="${id}" value="${esc(value)}" style="${FLD}" ${attrs} />`;

/** Progress rail shared by every wizard step. */
/** Which wizard steps are already complete — shared by the in-card rail and
 *  the sidebar rail so the two can never disagree. */
const stepDoneMap = (state, student, documents, plan) => {
  const detailsDone = detailsComplete(student);
  const docsDone = detailsDone && docsComplete(documents || {});
  const libDone = docsDone && !!student.libraryType;
  const planDone = libDone && !!student.planId;
  const seatDone = planDone && (planRequiresSeat(plan) ? !!student.seatNumber : true);
  const payDone = (planRequiresSeat(plan) ? seatDone : planDone) && paymentComplete(student);

  return {
    DETAILS: detailsDone,
    DOCUMENTS: docsDone,
    LIBRARY_TYPE: libDone,
    PLAN: planDone,
    SEAT: seatDone,
    PAYMENT: payDone
  };
};

const progressHtml = (state, student, documents, plan) => {
  const done = stepDoneMap(state, student, documents, plan);
  const active = WIZARD_STEPS.findIndex((s) => s.key === state);

  return `
    <div class="onb-progress-rail" style="display:flex;gap:.5rem;align-items:flex-start;margin-bottom:1.5rem;overflow-x:auto;padding-bottom:.25rem;-webkit-overflow-scrolling:touch;">
      ${WIZARD_STEPS.map((step, i) => {
        const isDone = done[step.key];
        const isActive = i === active;
        const skipped = step.key === STATE.SEAT && !planRequiresSeat(plan);
        const canClick = isDone || i <= active;
        const num = isDone ? "✓" : i + 1;
        const color = isActive ? "var(--primary)" : (isDone ? "var(--success, #10b981)" : "var(--text-muted)");
        const bg = isActive ? "var(--primary)" : (isDone ? "rgba(16,185,129,.15)" : "var(--bg-hover)");
        return `
          <div class="onb-step-item" id="onb-step-item-${step.key}"
               ${canClick ? `onclick="if(window.__wizardGoToStep) window.__wizardGoToStep('${step.key}')"` : ''}
               title="Step ${i + 1}: ${step.label} (${isActive ? 'Current' : isDone ? 'Completed' : 'Upcoming'})"
               style="flex:1;min-width:68px;text-align:center;opacity:${skipped ? .45 : 1};transition:all .2s ease;${canClick ? 'cursor:pointer;' : ''}">
            <div class="onb-step-circle" id="onb-step-circle-${step.key}" style="width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;
                        margin:0 auto .4rem;font-size:12.5px;font-weight:700;color:${isActive ? "#fff" : color};
                        background:${bg};border:2px solid ${isActive ? "var(--primary)" : (isDone ? "rgba(16,185,129,.4)" : "var(--border-bright)")};transition:all .2s ease;${isActive ? 'box-shadow: 0 0 0 3px rgba(152,49,50,0.18);' : ''}">
              ${num}
            </div>
            <div class="onb-step-title" style="font-size:11.5px;font-weight:${isActive ? 700 : 600};color:${isActive ? "var(--text-primary)" : "var(--text-muted)"};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${step.label}</div>
            <div class="onb-step-sub" id="onb-step-sub-${step.key}" style="font-size:10px;color:var(--text-muted);min-height:14px;">${skipped ? 'n/a' : (step.key === STATE.SEAT ? 'Pick Seat' : '')}</div>
            <div style="height:3px;border-radius:2px;margin-top:.4rem;background:${isDone || isActive ? color : "var(--border)"};"></div>
          </div>`;
      }).join("")}
    </div>`;
};

const shell = (state, student, documents, plan, body, footer) => `
  <div id="onb-wizard">
  <style>
    /* Wizard controls — premium themed selects/inputs matching the portal. */
    #onb-wizard select,
    #onb-wizard input,
    #onb-wizard textarea {
      font-family: inherit;
      font-size: 14px;
      font-weight: 500;
      border-radius: 10px;
      transition: border-color .15s ease, box-shadow .15s ease, background-color .15s ease;
    }
    #onb-wizard select {
      appearance: none;
      -webkit-appearance: none;
      -moz-appearance: none;
      padding-right: 2.6rem;
      cursor: pointer;
      font-weight: 600;
      line-height: 1.4;
      background-color: var(--bg-card);
      background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='15' height='15' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right .85rem center;
      background-size: 15px 15px;
    }
    body.light-mode #onb-wizard select {
      background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='15' height='15' viewBox='0 0 24 24' fill='none' stroke='%23475569' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
    }
    #onb-wizard select:hover,
    #onb-wizard input:hover,
    #onb-wizard textarea:hover { border-color: var(--border-bright); background-color: var(--bg-hover); }
    #onb-wizard select:focus,
    #onb-wizard input:focus,
    #onb-wizard textarea:focus {
      outline: none;
      border-color: var(--accent-emerald, var(--primary));
      background-color: var(--bg-card);
      box-shadow: 0 0 0 3px rgba(16,185,129,.18);
    }
    #onb-wizard select:invalid { color: var(--text-muted); font-weight: 500; }
    #onb-wizard select:valid { color: var(--text-primary); }
    #onb-wizard option { background: var(--bg-card); color: var(--text-primary); padding: 10px 12px; font-size: 14px; }
    #onb-wizard option:checked { background: var(--accent-emerald, var(--primary)); color: #fff; }
    #onb-wizard option:hover, #onb-wizard option:focus { background: var(--bg-hover); }
    #onb-wizard .form-group label { color: var(--text-primary); }
    #onb-wizard textarea { resize: vertical; line-height: 1.5; }

    /* Button styles for wizard navigation */
    #onb-wizard button[data-onb-back] {
      min-width: 105px;
      min-height: 44px;
      font-size: 14px;
      font-weight: 600;
      border-radius: 10px;
      border: 1.5px solid var(--border-bright);
      background: var(--bg-hover);
      color: var(--text-primary);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    #onb-wizard button[data-onb-back]:hover {
      background: var(--bg-card);
      border-color: var(--primary);
      color: var(--primary);
      transform: translateX(-2px);
    }
    #onb-wizard button[data-onb-next] {
      min-height: 44px;
      font-size: 14px;
      font-weight: 700;
      border-radius: 10px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: all 0.15s ease;
    }

    @media (max-width: 760px) {
      #onb-wizard .form-group { grid-column: 1 / -1 !important; }
    }
  </style>
  <div class="page-header" style="margin-bottom:1.25rem;">
    <div>
      <h1>${window.t ? window.t("onb.title", "Complete Your Admission") : "Complete Your Admission"}</h1>
      <p class="page-subtitle">${window.t ? window.t("onb.subtitle", { current: Math.max(1, WIZARD_STEPS.findIndex((s) => s.key === state) + 1), total: WIZARD_STEPS.length }) : `Step ${Math.max(1, WIZARD_STEPS.findIndex((s) => s.key === state) + 1)} of ${WIZARD_STEPS.length} — every field is required and your progress is saved automatically.`}</p>
    </div>
  </div>
  <div class="card" style="padding:1.75rem;border-radius:12px;background:var(--bg-card);border:1px solid var(--border);">
    ${progressHtml(state, student, documents, plan)}
    ${body}
    <div style="display:flex;gap:.75rem;margin-top:1.75rem;padding-top:1.25rem;border-top:1px solid var(--border);">
      ${footer}
    </div>
  </div>
  </div>`;

/* --------------------------------------------------------------- step bodies */
const cleanDob = (val) => {
  if (!val) return "";
  if (typeof val === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
    if (val.includes("T")) return val.split("T")[0];
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(val)) {
      const [d, m, y] = val.split("/");
      return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    const d = new Date(val);
    if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
    return val;
  }
  if (val && typeof val.toDate === "function") {
    try { return val.toDate().toISOString().split("T")[0]; } catch (_) {}
  }
  if (val && val.seconds) {
    try { return new Date(val.seconds * 1000).toISOString().split("T")[0]; } catch (_) {}
  }
  return "";
};

const detailsBody = (s) => {
  const t = window.t || ((k, def) => (typeof def === "string" ? def : k));
  const cachedName = localStorage.getItem("userName") || "";
  const validCachedName = (cachedName && !/^\d{10}$/.test(cachedName.trim()) && !cachedName.includes("@student.shreejilibrary.com"))
    ? cachedName.trim()
    : "";
  const rawName = s.name || s.fullName || s.studentName || "";
  const sName = (rawName && !/^\d{10}$/.test(rawName.trim()) && !rawName.includes("@student.shreejilibrary.com"))
    ? rawName.trim()
    : validCachedName;
  const sPhone = s.phone || s.mobile || s.contactNumber || s.loginId || "";
  const sParentPhone = s.parentPhone || s.parentMobile || "";
  // Real personal email ONLY — NEVER the internal @student.shreejilibrary.com auth alias!
  const rawEmail = s.email || s.personalEmail || "";
  const cachedEmail = localStorage.getItem("userEmail") || localStorage.getItem("studentEmail") || "";
  const validCachedEmail = (cachedEmail && !cachedEmail.endsWith("@student.shreejilibrary.com") && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cachedEmail.trim())) ? cachedEmail.trim().toLowerCase() : "";
  const sEmail = (rawEmail && !rawEmail.endsWith("@student.shreejilibrary.com"))
    ? rawEmail
    : (validCachedEmail || ((s.authEmail && !s.authEmail.endsWith("@student.shreejilibrary.com")) ? s.authEmail : ""));
  const sDob = cleanDob(s.dob);
  const sGender = s.gender || "";

  return `
  <h3 style="font-size:15px;margin:0 0 1rem;">${t("onb.personalDetails", "Personal details")}</h3>
  <div class="onb-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:1.25rem;">
    ${field("onb-name", t("onb.fullName", "Full name"), input("onb-name", "text", sName, 'required placeholder="Your full name"'), true)}
    ${field("onb-phone", t("onb.mobile", "Mobile"), input("onb-phone", "tel", sPhone, 'required pattern="[0-9]{10}" maxlength="10" placeholder="10-digit mobile"'), true)}
    ${field("onb-parent-phone", t("onb.parentPhone", "Parent mobile (optional)"), input("onb-parent-phone", "tel", sParentPhone, 'pattern="[0-9]{10}" maxlength="10" placeholder="10-digit mobile (optional)"'), false)}
    ${field("onb-email", t("onb.email", "Email"), input("onb-email", "email", sEmail, 'required placeholder="you@example.com"'), true)}
    ${field("onb-dob", t("onb.dob", "Date of birth"), input("onb-dob", "date", sDob, "required"), true)}
    ${field("onb-gender", t("onb.gender", "Gender"), `
      <select id="onb-gender" required style="${FLD}">
        <option value="">${t("onb.select", "Select")}</option>
        ${[
          { val: "Male", label: t("onb.male", "Male") },
          { val: "Female", label: t("onb.female", "Female") },
          { val: "Other", label: t("onb.other", "Other") }
        ].map((g) => `<option value="${g.val}" ${sGender === g.val ? "selected" : ""}>${g.label}</option>`).join("")}
      </select>`, true)}
    ${field("onb-college", t("onb.college", "College / Institute"), input("onb-college", "text", s.college || "", 'placeholder="Your college (optional)"'), false)}
    ${field("onb-course", t("onb.course", "Course"), input("onb-course", "text", s.course || "", 'placeholder="e.g. B.Com, NEET (optional)"'), false)}
    ${field("onb-address", t("onb.address", "Address"), `<textarea id="onb-address" rows="2" style="${FLD}" placeholder="Residential address (optional)">${esc(s.address || "")}</textarea>`, false, false)}
    ${field("onb-remarks", t("onb.remarks", "Remarks / Exam goal"), `<textarea id="onb-remarks" rows="2" style="${FLD}" placeholder="What are you preparing for? (optional)">${esc(s.remarks || "")}</textarea>`, false, false)}
  </div>`;
};

const documentsBody = (s) => {
  const t = window.t || ((k, def) => (typeof def === "string" ? def : k));
  return `
  <h3 style="font-size:15px;margin:0 0 .35rem;">${t("onb.identityDocs", "Identity documents")}</h3>
  <p style="font-size:13px;color:var(--text-muted);margin:0 0 1rem;">
    ${t("onb.identityDocsDesc", "Front and back of your Aadhaar card plus a selfie are required to verify your admission. Images are compressed before upload and stay within the free Firestore plan.")}
  </p>
  <div id="onb-docs" style="margin-bottom:.5rem;"></div>
  <p id="onb-doc-status" style="font-size:12.5px;color:var(--text-muted);margin-top:.75rem;"></p>`;
};


const libraryTypeBody = (s) => {
  const current = s.libraryType || "Shreeji Reading Library";
  const isPremium = current === "Shreeji Premium Reading Library";
  return `
    <h3 style="font-size:16px;font-weight:700;margin:0 0 .35rem;color:var(--text-primary);">Select Library Wing</h3>
    <p style="font-size:13px;color:var(--text-muted);margin:0 0 1.25rem;">
      Choose between our standard reading library on Ground Floor or our premium air-conditioned reading library on First Floor.
    </p>
    <div class="onb-lib-type-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1.25rem;margin-bottom:1.5rem;">
      <!-- Standard / Shreeji Reading Library -->
      <label id="card-lib-normal" class="lib-card" style="border:2px solid ${!isPremium ? 'var(--primary)' : 'var(--border-bright)'};border-radius:14px;padding:1.4rem;cursor:pointer;background:${!isPremium ? 'rgba(14,165,233,0.06)' : 'var(--bg-card)'};transition:all .2s ease;display:flex;flex-direction:column;position:relative;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:.75rem;">
          <div style="display:flex;align-items:center;gap:.65rem;">
            <input type="radio" name="onb-library-type" value="Shreeji Reading Library" ${!isPremium ? 'checked' : ''} style="width:18px;height:18px;accent-color:var(--primary);cursor:pointer;" />
            <h4 style="margin:0;font-size:15px;font-weight:700;color:var(--text-primary);">Shreeji Reading Library</h4>
          </div>
          <span style="font-size:11px;font-weight:700;padding:3px 9px;border-radius:999px;background:rgba(59,130,246,0.15);color:#3b82f6;border:1px solid rgba(59,130,246,0.3);">Ground Floor</span>
        </div>
        <p style="font-size:12.5px;color:var(--text-secondary);line-height:1.5;margin:0 0 1rem;flex:1;">
          Peaceful study environment with personal desk, high-speed Wi-Fi, power sockets, filtered water, and ground-floor accessibility.
        </p>
        <div style="display:flex;flex-wrap:wrap;gap:.4rem;font-size:11.5px;color:var(--text-muted);">
          <span style="padding:2px 8px;border-radius:6px;background:var(--bg-hover);">• Ground Floor</span>
          <span style="padding:2px 8px;border-radius:6px;background:var(--bg-hover);">• Fixed / Rotational</span>
          <span style="padding:2px 8px;border-radius:6px;background:var(--bg-hover);">• Seats L-1 to L-68</span>
        </div>
      </label>

      <!-- Premium / Shreeji Premium Reading Library -->
      <label id="card-lib-premium" class="lib-card" style="border:2px solid ${isPremium ? 'var(--primary)' : 'var(--border-bright)'};border-radius:14px;padding:1.4rem;cursor:pointer;background:${isPremium ? 'rgba(14,165,233,0.06)' : 'var(--bg-card)'};transition:all .2s ease;display:flex;flex-direction:column;position:relative;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:.75rem;">
          <div style="display:flex;align-items:center;gap:.65rem;">
            <input type="radio" name="onb-library-type" value="Shreeji Premium Reading Library" ${isPremium ? 'checked' : ''} style="width:18px;height:18px;accent-color:var(--primary);cursor:pointer;" />
            <h4 style="margin:0;font-size:15px;font-weight:700;color:var(--text-primary);">Shreeji Premium Reading Library</h4>
          </div>
          <span style="font-size:11px;font-weight:700;padding:3px 9px;border-radius:999px;background:rgba(245,158,11,0.18);color:#d97706;border:1px solid rgba(245,158,11,0.35);">1st Floor · Premium</span>
        </div>
        <p style="font-size:12.5px;color:var(--text-secondary);line-height:1.5;margin:0 0 1rem;flex:1;">
          Ultra-quiet air-conditioned zone, cushioned executive chairs, personal locker space, ambient lighting, and priority amenities on 1st Floor.
        </p>
        <div style="display:flex;flex-wrap:wrap;gap:.4rem;font-size:11.5px;color:var(--text-muted);">
          <span style="padding:2px 8px;border-radius:6px;background:var(--bg-hover);">• First Floor</span>
          <span style="padding:2px 8px;border-radius:6px;background:var(--bg-hover);">• Fully Air Conditioned</span>
          <span style="padding:2px 8px;border-radius:6px;background:var(--bg-hover);">• Seats P-1 to P-40</span>
        </div>
      </label>
    </div>
  `;
};

const planBody = (s, plans) => {
  const isPremium = s.libraryType === "Shreeji Premium Reading Library";
  const regularPlans = (plans || []).filter(p => {
    if (p.libraryType) return p.libraryType === "Shreeji Reading Library" || !p.libraryType.toLowerCase().includes("premium");
    const str = `${p.planName || p.name || ""} ${p.notes || ""}`.toLowerCase();
    return !str.includes("premium") && !str.includes("first floor") && !str.includes("1st floor");
  });
  const premiumPlans = (plans || []).filter(p => {
    if (p.libraryType) return p.libraryType === "Shreeji Premium Reading Library" || p.libraryType.toLowerCase().includes("premium");
    const str = `${p.planName || p.name || ""} ${p.notes || ""}`.toLowerCase();
    return str.includes("premium") || str.includes("first floor") || str.includes("1st floor");
  });

  const displayPlans = isPremium ? (premiumPlans.length ? premiumPlans : plans) : (regularPlans.length ? regularPlans : plans);

  return `
    <h3 style="font-size:16px;font-weight:700;margin:0 0 .35rem;color:var(--text-primary);">Choose your membership plan</h3>
    <p style="font-size:13px;color:var(--text-muted);margin:0 0 1.25rem;">
      Select your category below — only matching plans and available seats will be shown.
    </p>

    <!-- Category Toggle: Regular vs Premium -->
    <div style="margin-bottom:1.25rem;">
      <label style="font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);display:block;margin-bottom:8px;">
        LIBRARY CATEGORY *
      </label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem;">
        <!-- Regular Card -->
        <button type="button" id="onb-toggle-regular" class="onb-tier-btn" style="border:2px solid ${!isPremium ? 'var(--primary)' : 'var(--border-bright)'};background:${!isPremium ? 'rgba(14,165,233,0.08)' : 'var(--bg-card)'};border-radius:12px;padding:12px 14px;text-align:left;cursor:pointer;transition:all .15s ease;display:flex;flex-direction:column;gap:3px;">
          <div style="display:flex;align-items:center;justify-content:space-between;width:100%;">
            <strong style="font-size:13.5px;color:var(--text-primary);display:flex;align-items:center;gap:6px;">
              🏢 Regular Library
            </strong>
            <span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:999px;background:rgba(59,130,246,0.15);color:#3b82f6;">Ground Floor</span>
          </div>
          <div style="font-size:11.5px;color:var(--text-secondary);">Standard quiet study desk · Ground floor</div>
        </button>

        <!-- Premium Card -->
        <button type="button" id="onb-toggle-premium" class="onb-tier-btn" style="border:2px solid ${isPremium ? '#d97706' : 'var(--border-bright)'};background:${isPremium ? 'rgba(245,158,11,0.09)' : 'var(--bg-card)'};border-radius:12px;padding:12px 14px;text-align:left;cursor:pointer;transition:all .15s ease;display:flex;flex-direction:column;gap:3px;">
          <div style="display:flex;align-items:center;justify-content:space-between;width:100%;">
            <strong style="font-size:13.5px;color:${isPremium ? '#d97706' : 'var(--text-primary)'};display:flex;align-items:center;gap:6px;">
              ⭐ Premium Library
            </strong>
            <span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:999px;background:rgba(245,158,11,0.18);color:#d97706;border:1px solid rgba(245,158,11,0.35);">1st Floor · Luxury AC</span>
          </div>
          <div style="font-size:11.5px;color:var(--text-secondary);">Executive chairs, quiet AC zone & priority access</div>
        </button>
      </div>
    </div>

    <div class="onb-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:1.25rem;">
      ${field("onb-plan", "Membership plan", `
        <select id="onb-plan" required style="${FLD};min-height:46px;font-size:14.5px;font-weight:600;">
          <option value="">Choose a plan…</option>
          ${displayPlans.map((p) => `<option value="${esc(p.id)}" ${s.planId === p.id ? "selected" : ""}>${esc(p.planName || p.name)} — ₹${esc(p.price)}</option>`).join("")}
        </select>`, true)}
      ${field("onb-plan-note", "Seat Selection Status", `
        <div id="onb-plan-note" style="font-size:12.5px;color:var(--text-muted);padding-top:10px;line-height:1.4;">
          Select a plan to see seat assignment details.
        </div>`, false)}
    </div>`;
};

/** Colour key for the seat picker — without it the grid is a wall of squares. */
const seatLegend = () => `
  <div style="display:flex;flex-wrap:wrap;gap:.9rem;align-items:center;margin:0 0 .9rem;padding:.6rem .85rem;border:1px solid var(--border);border-radius:10px;background:var(--bg-hover);">
    ${[
      ["Available", "#22c55e"],
      ["Your pick", "var(--primary)"],
      ["Occupied", "#ef4444"],
      ["Reserved", "#f59e0b"],
      ["Unavailable", "#94a3b8"]
    ].map(([label, color]) => `
      <span style="display:inline-flex;align-items:center;gap:.4rem;font-size:11.5px;font-weight:600;color:var(--text-muted);">
        <span style="width:12px;height:12px;border-radius:4px;background:${color};box-shadow:0 0 0 1px rgba(0,0,0,.14);"></span>${label}
      </span>`).join("")}
  </div>`;

const seatBody = () => `
  <h3 style="font-size:15px;margin:0 0 .35rem;">Pick your seat</h3>
  <p style="font-size:13px;color:var(--text-muted);margin:0 0 1rem;">
    Only seats marked <strong>Available</strong> can be chosen. Your seat is reserved for you the moment you select it.
  </p>
  <div id="onb-seat" style="border:1px solid var(--border-bright);border-radius:12px;padding:0.75rem;min-height:220px;background:var(--bg-hover);"></div>
  <input type="hidden" id="selectedSeatNumber" />
  <input type="hidden" id="selectedSeatFloor" />
  <input type="hidden" id="selectedSeatId" />
  <p id="onb-seat-status" style="font-size:12.5px;color:var(--text-muted);margin-top:.75rem;"></p>`;

const paymentBody = (s, plan, amount) => `
  <h3 style="font-size:15px;margin:0 0 .5rem;">Select Payment Method</h3>
  <p style="font-size:13px;color:var(--text-muted);margin:0 0 1.25rem;">Choose your preferred payment method to complete admission.</p>

  <!-- Common Amount Box & Remarks Box -->
  <div class="onb-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:1.25rem;margin-bottom:1.25rem;">
    ${field("onb-pay-amount", "Payment Amount (₹)", input("onb-pay-amount", "number", plan && plan.price ? plan.price : (s.amount || ""), 'placeholder="Amount to pay" min="1" required'), true)}
    ${field("onb-pay-remarks", "Student Remarks (Optional)", input("onb-pay-remarks", "text", s.studentRemarks || s.remarks || "", 'placeholder="e.g. Paid cash at desk / special request"'), false)}
  </div>

  <div class="onb-pay-grid" style="display:grid;grid-template-columns:1fr;gap:1rem;margin-bottom:1.25rem;">
    <!-- CASH OPTION -->
    <label id="onb-pay-cash-card" style="border:2px solid var(--border-bright);border-radius:12px;padding:1.1rem;cursor:pointer;background:var(--bg-hover);transition:all .15s ease;">
      <div style="display:flex;gap:.6rem;align-items:center;margin-bottom:.5rem;">
        <input type="radio" name="onb-paymethod" id="onb-pay-cash" value="Cash" ${s.paymentMethod === "Cash" || s.paymentMethod === "Paid (Cash)" ? "checked" : ""} style="accent-color:var(--primary);width:17px;height:17px;" />
        <strong style="font-size:14.5px;color:var(--text-primary);display:flex;align-items:center;gap:6px;">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--accent-emerald, #10b981);"><rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/></svg>
          Pay with Cash
        </strong>
      </div>
      <div style="font-size:12.5px;color:var(--text-muted);margin-bottom:.65rem;line-height:1.45;">
        Settle in cash directly at the library reception desk. Staff will verify and approve your payment.
      </div>
      <div style="padding:8px 10px;border-radius:8px;background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.25);font-size:12px;color:var(--accent-emerald, #10b981);font-weight:600;">
        ✓ Direct desk payment · No transaction ID or screenshot needed
      </div>
    </label>

    <!-- UPI OPTION -->
    <label id="onb-pay-now-card" style="border:2px solid var(--border-bright);border-radius:12px;padding:1.1rem;cursor:pointer;background:var(--bg-hover);transition:all .15s ease;">
      <div style="display:flex;gap:.6rem;align-items:center;margin-bottom:.5rem;">
        <input type="radio" name="onb-paymethod" id="onb-pay-now" value="Paid" ${s.paymentMethod === "Paid" ? "checked" : ""} style="accent-color:var(--primary);width:17px;height:17px;" />
        <strong style="font-size:14.5px;color:var(--text-primary);display:flex;align-items:center;gap:6px;">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--primary);"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
          Pay Now (UPI)
        </strong>
      </div>
      <div style="font-size:12.5px;color:var(--text-muted);margin-bottom:.65rem;line-height:1.45;">Scan QR, pay the amount, then enter the UPI Reference ID &amp; attach proof.</div>
      <div id="onb-upi-fields" style="display:none;margin-top:.75rem;">
        <div style="text-align:center;margin:0.75rem 0;">
          <img src="" class="payment-qr-img" alt="Scan to pay" style="width:140px;height:140px;object-fit:contain;border:1px solid var(--border);border-radius:8px;background:#fff;padding:4px;cursor:pointer;" onclick="if(window.enlargeDocument) window.enlargeDocument(this.src, 'Payment QR Code')" />
          <div style="font-size:13px;font-weight:700;margin-top:.4rem;color:var(--text-primary);">Scan to pay <span style="color:var(--primary);">${esc(amount)}</span></div>
          <div style="display:flex;gap:.5rem;justify-content:center;margin-top:.6rem;flex-wrap:wrap;">
            <button type="button" class="btn btn-secondary btn-sm" onclick="window.downloadPaymentQr()" style="font-size:12px;padding:5px 12px;display:inline-flex;align-items:center;gap:5px;">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              Download QR Code
            </button>
            <button type="button" class="btn btn-secondary btn-sm" onclick="window.copyLibraryUpi()" style="font-size:12px;padding:5px 12px;display:inline-flex;align-items:center;gap:5px;">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              Copy UPI ID
            </button>
          </div>
        </div>
        ${field("onb-txn", "UPI Transaction ID", input("onb-txn", "text", s.transactionId || "", 'placeholder="12-digit UPI Ref / UTR number"'), true, false)}
        <div id="onb-shot-docs" style="margin-top:.75rem;"></div>
      </div>
    </label>

    <!-- PAY LATER OPTION -->
    <label id="onb-pay-later-card" style="border:2px solid var(--border-bright);border-radius:12px;padding:1.1rem;cursor:pointer;background:var(--bg-hover);transition:all .15s ease;">
      <div style="display:flex;gap:.6rem;align-items:center;margin-bottom:.5rem;">
        <input type="radio" name="onb-paymethod" id="onb-pay-later" value="Pay Later" ${(s.paymentMethod === "Pay Later" || !s.paymentMethod) && s.paymentMethod !== "Cash" && s.paymentMethod !== "Paid (Cash)" && s.paymentMethod !== "Paid" ? "checked" : ""} style="accent-color:var(--primary);width:17px;height:17px;" />
        <strong style="font-size:14.5px;color:var(--text-primary);display:flex;align-items:center;gap:6px;">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--accent-amber, #f59e0b);"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          Pay Later
        </strong>
      </div>
      <div style="font-size:12.5px;color:var(--text-muted);margin-bottom:.65rem;line-height:1.45;">Reserve now, settle at the desk before the due date.</div>
      <div id="onb-later-fields" style="display:none;margin-top:.75rem;">
        ${field("onb-due", "Pay by (date)", input("onb-due", "date", s.paymentDueDate || defaultDueDate(), `required min="${todayDate()}" max="${maxDueDate()}"`), true, false)}
      </div>
    </label>
  </div>

  <!-- TERMS & CONDITIONS COMPACT TRIGGER ROW -->
  <div style="margin-top:1.25rem;border:1px solid var(--border-bright);border-radius:12px;background:var(--bg-card);padding:1rem;">
    <div style="display:flex;align-items:flex-start;gap:10px;">
      <input type="checkbox" id="onb-terms-accept" style="margin-top:2px;width:18px;height:18px;accent-color:var(--primary);cursor:pointer;flex-shrink:0;" />
      <div style="font-size:12.5px;line-height:1.45;color:var(--text-primary);">
        <span id="onb-terms-agree-text">
          I have read and agree to the <button type="button" id="onb-open-terms-btn" style="background:none;border:none;padding:0;color:var(--primary);font-weight:700;text-decoration:underline;cursor:pointer;font-size:12.5px;">Terms &amp; Conditions</button> of Shreeji Reading Library <span style="color:#e53e3e;font-weight:700;">*</span>
        </span>
        <div id="onb-terms-subtext" style="font-size:11px;color:var(--text-muted);margin-top:3px;font-weight:500;">
          Select payment method above to unlock agreement *
        </div>
      </div>
    </div>
  </div>

  <!-- POP-UP MODAL DIALOG FOR ONBOARDING TERMS -->
  <div id="onb-terms-modal" style="display:none;position:fixed;inset:0;z-index:9999;background:rgba(15,23,42,0.75);backdrop-filter:blur(4px);align-items:center;justify-content:center;padding:16px;box-sizing:border-box;">
    <div style="background:var(--bg-card, #ffffff);color:var(--text-primary, #0f172a);width:100%;max-width:580px;max-height:85vh;border-radius:16px;box-shadow:0 20px 25px -5px rgba(0,0,0,0.25);display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--border, #cbd5e1);">
      
      <!-- Modal Header -->
      <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;background:var(--bg-hover);">
        <div style="display:flex;align-items:center;gap:8px;">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          <div>
            <div id="onb-modal-title" style="font-size:14px;font-weight:700;line-height:1.2;">Terms &amp; Conditions</div>
            <div id="onb-modal-subtitle" style="font-size:11px;color:var(--text-muted);">Shreeji Reading Library · Bhavnagar</div>
          </div>
        </div>

        <div style="display:flex;align-items:center;gap:8px;">
          <!-- Switcher -->
          <div style="display:flex;gap:2px;background:var(--bg-card);padding:2px;border-radius:6px;border:1px solid var(--border);">
            <button type="button" id="onb-terms-lang-en" style="border:none;background:var(--primary);color:#fff;font-size:11px;font-weight:700;padding:3px 8px;border-radius:4px;cursor:pointer;">ENG</button>
            <button type="button" id="onb-terms-lang-gu" style="border:none;background:transparent;color:var(--text-muted);font-size:11px;font-weight:700;padding:3px 8px;border-radius:4px;cursor:pointer;">ગુજ</button>
          </div>
          <!-- Close Button -->
          <button type="button" id="onb-modal-close-btn" aria-label="Close" style="border:none;background:var(--bg-card);color:var(--text-muted);width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
      </div>

      <!-- Compulsory scroll alert banner -->
      <div id="onb-modal-badge" style="padding:9px 16px;font-size:11.5px;font-weight:600;display:flex;align-items:center;gap:6px;background:rgba(245,158,11,0.12);color:#d97706;border-bottom:1px solid rgba(245,158,11,0.25);">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        <span id="onb-modal-badge-text">Please scroll through and review the complete terms to enable acceptance *</span>
      </div>

      <!-- Scrollable terms list (10 items matching terms.html) -->
      <div id="onb-modal-terms-box" style="flex:1;overflow-y:auto;padding:14px 18px;font-size:12px;line-height:1.6;color:var(--text-secondary);">
      </div>

      <!-- Modal Footer -->
      <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:10px;background:var(--bg-hover);">
        <button type="button" id="onb-modal-cancel-btn" style="border:1px solid var(--border);background:var(--bg-card);color:var(--text-secondary);font-size:12px;font-weight:600;padding:7px 16px;border-radius:8px;cursor:pointer;">
          Close
        </button>
        <button type="button" id="onb-modal-accept-btn" disabled style="border:none;background:var(--primary);color:#ffffff;font-size:12px;font-weight:700;padding:8px 18px;border-radius:8px;cursor:not-allowed;opacity:0.5;display:flex;align-items:center;gap:6px;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          <span id="onb-modal-accept-text">I Accept the Terms</span>
        </button>
      </div>

    </div>
  </div>
  <p id="onb-pay-status" style="font-size:12.5px;color:var(--text-muted);"></p>`;

window.downloadPaymentQr = () => {
  const img = document.querySelector("img.payment-qr-img");
  if (!img || !img.src || img.src.includes("<svg")) {
    return toast("No QR code image available to download.", "warning");
  }
  const a = document.createElement("a");
  a.href = img.src;
  a.download = "Shreeji_Library_Payment_QR.png";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  toast("Payment QR downloaded.", "success");
};

window.copyLibraryUpi = async () => {
  const upi = window.__libraryUpiId || "shreejilibrary@upi";
  try {
    await navigator.clipboard.writeText(upi);
    toast("UPI ID copied: " + upi, "success");
  } catch (_) {
    prompt("Copy UPI ID:", upi);
  }
};

function defaultDueDate() {
  const d = new Date();
  d.setDate(d.getDate() + 3);
  return d.toISOString().split("T")[0];
}

function maxDueDate() {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return d.toISOString().split("T")[0];
}

function todayDate() {
  return new Date().toISOString().split("T")[0];
}

/* ----------------------------------------------------------- terminal bodies */
const pendingBody = (s) => `
  <div style="text-align:center;padding:2rem 1rem;">
    <div style="font-size:3rem;margin-bottom:1rem;">⏳</div>
    <h3 style="margin-bottom:.75rem;color:var(--text-primary);">Submitted — pending admin approval</h3>
    <p style="color:var(--text-secondary);font-size:.95rem;max-width:520px;margin:0 auto 1.25rem;">
      Thanks${s.name ? `, ${esc(s.name)}` : ""}! Your application${s.planName ? ` for <strong>${esc(s.planName)}</strong>` : ""}
      ${s.seatNumber ? ` with seat <strong>${esc(s.seatNumber)}</strong>` : ""} has been received.
      The admin will verify your details and payment, then activate your portal.
    </p>
    <ul style="text-align:left;color:var(--text-secondary);font-size:.95rem;line-height:1.6;padding-left:1.5rem;max-width:460px;margin:0 auto 1.5rem;">
      <li>Check status here any time — this screen disappears once you are approved.</li>
      ${(s.paymentMethod === "Cash" || s.paymentMethod === "Paid (Cash)") ? `<li>Chosen <strong>Pay with Cash</strong>? Please visit the reception desk to hand over the cash payment to the administrator.</li>` : `<li>Choosing <strong>Pay Later</strong>? Please visit the desk before
        <strong>${s.paymentDueDate ? new Date(s.paymentDueDate).toLocaleDateString("en-GB") : "your due date"}</strong>.</li>`}
      <li>Need to change something? Contact the desk and the admin can reopen your application.</li>
    </ul>
    <button class="btn btn-ghost" onclick="window.location.reload()">Refresh status</button>
  </div>`;

const rejectedBody = (s) => `
  <div style="text-align:center;padding:2rem 1rem;">
    <div style="font-size:3rem;margin-bottom:1rem;">🚫</div>
    <h3 style="margin-bottom:.75rem;color:var(--text-primary);">Application not approved</h3>
    ${s.rejectReason ? `<p style="color:var(--text-secondary);max-width:520px;margin:0 auto 1rem;">Reason: <strong>${esc(s.rejectReason)}</strong></p>` : ""}
    <p style="color:var(--text-secondary);max-width:520px;margin:0 auto 1.5rem;">
      Please speak to the front desk to sort this out, then ask the admin to reopen your application.
    </p>
    <button class="btn btn-ghost" onclick="window.location.reload()">Refresh status</button>
  </div>`;

const signupBody = () => `
  <div style="text-align:center;padding:2rem 1rem;">
    <div style="font-size:3rem;margin-bottom:1rem;">👋</div>
    <h3 style="margin-bottom:.75rem;color:var(--text-primary);">Let's create your account</h3>
    <p style="color:var(--text-secondary);max-width:520px;margin:0 auto;">
      Please sign in again to continue. If you have not registered yet, use
      <strong>Sign Up</strong> on the login page with your mobile number or email.
    </p>
    <a class="btn btn-primary" href="/login.html" style="margin-top:1.25rem;">Go to sign in</a>
  </div>`;

/* ------------------------------------------------------------------ renderer */
/**
 * @param {HTMLElement} container  element to render into
 * @param {{state:string, student:Object, documents?:Object, plan?:Object,
 *          plans?:Object[], onAdvance:Function}} opts
 */
let savedNavHtml = null;

/**
 * Themed placeholder painted SYNCHRONOUSLY — before `renderOnboarding` awaits
 * anything. The finished dashboard used to sit on screen while plans loaded
 * and then swap to the wizard; this removes that flash entirely.
 */
export const showWizardLoading = (container) => {
  if (!container) return;
  container.innerHTML = `
    <div class="page-header" style="margin-bottom:1.25rem;">
      <div>
        <h1>Complete Your Admission</h1>
        <p class="page-subtitle">Opening your admission wizard…</p>
      </div>
    </div>
    <div class="card" style="padding:1.75rem;border-radius:12px;background:var(--bg-card);border:1px solid var(--border);">
      <div class="onb-skel" style="height:30px;width:64%;border-radius:999px;background:var(--bg-hover);margin-bottom:1.5rem;"></div>
      ${[0, 1, 2, 3].map(() => `
        <div class="onb-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:1.25rem;margin-bottom:1.25rem;">
          <div class="onb-skel" style="height:46px;border-radius:8px;background:var(--bg-hover);"></div>
          <div class="onb-skel" style="height:46px;border-radius:8px;background:var(--bg-hover);"></div>
        </div>`).join("")}
      <div class="onb-skel" style="height:44px;width:190px;border-radius:8px;background:var(--primary);opacity:.4;margin-top:1.5rem;"></div>
    </div>
    <style>
      @keyframes onbShimmer { 0% { opacity:.5 } 50% { opacity:1 } 100% { opacity:.5 } }
      .onb-skel { animation: onbShimmer 1.15s ease-in-out infinite; }
    </style>`;
};

/**
 * Swap the navigation for an admission step rail while the wizard is on
 * screen. Hiding every nav item left a blank sidebar slab — this keeps the
 * column purposeful and shows the student exactly where they are.
 */
export const paintWizardSidebar = (state, student, documents, plan) => {
  const nav = document.querySelector(".sidebar-nav");
  if (!nav) return;
  if (savedNavHtml === null) savedNavHtml = nav.innerHTML;
  document.getElementById("mobile-bottom-nav")?.style.setProperty("display", "none", "important");

  const done = stepDoneMap(state, student, documents, plan);
  const active = WIZARD_STEPS.findIndex((s) => s.key === state);
  const pct = Math.round(
    (WIZARD_STEPS.filter((s) => done[s.key]).length / WIZARD_STEPS.length) * 100
  );

  const t = window.t || ((k, def) => (typeof def === "string" ? def : k));
  nav.innerHTML = `
    <div class="onb-sidebar-header" style="display:flex;align-items:center;justify-content:space-between;padding:.5rem .95rem .75rem;">
      <span style="font-size:10.5px;font-weight:800;letter-spacing:.09em;color:var(--text-muted);text-transform:uppercase;">${t("onb.steps", "Admission Steps")}</span>
      <span style="font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:999px;background:rgba(152,49,50,0.12);color:var(--primary);">${active + 1} / ${WIZARD_STEPS.length}</span>
    </div>
    <div class="onb-sidebar-steps-list">
      ${WIZARD_STEPS.map((step, i) => {
        const isDone = !!done[step.key];
        const isActive = i === active;
        const canClick = isDone || i <= active;
        const ring = isActive ? "var(--primary)" : isDone ? "#10b981" : "var(--border)";
        const chip = isActive ? "#fff" : isDone ? "#10b981" : "var(--text-muted)";
        const bg = isActive ? "var(--primary)" : isDone ? "rgba(16,185,129,.14)" : "var(--bg-hover)";
        const stepLabel = t(`onb.${step.key}`, step.label);
        const subText = isActive
          ? `<span style="color:var(--primary);font-weight:600;">${t("onb.inProgress", "In progress")}</span>`
          : isDone
            ? `<span style="color:#10b981;font-weight:500;">${t("onb.completed", "✓ Completed")}</span>`
            : `<span style="color:var(--text-muted);">${step.hint || ""}</span>`;

        return `
          <div class="nav-item onb-step-nav-item ${isActive ? 'active' : ''}"
               ${canClick ? `onclick="if(window.__wizardGoToStep) window.__wizardGoToStep('${step.key}')"` : ''}
               title="Step ${i + 1}: ${stepLabel} (${isActive ? 'Current' : isDone ? 'Completed' : 'Upcoming'})"
               style="display:flex;gap:.75rem;align-items:center;padding:.65rem .85rem;margin:.2rem .5rem;border-radius:10px;
                      background:${isActive ? "var(--bg-hover)" : "transparent"};cursor:${canClick ? 'pointer' : 'default'};
                      border:1px solid ${isActive ? "rgba(152,49,50,0.22)" : "transparent"};transition:all .15s ease;">
            <div class="onb-step-circle" style="width:28px;height:28px;flex:0 0 28px;border-radius:50%;display:flex;align-items:center;justify-content:center;
                        font-size:12px;font-weight:800;color:${chip};background:${bg};border:2px solid ${ring};${isActive ? 'box-shadow:0 0 0 3px rgba(152,49,50,0.18);' : ''}">
              ${isDone ? "✓" : i + 1}
            </div>
            <div class="onb-step-text" style="min-width:0;flex:1;">
              <div style="font-size:13px;font-weight:${isActive ? 700 : 600};color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                ${stepLabel}
              </div>
              <div style="font-size:10.5px;line-height:1.2;margin-top:2px;">
                ${subText}
              </div>
            </div>
          </div>`;
      }).join("")}
    </div>
    <div class="onb-sidebar-card" style="margin:.85rem .75rem 0;padding:.8rem .9rem;border-radius:12px;background:var(--bg-hover);border:1px solid var(--border);">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <span style="font-size:11px;font-weight:700;color:var(--text-secondary);">${t("onb.steps", "Admission Steps")}</span>
        <span style="font-size:11px;font-weight:800;color:var(--primary);">${pct}%</span>
      </div>
      <div style="height:5px;border-radius:999px;background:var(--border);overflow:hidden;">
        <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,var(--primary),#10b981);border-radius:999px;transition:width .3s ease;"></div>
      </div>
      <div style="font-size:10.5px;color:var(--text-muted);margin-top:.5rem;display:flex;align-items:center;gap:5px;">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
        ${t("onb.savedAuto", "Saved automatically")}
      </div>
    </div>`;
};

/** Put the real navigation back once the student reaches the dashboard. */
export const restoreSidebar = () => {
  const nav = document.querySelector(".sidebar-nav");
  if (nav && savedNavHtml !== null) {
    nav.innerHTML = savedNavHtml;
    savedNavHtml = null;
  }
  document.getElementById("mobile-bottom-nav")?.style.removeProperty("display");
};

export const renderOnboarding = async (opts) => {
  const { container, state, student, onAdvance } = opts;
  if (!container) return;
  const documents = opts.documents || student._documents || {};
  let plans = opts.plans;
  let plan = opts.plan || null;

  if (!plans || !plans.length) {
    try { plans = await fetchPlansForDropdown(true); } catch (_) { plans = []; }
  }
  if (!plan && student.planId) plan = plans.find((p) => p.id === student.planId) || null;

  const amount = plan && plan.price != null ? `₹${plan.price}` : "—";
  const stepIdx = WIZARD_STEPS.findIndex((s) => s.key === state);

  const setBusy = (busy, label) => {
    container.querySelectorAll("button[data-onb-next], button[data-onb-back]").forEach((b) => {
      if (busy) { b.dataset._label = b.innerHTML; b.innerHTML = label || "Saving…"; b.disabled = true; }
      else { b.innerHTML = b.dataset._label || b.innerHTML; b.disabled = false; }
    });
  };

  const t = window.t || ((k, def) => (typeof def === "string" ? def : k));
  let body = "";
  let footer = "";

  switch (state) {
    case STATE.DETAILS:
      body = detailsBody(student);
      footer = `
        <button class="btn btn-primary" data-onb-next style="flex:1;">${t("onb.continue", "Continue →")}</button>`;
      break;

    case STATE.DOCUMENTS:
      body = documentsBody(student);
      footer = `
        <button class="btn btn-ghost" data-onb-back style="flex:0 0 auto;">${t("onb.back", "← Back")}</button>
        <button class="btn btn-primary" data-onb-next style="flex:1;">${t("onb.continue", "Continue →")}</button>`;
      break;

    case STATE.LIBRARY_TYPE:
      body = libraryTypeBody(student);
      footer = `
        <button class="btn btn-ghost" data-onb-back style="flex:0 0 auto;">${t("onb.back", "← Back")}</button>
        <button class="btn btn-primary" data-onb-next style="flex:1;">${t("onb.continue", "Continue →")}</button>`;
      break;

    case STATE.PLAN:
      body = planBody(student, plans);
      footer = `
        <button class="btn btn-ghost" data-onb-back style="flex:0 0 auto;">${t("onb.back", "← Back")}</button>
        <button class="btn btn-primary" data-onb-next style="flex:1;">${t("onb.continue", "Continue →")}</button>`;
      break;

    case STATE.SEAT:
      body = seatBody();
      footer = `
        <button class="btn btn-ghost" data-onb-back style="flex:0 0 auto;">${t("onb.back", "← Back")}</button>
        <button class="btn btn-primary" data-onb-next style="flex:1;">${t("onb.reserveSeat", "Reserve seat & continue →")}</button>`;
      break;

    case STATE.PAYMENT:
      body = paymentBody(student, plan, amount);
      footer = `
        <button class="btn btn-ghost" data-onb-back style="flex:0 0 auto;">${t("onb.back", "← Back")}</button>
        <button class="btn btn-primary" data-onb-next style="flex:1;">${t("onb.submitApplication", "Submit application")}</button>`;
      break;

    case STATE.PENDING:
      container.innerHTML = shell(state, student, documents, plan, pendingBody(student), "");
      return;

    case STATE.REJECTED:
      container.innerHTML = shell(state, student, documents, plan, rejectedBody(student), "");
      return;

    default:
      container.innerHTML = shell(state, student, documents, plan, signupBody(), "");
      return;
  }

  container.innerHTML = shell(state, student, documents, plan, body, footer);

  /* ------------------------------------------------ per-step initialization */
  if (state === STATE.DOCUMENTS) {
    const status = document.getElementById("onb-doc-status");
    import("./documentUploadService.js").then(({ initDocumentUploads, getSelectedDocumentFiles, uploadAdmissionDocuments }) => {
      initDocumentUploads("onb-docs", {
        keys: ["aadhaarFront", "aadhaarBack", "photo"],
        title: t("onb.identityDocs", "Identity documents"),
        note: t("onb.all3Required", "(all 3 required)"),
        existingDocs: documents || student._documents || {}
      });
      window.__onbGetFiles = getSelectedDocumentFiles;
      window.__onbUploadFiles = uploadAdmissionDocuments;
      if (status) {
        const docStore = documents || student._documents || {};
        const have = [docStore.aadhaarFront, docStore.aadhaarBack, docStore.photo || docStore.selfie].filter(Boolean).length;
        status.textContent = have === 3
          ? t("onb.allThreeOnFile", "All three documents are already on file.")
          : have > 0 ? t("onb.docCountOnFile", { have })
                     : t("onb.noneUploadedYet", "None uploaded yet — all three are required.");
      }
    }).catch((e) => { if (status) status.textContent = "Upload component unavailable: " + e.message; });
  }

  if (state === STATE.LIBRARY_TYPE) {
    const cardNorm = document.getElementById("card-lib-normal");
    const cardPrem = document.getElementById("card-lib-premium");
    const syncLibCards = () => {
      const premRadio = container.querySelector('input[name="onb-library-type"][value="Shreeji Premium Reading Library"]');
      const isPrem = premRadio && premRadio.checked;
      if (cardNorm) {
        cardNorm.style.borderColor = !isPrem ? "var(--primary)" : "var(--border-bright)";
        cardNorm.style.background = !isPrem ? "rgba(14,165,233,0.06)" : "var(--bg-card)";
      }
      if (cardPrem) {
        cardPrem.style.borderColor = isPrem ? "var(--primary)" : "var(--border-bright)";
        cardPrem.style.background = isPrem ? "rgba(14,165,233,0.06)" : "var(--bg-card)";
      }
    };
    container.querySelectorAll('input[name="onb-library-type"]').forEach(r => r.addEventListener("change", syncLibCards));
    syncLibCards();
  }

  if (state === STATE.PLAN) {
    const sel = document.getElementById("onb-plan");
    const note = document.getElementById("onb-plan-note");
    const toggleReg = document.getElementById("onb-toggle-regular");
    const togglePrem = document.getElementById("onb-toggle-premium");

    const updateSeatRail = (p) => {
      const seatRailItem = document.getElementById("onb-step-item-SEAT");
      const seatRailSub = document.getElementById("onb-step-sub-SEAT");
      const seatRailCircle = document.getElementById("onb-step-circle-SEAT");
      
      const requiresSeat = planRequiresSeat(p);
      if (seatRailItem) {
        seatRailItem.style.opacity = requiresSeat ? "1" : "0.45";
      }
      if (seatRailSub) {
        seatRailSub.innerHTML = requiresSeat
          ? `<span style="color:var(--primary);font-weight:700;">Pick Seat</span>`
          : `n/a`;
      }
      if (seatRailCircle) {
        if (requiresSeat) {
          seatRailCircle.style.borderColor = "var(--primary)";
          seatRailCircle.style.color = "var(--primary)";
        } else {
          seatRailCircle.style.borderColor = "var(--border-bright)";
          seatRailCircle.style.color = "var(--text-muted)";
        }
      }
      if (note) {
        if (!p) {
          note.innerHTML = `<span style="color:var(--text-muted);">Select a plan to view seat assignment.</span>`;
        } else if (requiresSeat) {
          note.innerHTML = `<span style="color:var(--accent-emerald, #10b981);font-weight:600;">✓ Fixed-Seat Plan:</span> You will choose your personal seat in the next step.`;
        } else {
          note.innerHTML = `<span style="color:var(--text-muted);"><span style="font-weight:600;">Assigned at desk:</span> This plan does not require reserved seat selection (shown as n/a in stepper above).</span>`;
        }
      }
    };

    const populateDropdown = (category) => {
      const isPrem = category === "premium";
      const pool = (plans || []).filter(p => {
        if (p.libraryType) {
          return isPrem
            ? (p.libraryType === "Shreeji Premium Reading Library" || p.libraryType.toLowerCase().includes("premium"))
            : (p.libraryType === "Shreeji Reading Library" || !p.libraryType.toLowerCase().includes("premium"));
        }
        const str = `${p.planName || p.name || ""} ${p.notes || ""}`.toLowerCase();
        return isPrem ? (str.includes("premium") || str.includes("first floor")) : (!str.includes("premium") && !str.includes("first floor"));
      });

      if (sel) {
        const curVal = sel.value;
        sel.innerHTML = `<option value="">Choose a plan…</option>` +
          pool.map(p => `<option value="${esc(p.id)}" ${p.id === curVal || p.id === student.planId ? "selected" : ""}>${esc(p.planName || p.name)} — ₹${esc(p.price)}</option>`).join("");
        
        if (!sel.value && pool.length > 0) {
          sel.value = pool[0].id;
        }
        const activePlan = pool.find(p => p.id === sel.value);
        updateSeatRail(activePlan);
      }
    };

    if (toggleReg && togglePrem) {
      toggleReg.onclick = async () => {
        student.libraryType = "Shreeji Reading Library";
        student.seatFloor = "Ground Floor";
        toggleReg.style.border = "2px solid var(--primary)";
        toggleReg.style.background = "rgba(14,165,233,0.08)";
        togglePrem.style.border = "2px solid var(--border-bright)";
        togglePrem.style.background = "var(--bg-card)";
        populateDropdown("regular");
        try {
          const { saveLibraryType } = await import("./onboardingService.js");
          await saveLibraryType(student.id, "Shreeji Reading Library");
        } catch (_) {}
      };

      togglePrem.onclick = async () => {
        student.libraryType = "Shreeji Premium Reading Library";
        student.seatFloor = "First Floor";
        togglePrem.style.border = "2px solid #d97706";
        togglePrem.style.background = "rgba(245,158,11,0.09)";
        toggleReg.style.border = "2px solid var(--border-bright)";
        toggleReg.style.background = "var(--bg-card)";
        populateDropdown("premium");
        try {
          const { saveLibraryType } = await import("./onboardingService.js");
          await saveLibraryType(student.id, "Shreeji Premium Reading Library");
        } catch (_) {}
      };
    }

    if (sel) {
      sel.addEventListener("change", () => {
        const p = plans.find(x => x.id === sel.value);
        updateSeatRail(p);
      });
      const initialPlan = plans.find(x => x.id === sel.value);
      updateSeatRail(initialPlan);
    }
  }

  if (state === STATE.SEAT) {
    const status = document.getElementById("onb-seat-status");
    const targetFloor = student.seatFloor || (student.libraryType === "Shreeji Premium Reading Library" ? "First Floor" : "Ground Floor");
    const prefill = () => {
      const numEl = document.getElementById("selectedSeatNumber");
      const idEl = document.getElementById("selectedSeatId");
      const flEl = document.getElementById("selectedSeatFloor");
      if (student.seatNumber) {
        if (numEl) numEl.value = student.seatNumber;
        if (idEl) idEl.value = student.seatId || student.seatNumber;
        if (flEl) flEl.value = student.seatFloor || targetFloor;
        if (status) status.innerHTML = `<span style="color:var(--accent-emerald, #10b981);font-weight:600;">Currently selected: seat ${student.seatNumber} (${student.seatFloor || targetFloor}). Tap any available seat to change it.</span>`;
        if (typeof window._signupSelectSeat === "function") {
          window._signupSelectSeat(student.seatId || student.seatNumber, student.seatNumber, true, student.seatFloor || targetFloor);
        }
      }
    };
    import("./seatMapUI.js")
      .then(({ initSeatMapUI }) => initSeatMapUI("signup", "onb-seat", { floor: targetFloor }))
      .then(prefill)
      .catch((e) => { if (status) status.textContent = "Seat map unavailable: " + e.message; });
  }

  if (state === STATE.PAYMENT) {
    import("./documentUploadService.js").then(({ initDocumentUploads, getSelectedDocumentFiles, uploadAdmissionDocuments }) => {
      // Payment proof is a SCREENSHOT file — never a live selfie, so this
      // card deliberately has no camera / Take Selfie button (file picker only).
      initDocumentUploads("onb-shot-docs", {
        keys: ["paymentScreenshot"],
        title: t("onb.paymentScreenshotRequired", "Payment Screenshot (Required)"),
        note: t("onb.paymentScreenshotRequired", "(Required · 1 screenshot proof)"),
        existingDocs: {
          paymentScreenshot: student.paymentScreenshotUrl || documents.paymentScreenshot || ""
        }
      });
      window.__onbGetFiles = getSelectedDocumentFiles;
      window.__onbUploadFiles = uploadAdmissionDocuments;
      const shotCard = document.getElementById("doc-card-paymentScreenshot");
      if (shotCard) shotCard.style.gridColumn = "1 / -1";
      if (student.paymentScreenshotUrl || documents.paymentScreenshot) {
        const st = document.getElementById("onb-pay-status");
        if (st) st.textContent = t("onb.paymentScreenshotOnFile", "A payment screenshot is already attached.");
      }
    }).catch(() => {});
    import("./qrService.js").then(({ paintQrImages }) => paintQrImages(container)).catch(() => {});

    const syncCards = () => {
      const cashRadio = document.getElementById("onb-pay-cash");
      const nowRadio = document.getElementById("onb-pay-now");
      const laterRadio = document.getElementById("onb-pay-later");

      const cashCard = document.getElementById("onb-pay-cash-card");
      const nowCard = document.getElementById("onb-pay-now-card");
      const laterCard = document.getElementById("onb-pay-later-card");

      const upiFields = document.getElementById("onb-upi-fields");
      const laterFields = document.getElementById("onb-later-fields");

      const isCash = cashRadio && cashRadio.checked;
      const isNow = nowRadio && nowRadio.checked;
      const isLater = laterRadio && laterRadio.checked;

      if (cashCard) {
        cashCard.style.borderColor = isCash ? "var(--accent-emerald, #10b981)" : "var(--border-bright)";
        cashCard.style.background = isCash ? "rgba(16,185,129,0.06)" : "var(--bg-hover)";
      }
      if (nowCard) {
        nowCard.style.borderColor = isNow ? "var(--primary)" : "var(--border-bright)";
        nowCard.style.background = isNow ? "rgba(14,165,233,0.06)" : "var(--bg-hover)";
      }
      if (laterCard) {
        laterCard.style.borderColor = isLater ? "var(--accent-amber, #f59e0b)" : "var(--border-bright)";
        laterCard.style.background = isLater ? "rgba(245,158,11,0.06)" : "var(--bg-hover)";
      }

      if (upiFields) upiFields.style.display = isNow ? "block" : "none";
      if (laterFields) laterFields.style.display = isLater ? "block" : "none";

      const due = document.getElementById("onb-due");
      if (due) due.disabled = !isLater;
      const txn = document.getElementById("onb-txn");
      if (txn) txn.disabled = !isNow;
    };
    const cRadio = document.getElementById("onb-pay-cash");
    const nRadio = document.getElementById("onb-pay-now");
    const lRadio = document.getElementById("onb-pay-later");
    if (cRadio) cRadio.addEventListener("change", syncCards);
    if (nRadio) nRadio.addEventListener("change", syncCards);
    if (lRadio) lRadio.addEventListener("change", syncCards);
    syncCards();

    /* --- Terms & Conditions Pop-up Modal Init --- */
    window.__onbTermsScrolled = false;
    let onbTermsLang = (window.currentLang === "gu" || (localStorage.getItem("systemLanguage") === "gu")) ? "gu" : "en";

    const isOnbPaymentFilled = () => {
      const cashEl = document.getElementById("onb-pay-cash");
      const nowEl = document.getElementById("onb-pay-now");
      const laterEl = document.getElementById("onb-pay-later");
      const isCash = !!(cashEl && cashEl.checked);
      const isNow = !!(nowEl && nowEl.checked);
      const isLater = !!(laterEl && laterEl.checked);
      if (!isCash && !isNow && !isLater) return false;
      if (isNow) {
        const txn = (document.getElementById("onb-txn")?.value || "").trim();
        if (!txn) return false;
      }
      if (isLater) {
        const due = (document.getElementById("onb-due")?.value || "").trim();
        if (!due) return false;
      }
      return true;
    };

    const updateOnbTermsHelper = () => {
      const sub = document.getElementById("onb-terms-subtext");
      const chk = document.getElementById("onb-terms-accept");
      if (!sub) return;
      if (chk && chk.checked) {
        sub.textContent = onbTermsLang === "gu" ? "✓ નિયમો વાંચીને સ્વીકારવામાં આવ્યા છે" : "✓ Terms reviewed and accepted";
        sub.style.color = "var(--primary)";
      } else if (isOnbPaymentFilled()) {
        sub.textContent = onbTermsLang === "gu" ? "નિયમો વાંચીને સંમતિ આપવા માટે ક્લિક કરો *" : "Please review and accept the Terms & Conditions *";
        sub.style.color = "#d97706";
      } else {
        sub.textContent = onbTermsLang === "gu" ? "નિયમો જોવા માટે ઉપર પેમેન્ટ પદ્ધતિ પસંદ કરો *" : "Select payment method above to unlock agreement *";
        sub.style.color = "var(--text-muted)";
      }
    };

    ["onb-pay-cash", "onb-pay-now", "onb-pay-later"].forEach((id) => {
      document.getElementById(id)?.addEventListener("change", updateOnbTermsHelper);
    });
    ["onb-txn", "onb-due"].forEach((id) => {
      document.getElementById(id)?.addEventListener("input", updateOnbTermsHelper);
    });

    const openOnbTermsModal = () => {
      if (!isOnbPaymentFilled()) {
        toast(onbTermsLang === "gu"
          ? "નિયમો અને શરતો જોવા માટે કૃપા કરીને પહેલા ઉપર પેમેન્ટ વિકલ્પ પસંદ કરો."
          : "Please select your payment option above before reviewing Terms & Conditions.", "warning");
        return;
      }
      const modal = document.getElementById("onb-terms-modal");
      if (modal) {
        modal.style.display = "flex";
        renderOnbTerms(onbTermsLang);
      }
    };
    window.openOnbTermsModal = openOnbTermsModal;

    const closeOnbTermsModal = () => {
      const modal = document.getElementById("onb-terms-modal");
      if (modal) modal.style.display = "none";
    };

    const renderOnbTerms = (lang) => {
      onbTermsLang = lang;
      const box = document.getElementById("onb-modal-terms-box");
      const title = document.getElementById("onb-modal-title");
      const sub = document.getElementById("onb-modal-subtitle");
      const btnEn = document.getElementById("onb-terms-lang-en");
      const btnGu = document.getElementById("onb-terms-lang-gu");
      const badgeText = document.getElementById("onb-modal-badge-text");
      const acceptText = document.getElementById("onb-modal-accept-text");
      const cancelBtn = document.getElementById("onb-modal-cancel-btn");

      if (btnEn && btnGu) {
        btnEn.style.background = lang === "en" ? "var(--primary)" : "transparent";
        btnEn.style.color = lang === "en" ? "#fff" : "var(--text-muted)";
        btnGu.style.background = lang === "gu" ? "var(--primary)" : "transparent";
        btnGu.style.color = lang === "gu" ? "#fff" : "var(--text-muted)";
      }
      if (title) {
        title.textContent = lang === "gu" ? "નિયમો અને શરતો" : "Terms & Conditions";
      }
      if (sub) {
        sub.textContent = lang === "gu" ? "શ્રીજી રીડિંગ લાઇબ્રેરી · ભાવનગર" : "Shreeji Reading Library · Bhavnagar";
      }
      if (cancelBtn) {
        cancelBtn.textContent = lang === "gu" ? "બંધ કરો" : "Close";
      }
      if (acceptText) {
        acceptText.textContent = lang === "gu" ? "હું નિયમો સ્વીકારું છું" : "I Accept the Terms";
      }

      if (badgeText && !window.__onbTermsScrolled) {
        badgeText.textContent = lang === "gu"
          ? "સંમતિ આપવા માટે કૃપા કરીને સંપૂર્ણ નિયમો નીચે સુધી વાંચો *"
          : "Please scroll through and review the complete terms to enable acceptance *";
      }
      if (box) {
        box.innerHTML = ONB_TERMS_RULES[lang].map((item) => `
          <div style="margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--border);">
            <div style="font-weight:700;color:var(--text-primary);margin-bottom:3px;font-size:12.5px;">${item.title}</div>
            <div style="color:var(--text-secondary);font-size:11.5px;line-height:1.55;">${item.desc}</div>
          </div>
        `).join("") + `
          <div style="text-align:center;font-size:11px;font-weight:600;color:var(--text-muted);padding-top:8px;">
            ${lang === "gu" ? "— તમામ નિયમો અને શરતો સમાપ્ત —" : "— End of Terms & Conditions —"}
          </div>`;
      }
      setTimeout(() => {
        if (box && box.scrollHeight <= box.clientHeight + 20) {
          unlockOnbTerms();
        }
      }, 60);
    };

    const unlockOnbTerms = () => {
      window.__onbTermsScrolled = true;
      const badge = document.getElementById("onb-modal-badge");
      const badgeText = document.getElementById("onb-modal-badge-text");
      const acceptBtn = document.getElementById("onb-modal-accept-btn");
      if (badge) {
        badge.style.background = "rgba(16,185,129,0.12)";
        badge.style.color = "#10b981";
        badge.style.borderColor = "rgba(16,185,129,0.25)";
      }
      if (badgeText) {
        badgeText.textContent = onbTermsLang === "gu"
          ? "તમે સંપૂર્ણ નિયમો વાંચી લીધા છે. હવે તમે નીચે સંમતિ આપી શકો છો."
          : "You have reviewed the complete terms. You may now accept below.";
      }
      if (acceptBtn) {
        acceptBtn.disabled = false;
        acceptBtn.style.opacity = "1";
        acceptBtn.style.cursor = "pointer";
      }
    };

    const tBox = document.getElementById("onb-modal-terms-box");
    if (tBox) {
      tBox.addEventListener("scroll", (e) => {
        const el = e.currentTarget;
        if (el.scrollHeight - el.scrollTop <= el.clientHeight + 25) {
          unlockOnbTerms();
        }
      });
    }

    document.getElementById("onb-terms-lang-en")?.addEventListener("click", () => renderOnbTerms("en"));
    document.getElementById("onb-terms-lang-gu")?.addEventListener("click", () => renderOnbTerms("gu"));
    document.getElementById("onb-modal-close-btn")?.addEventListener("click", closeOnbTermsModal);
    document.getElementById("onb-modal-cancel-btn")?.addEventListener("click", closeOnbTermsModal);
    document.getElementById("onb-open-terms-btn")?.addEventListener("click", (e) => {
      e.preventDefault();
      openOnbTermsModal();
    });

    document.getElementById("onb-modal-accept-btn")?.addEventListener("click", () => {
      window.__onbTermsScrolled = true;
      const chk = document.getElementById("onb-terms-accept");
      if (chk) chk.checked = true;
      updateOnbTermsHelper();
      closeOnbTermsModal();
    });

    document.getElementById("onb-terms-accept")?.addEventListener("click", (e) => {
      if (!isOnbPaymentFilled()) {
        e.preventDefault();
        e.target.checked = false;
        toast(onbTermsLang === "gu"
          ? "નિયમો અને શરતો જોવા માટે કૃપા કરીને પહેલા ઉપર પેમેન્ટ વિકલ્પ પસંદ કરો."
          : "Please select your payment option above before reviewing Terms & Conditions.", "warning");
        return;
      }
      if (!window.__onbTermsScrolled) {
        e.preventDefault();
        openOnbTermsModal();
      } else {
        updateOnbTermsHelper();
      }
    });
  }

  /* -------------------------------------------------------- step navigation */
  const backBtn = container.querySelector("[data-onb-back]");
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      // Walk back skipping the SEAT step when the chosen plan has no seat
      // preference — otherwise Back from PAYMENT lands on an n/a screen.
      let idx = stepIdx - 1;
      while (idx >= 0) {
        const cand = WIZARD_STEPS[idx];
        if (cand && cand.key === STATE.SEAT && !planRequiresSeat(plan)) { idx--; continue; }
        break;
      }
      const prev = idx >= 0 ? WIZARD_STEPS[idx] : null;
      if (prev) {
        backBtn.disabled = true;
        onAdvance(prev.key);
      }
    });
  }

  const nextBtn = container.querySelector("[data-onb-next]");
  if (nextBtn) nextBtn.addEventListener("click", () => runStep(state, student, plans, setBusy, onAdvance, documents));
};

/* ------------------------------------------------------------------- save */
const val = (id) => {
  const el = document.getElementById(id);
  return el ? String(el.value || "").trim() : "";
};

const runStep = async (state, student, plans, setBusy, onAdvance, documents = {}) => {
  const id = student.id;

  try {
    /* ------------------------------------------------------------- details */
    if (state === STATE.DETAILS) {
      const name = val("onb-name");
      const phone = val("onb-phone").replace(/\D/g, "");
      const dob = val("onb-dob");
      const gender = val("onb-gender");
      const college = val("onb-college");
      const course = val("onb-course");
      const address = val("onb-address");

      if (!name) return toast("Please enter your full name.", "warning");
      if (phone.length !== 10) return toast("Please enter a valid 10-digit mobile number.", "warning");
      if (!dob) return toast("Please enter your date of birth.", "warning");
      if (!gender) return toast("Please select your gender.", "warning");

      // Parent mobile is optional — only validate format if provided
      const parentPhone = val("onb-parent-phone").replace(/\D/g, "");
      if (parentPhone) {
        if (parentPhone.length !== 10) return toast("Parent mobile number must be exactly 10 digits (or leave it blank).", "warning");
        if (parentPhone === phone) return toast("Parent's mobile number must be different from your own number.", "warning");
      }

      const email = val("onb-email").trim().toLowerCase();
      if (!email) return toast("Please enter your email address.", "warning");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return toast("Please enter a valid email address.", "warning");
      const remarks = val("onb-remarks").trim();

      setBusy(true, "Saving…");
      const res = await saveDetails(id, {
        name, phone, dob, gender, college, course, address,
        parentPhone,
        email,
        remarks
      });
      setBusy(false);
      if (!res.success) return toast("Could not save: " + res.error, "error");
      Object.assign(student, {
        name, phone, dob, gender, college, course, address,
        parentPhone, email, remarks
      });
      if (name && !/^\d{10}$/.test(name.trim())) {
        localStorage.setItem("userName", name.trim());
      }
      if (email) {
        localStorage.setItem("userEmail", email.trim().toLowerCase());
      }
      const topbarNameEl = document.getElementById("topbar-user-name");
      const topbarAvatarEl = document.getElementById("topbar-user-avatar");
      const currentNameEl = document.getElementById("current-user-name");
      const currentAvatarEl = document.getElementById("current-user-avatar");
      if (topbarNameEl) topbarNameEl.textContent = name;
      if (currentNameEl) currentNameEl.textContent = name;
      const inits = name.split(" ").filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("") || "S";
      if (topbarAvatarEl && !topbarAvatarEl.querySelector("img")) topbarAvatarEl.textContent = inits;
      if (currentAvatarEl && !currentAvatarEl.querySelector("img")) currentAvatarEl.textContent = inits;
      toast("Details saved.", "success");
      return onAdvance(STATE.DOCUMENTS);
    }

    /* ---------------------------------------------------------- documents */
    if (state === STATE.DOCUMENTS) {
      const files = (window.__onbGetFiles && window.__onbGetFiles()) || {};
      const docStore = documents || student._documents || {};
      const hasFront = !!(files.aadhaarFront || docStore.aadhaarFront || docStore.aadhaarFrontUrl);
      const hasBack = !!(files.aadhaarBack || docStore.aadhaarBack || docStore.aadhaarBackUrl);
      const hasPhoto = !!(files.photo || docStore.photo || docStore.photoUrl || docStore.selfie || docStore.profilePhoto);

      if (!hasFront) return toast("Please attach the front of your Aadhaar card.", "warning");
      if (!hasBack) return toast("Please attach the back of your Aadhaar card.", "warning");
      if (!hasPhoto) return toast("Please attach a selfie / photo.", "warning");

      setBusy(true, "Uploading…");
      try {
        const filesToUpload = {};
        if (files.aadhaarFront) filesToUpload.aadhaarFront = files.aadhaarFront;
        if (files.aadhaarBack) filesToUpload.aadhaarBack = files.aadhaarBack;
        if (files.photo) filesToUpload.photo = files.photo;

        if (Object.keys(filesToUpload).length > 0 && window.__onbUploadFiles) {
          const resMap = await window.__onbUploadFiles(filesToUpload, id);
          Object.assign(docStore, resMap);
          student._documents = { ...(student._documents || {}), ...resMap };
        }
        // Persist a flag so the state machine can see completion without a
        // second round-trip (the images live in studentDocuments, not here).
        const { updateDoc, doc, serverTimestamp } = await import("firebase/firestore");
        const { db } = await import("../firebase/firebase.js");
        await updateDoc(doc(db, "students", id), {
          hasDocuments: true,
          updatedAt: serverTimestamp()
        });
        student.hasDocuments = true;
      } catch (e) {
        setBusy(false);
        return toast("Upload failed: " + (e.message || e), "error");
      }
      setBusy(false);
      toast("Documents uploaded.", "success");
      return onAdvance(STATE.LIBRARY_TYPE);
    }

    /* -------------------------------------------------------- library type */
    if (state === STATE.LIBRARY_TYPE) {
      const selectedLibEl = document.querySelector('input[name="onb-library-type"]:checked');
      const libraryType = selectedLibEl ? selectedLibEl.value : "Shreeji Reading Library";
      const isPremium = libraryType === "Shreeji Premium Reading Library";
      const floor = isPremium ? "First Floor" : "Ground Floor";

      setBusy(true, "Saving…");
      const res = await saveLibraryType(id, libraryType);
      setBusy(false);
      if (!res.success) return toast("Could not save: " + res.error, "error");

      student.libraryType = libraryType;
      student.seatFloor = floor;
      toast(`Selected: ${libraryType} (${floor}).`, "success");
      return onAdvance(STATE.PLAN);
    }

    /* --------------------------------------------------------------- plan */
    if (state === STATE.PLAN) {
      const planId = val("onb-plan");
      if (!planId) return toast("Please choose a membership plan.", "warning");
      const plan = plans.find((p) => p.id === planId);
      if (!plan) return toast("That plan could not be found. Please refresh.", "error");

      setBusy(true, "Saving…");
      const prevSeat = student.seatNumber;
      const res = await savePlan(id, plan);
      setBusy(false);
      if (!res.success) return toast("Could not save: " + res.error, "error");

      student.planId = plan.id;
      student.planName = plan.planName || plan.name;
      const isPrem = (plan.libraryType === "Shreeji Premium Reading Library") ||
        (plan.planName && plan.planName.toLowerCase().includes("premium")) ||
        (student.libraryType === "Shreeji Premium Reading Library");
      student.libraryType = isPrem ? "Shreeji Premium Reading Library" : "Shreeji Reading Library";
      student.seatFloor = isPrem ? "First Floor" : "Ground Floor";

      // Moving to a plan without seat selection releases a previously reserved seat.
      if (planRequiresSeat(plan) === false && prevSeat) await releaseSeat(prevSeat);

      toast("Plan selected.", "success");
      return onAdvance(planRequiresSeat(plan) ? STATE.SEAT : STATE.PAYMENT);
    }

    /* --------------------------------------------------------------- seat */
    if (state === STATE.SEAT) {
      const seatNumber = val("selectedSeatNumber");
      const seatFloor = val("selectedSeatFloor") || window.selectedSeatFloor || student.seatFloor || (student.libraryType === "Shreeji Premium Reading Library" ? "First Floor" : "Ground Floor");
      if (!seatNumber) return toast("Please select a seat from the map.", "warning");

      setBusy(true, "Saving seat…");
      const res = await reserveSeat(id, seatNumber, student.name || "", val("selectedSeatId"), seatFloor);
      setBusy(false);
      if (!res.success) return toast(res.error, "error");

      student.seatNumber = seatNumber;
      student.seatFloor = seatFloor;
      student.seatId = val("selectedSeatId") || seatNumber;

      toast(`Seat ${seatNumber} (${seatFloor}) selected.`, "success");
      return onAdvance(STATE.PAYMENT);
    }

    /* ------------------------------------------------------------ payment */
    if (state === STATE.PAYMENT) {
      const cashEl = document.getElementById("onb-pay-cash");
      const nowEl = document.getElementById("onb-pay-now");
      const isCash = !!(cashEl && cashEl.checked);
      const paid = !!(nowEl && nowEl.checked);
      const method = isCash ? "Cash" : (paid ? "Paid" : "Pay Later");
      const txnId = val("onb-txn");
      const dueDate = val("onb-due");
      const payAmount = val("onb-pay-amount");
      const payRemarks = val("onb-pay-remarks");

      if (!isCash && !paid) {
        if (!dueDate) return toast("Please choose the date you will pay by.", "warning");
        const today = todayDate();
        const maxDate = maxDueDate();
        if (dueDate < today) return toast("Pay by date cannot be in the past.", "warning");
        if (dueDate > maxDate) return toast("Pay by date can be at most 7 days from today.", "warning");
      }
      if (paid && !txnId) return toast("Please enter the transaction ID from your payment.", "warning");

      // Strict Terms & Conditions enforcement
      const chkTerms = document.getElementById("onb-terms-accept");
      if (!window.__onbTermsScrolled || !chkTerms || !chkTerms.checked) {
        if (typeof window.openOnbTermsModal === "function") window.openOnbTermsModal();
        return toast(
          (window.currentLang === "gu" || localStorage.getItem("systemLanguage") === "gu")
            ? "સીટ કન્ફર્મેશન માટે કૃપા કરીને નિયમો અને શરતો ધ્યાનપૂર્વક વાંચીને સ્વીકારો."
            : "Please read and accept the Terms & Conditions before confirming your seat.",
          "warning"
        );
      }

      setBusy(true, isCash ? "Submitting application…" : (paid ? "Submitting payment…" : "Submitting…"));
      let shot = "";
      try {
        if (paid) {
          const files = (window.__onbGetFiles && window.__onbGetFiles()) || {};
          const docStore = documents || student._documents || {};
          if (!files.paymentScreenshot && !student.paymentScreenshotUrl && !docStore.paymentScreenshot) {
            setBusy(false);
            return toast("Please attach a screenshot of your payment.", "warning");
          }
          if (files.paymentScreenshot && window.__onbUploadFiles) {
            const map = await window.__onbUploadFiles({ paymentScreenshot: files.paymentScreenshot }, id);
            shot = map.paymentScreenshotUrl || "";
          }
        }
        const res = await submitPaymentAndApplication(id, {
          paymentMethod: method,
          transactionId: isCash ? "CASH" : (paid ? txnId : ""),
          paymentDueDate: (!isCash && !paid) ? dueDate : "",
          paymentScreenshotUrl: shot || student.paymentScreenshotUrl || (documents && documents.paymentScreenshot) || "",
          amount: payAmount,
          remarks: payRemarks
        });
        setBusy(false);
        if (!res.success) return toast("Could not submit: " + res.error, "error");
      } catch (e) {
        setBusy(false);
        return toast("Could not submit: " + (e.message || e), "error");
      }

      toast("Application submitted — pending admin approval.", "success");
      return onAdvance(STATE.PENDING);
    }
  } catch (e) {
    setBusy(false);
    toast("Something went wrong: " + (e.message || e), "error");
  }
};

export { loadStudentDocuments };
