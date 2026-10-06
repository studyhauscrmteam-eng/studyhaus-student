import { listenToAllSeats, assignSeat, unassignSeat, changeSeatStatus, seedInitialSeats, reconcileSeatOccupancy, cleanupNonPlanSeats, saveSeatPosition, renameSeat, addSeatAt, deleteSeatById } from "./seatService.js?v=play3";
import { getDocs, collection, query, where } from "firebase/firestore";
import { db } from "../firebase/firebase.js";

let allSeats = [];
let unsubscribe = null;
let currentFilters = { status: "All", search: "", floor: "Ground Floor" };
// Students holding seat names that don't exist on the library plan — their
// seat can never appear on the map. Surfaced under the subtitle (see
// updateSeatAnalysis) instead of failing silently.
let seatHealthOrphans = [];
// Playground: admin "Edit layout" mode — drag/rename/add/delete seats.
let layoutEditMode = false;
let dragSeatId = null;

// ── Seat naming helpers ─────────────────────────────────────────────────────
// The physical room layouts below are hardcoded for seats named A1..A68
// (Ground Floor) and B1..B40 (First Floor). Imported floors may use other
// naming schemes (e.g. "2".."40" or "R1".."R20") — those must fall back to
// the generic responsive grid so every real seat is still rendered.
const AB_SEAT_PATTERN = /^[AB]\d+$/;

// Numeric-aware ordering so seats sort naturally:
//   2, 3, ..., 10, ..., 40  and  R1, R2, ..., R5, ..., R9, R10, ..., R20
// (localeCompare with numeric:true avoids R10 sorting before R9).
const compareSeatNumbers = (a, b) =>
  String(a == null ? "" : a).localeCompare(String(b == null ? "" : b), undefined, {
    numeric: true,
    sensitivity: "base",
  });

// Rule 1 — normalize seat names before matching (DB "A01" vs layout "A1")
const normalizeSeatNumber = (value) => {
  const raw = String(value == null ? "" : value).trim().toUpperCase().replace(/\s+/g, "");
  const m = raw.match(/^([A-Z]+)-?0*(\d+)$/);
  return m ? `${m[1]}${Number(m[2])}` : raw;
};

const findSeatByLayoutName = (floorSeats, seatNumStr) => {
  const target = normalizeSeatNumber(seatNumStr);
  return floorSeats.find(s => normalizeSeatNumber(s.seatNumber) === target) || null;
};

// Theme-aware seat palette — app default is dark, light via body.light-mode.
// Light values match the spec table exactly; dark uses translucent fills.
const isLightTheme = () => !!(document.body && document.body.classList.contains("light-mode"));

const seatPalette = (status) => {
  if (isLightTheme()) {
    if (status === "Available") return { bg: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534" };
    if (status === "Occupied") return { bg: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b" };
    if (status === "Reserved") return { bg: "#fffbeb", border: "1px solid #fde68a", color: "#92400e" };
    if (status === "Maintenance") return { bg: "#eff6ff", border: "1px solid #bfdbfe", color: "#1e40af" };
    return { bg: "var(--bg-hover)", border: "1px dashed var(--border-bright)", color: "var(--text-muted)" };
  }
  if (status === "Available") return { bg: "rgba(34,197,94,0.14)", border: "1px solid rgba(34,197,94,0.45)", color: "#4ade80" };
  if (status === "Occupied") return { bg: "rgba(239,68,68,0.14)", border: "1px solid rgba(239,68,68,0.45)", color: "#f87171" };
  if (status === "Reserved") return { bg: "rgba(245,158,11,0.16)", border: "1px solid rgba(245,158,11,0.45)", color: "#fbbf24" };
  if (status === "Maintenance") return { bg: "rgba(59,130,246,0.16)", border: "1px solid rgba(59,130,246,0.5)", color: "#60a5fa" };
  return { bg: "var(--bg-hover)", border: "1px dashed var(--border-bright)", color: "var(--text-muted)" };
};

// True when this floor's seats are A/B-named, i.e. the hardcoded room layout
// can be painted. An empty floor keeps the existing (placeholder) layout so
// current behaviour is unchanged when no seats exist yet; any floor with seats
// that are not ALL A/B-named renders the generic grid instead.
const shouldUseABLayout = (seats) => {
  if (!Array.isArray(seats) || seats.length === 0) return true;
  const firstIsAB = AB_SEAT_PATTERN.test(String(seats[0] && seats[0].seatNumber));
  if (!firstIsAB) return false;
  return seats.every(s => AB_SEAT_PATTERN.test(String(s && s.seatNumber)));
};

// Unsubscribe for the signup/check-in picker's live seat listener — this init
// runs on every Check-In modal open, so the previous listener must be dropped.
let signupSeatsUnsub = null;

export const initSeatMapUI = async (mode, containerId, opts = {}) => {
  // ── SIGNUP / SELF-ADMISSION MODE ─────────────────────────────────────────
  if (mode === "signup" && containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    // "checkin" context: the student is choosing where to SIT NOW, so both
    // green (Available) and amber (Reserved but empty) seats are pickable.
    const isCheckinContext = !!opts && opts.context === "checkin";

    container.innerHTML = `
      <div style="padding: 0.5rem 0 0.75rem;">
        <!-- Floor tabs -->
        <div style="display:inline-flex; gap:0.5rem; background:var(--bg-hover); padding:4px; border-radius:999px; margin-bottom:1rem;">
          <button id="signup-tab-ground" onclick="window._signupSwitchFloor('Ground Floor')"
            style="border:none; background:var(--bg-card); color:var(--text-primary); padding:5px 14px; border-radius:999px; font-weight:500; font-size:12px; cursor:pointer; box-shadow:0 1px 2px rgba(0,0,0,0.05);">
            Ground Floor
          </button>
          <button id="signup-tab-first" onclick="window._signupSwitchFloor('First Floor')"
            style="border:none; background:transparent; color:var(--text-secondary); padding:5px 14px; border-radius:999px; font-weight:500; font-size:12px; cursor:pointer;">
            First Floor
          </button>
        </div>
        <!-- Legend -->
        <div style="display:flex; gap:0.75rem; margin-bottom:0.75rem; flex-wrap:wrap;">
          <span style="background:#f0fdf4; color:#166534; border:1px solid #bbf7d0; padding:3px 10px; border-radius:999px; font-size:12px; font-weight:500;">● Available</span>
          <span style="background:#fef2f2; color:#991b1b; border:1px solid #fecaca; padding:3px 10px; border-radius:999px; font-size:12px; font-weight:500;">● Occupied</span>
          <span style="background:#fffbeb; color:#92400e; border:1px solid #fde68a; padding:3px 10px; border-radius:999px; font-size:12px; font-weight:500;">${isCheckinContext ? "● Reserved — pickable" : "● Reserved"}</span>
          <span style="background:var(--primary); color:#fff; border:1px solid var(--primary); padding:3px 10px; border-radius:999px; font-size:12px; font-weight:600;">✓ Selected</span>
        </div>
        <!-- Seat grid -->
        <div id="signup-seat-grid" style="display:grid; grid-template-columns:repeat(auto-fill, minmax(70px,1fr)); gap:0.6rem; max-height:min(450px, 44vh); overflow-y:auto; padding-right:4px;"></div>
        <div id="signup-selected-label" style="margin-top:0.6rem; font-size:13px; color:var(--text-secondary); min-height:20px;"></div>
      </div>
    `;

    let signupAllSeats = [];
    let signupCurrentFloor = "Ground Floor";
    let signupSelectedId = null;

    const renderSignupSeats = () => {
      const grid = document.getElementById("signup-seat-grid");
      if (!grid) return;

      const floorSeats = signupAllSeats.filter(s => (s.floor || "Ground Floor") === signupCurrentFloor);

      if (floorSeats.length === 0) {
        grid.style.display = "block";
        grid.innerHTML = `<div style="text-align:center;padding:1.5rem;color:var(--text-muted);font-size:13px;">No seats on this floor yet.</div>`;
        return;
      }

      const generateRange = (prefix, start, end) => {
        const arr = [];
        if (start <= end) {
          for (let i = start; i <= end; i++) arr.push(`${prefix}${i}`);
        } else {
          for (let i = start; i >= end; i--) arr.push(`${prefix}${i}`);
        }
        return arr;
      };

      const renderSignupSeatCard = (seatNumStr) => {
        let seat = findSeatByLayoutName(floorSeats, seatNumStr);
        
        if (!seat) {
          return `
            <div style="background:var(--bg-hover); border:1px dashed var(--border-bright); border-radius: 8px; height: 46px; display: flex; align-items: center; justify-content: center; color:var(--text-muted); font-size: 13px; cursor: not-allowed; opacity: 0.55; width: 100%;" title="Seat not available">
              ${seatNumStr}
            </div>
          `;
        }

        const isSelected = seat.id === signupSelectedId;
        const isPickable = isCheckinContext ? (seat.status === "Available" || seat.status === "Reserved") : seat.status === "Available";

        const __pal = seatPalette(seat.status);
        let bg = __pal.bg, border = __pal.border, color = __pal.color, cursor = "not-allowed", opacity = "0.55";
        if (isPickable)   { cursor = "pointer"; opacity = "1"; }

        if (isSelected) { bg = "var(--primary)"; border = "2px solid var(--primary)"; color = "#fff"; cursor = "pointer"; opacity = "1"; }

        return `
          <div
            onclick="window._signupSelectSeat('${seat.id}', '${seat.seatNumber}', ${isPickable})"
            title="${seat.status}${!isPickable ? ' – not selectable' : ''}"
            style="background:${bg}; border:${border}; color:${color}; opacity:${opacity};
                   border-radius:8px; height:46px; display:flex; align-items:center;
                   justify-content:center; cursor:${cursor}; transition:box-shadow 0.15s, border-color 0.15s;
                   font-size:13px; font-weight:600; width: 100%;"
            onmouseover="if(${isPickable}) { this.style.boxShadow='0 0 0 2px currentColor'; }"
            onmouseout="this.style.boxShadow='none';"
          >
            ${isSelected ? "✓ " : ""}${seat.seatNumber}
          </div>
        `;
      };

      const renderSignupCustomColHtml = (arr) => {
        let colHtml = `<div style="display: flex; flex-direction: column; gap: 0.5rem; flex: 1;">`;
        arr.forEach(num => { 
          if(num === null) {
            colHtml += `<div style="height: 46px; width: 100%;"></div>`;
          } else {
            colHtml += renderSignupSeatCard(num); 
          }
        });
        colHtml += `</div>`;
        return colHtml;
      };

      const groundCol1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18].map(n => 'A' + n);
      const groundCol2 = [null, 34, 33, 32, 31, 30, 29, 28, 27, 26, 25, 24, 67, 23, 22, 21, 20, 19].map(n => n ? 'A' + n : null);
      const groundCol3 = [null, 35, 36, null, 37, 38, 39, 40, 41, 42, null, 43, 68, 44, 45, 46, 47, 48].map(n => n ? 'A' + n : null);
      const groundCol4 = [66, 65, 64, 63, 62, 61, 60, 59, 58, 57, 56, 55, 54, 53, 52, 51, 50, 49].map(n => 'A' + n);

      const firstCol1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, null].map(n => n ? 'B' + n : null);
      const firstCol2 = [null, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11].map(n => n ? 'B' + n : null);
      const firstCol3 = [null, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30].map(n => n ? 'B' + n : null);
      const firstCol4 = [40, 39, 38, 37, 36, 35, 34, 33, 32, 31, null].map(n => n ? 'B' + n : null);

      // Generic responsive grid — every seat of this floor, natural order,
      // existing status colors and the existing "pickable" (Available only)
      // logic. Used for non-A/B floors and as the fallback for custom floors.
      const paintSignupGenericGrid = () => {
        grid.style.display = "grid";
        grid.style.gridTemplateColumns = "repeat(auto-fill, minmax(70px,1fr))";
        grid.style.gap = "0.6rem";

        const sortedSeats = [...floorSeats].sort((a, b) =>
          compareSeatNumbers(a.seatNumber, b.seatNumber));

        let fallbackHtml = sortedSeats.map(seat => {
          const isSelected = seat.id === signupSelectedId;
          const isPickable = isCheckinContext ? (seat.status === "Available" || seat.status === "Reserved") : seat.status === "Available";

          const __pal = seatPalette(seat.status);
          let bg = __pal.bg, border = __pal.border, color = __pal.color, cursor = "not-allowed", opacity = "0.55";
          if (isPickable)   { cursor = "pointer"; opacity = "1"; }

          if (isSelected) { bg = "var(--primary)"; border = "2px solid var(--primary)"; color = "#fff"; cursor = "pointer"; opacity = "1"; }

          return `
            <div
              onclick="window._signupSelectSeat('${seat.id}', '${seat.seatNumber}', ${isPickable})"
              title="${seat.status}${!isPickable ? ' – not selectable' : ''}"
              style="background:${bg}; border:${border}; color:${color}; opacity:${opacity};
                     border-radius:8px; height:46px; display:flex; align-items:center;
                     justify-content:center; cursor:${cursor}; transition:box-shadow 0.15s, border-color 0.15s;
                     font-size:13px; font-weight:600;"
              onmouseover="if(${isPickable}) { this.style.boxShadow='0 0 0 2px currentColor'; }"
              onmouseout="this.style.boxShadow='none';"
            >
              ${isSelected ? "✓ " : ""}${seat.seatNumber}
            </div>
          `;
        }).join("");

        grid.innerHTML = fallbackHtml;
      };

      // Seats not named A*/B* (e.g. Ground Floor "2".."40", First Floor
      // "R1".."R20") don't fit the hardcoded room layout — paint them all in
      // the generic grid instead.
      if (!shouldUseABLayout(floorSeats)) {
        paintSignupGenericGrid();
        return;
      }

      let html = "";
      if (signupCurrentFloor === "First Floor") {
        html = `
          <div style="background:var(--bg-card); padding: 2rem 1rem 4rem 1rem; border-radius: 12px; position: relative; border:1px solid var(--border); margin-bottom: 1rem; overflow-x: auto;">
            <!-- Door -->
            <div style="position: absolute; top: 0; left: 50%; transform: translateX(-50%); background:var(--bg-hover); border:1px solid var(--border); border-top: none; padding: 0.25rem 1.5rem; border-radius: 0 0 8px 8px; font-weight: 700; color:var(--text-secondary); letter-spacing: 1px; font-size: 11px;">
              DOOR
            </div>
            
            <div style="display: flex; gap: 0.75rem; justify-content: center; min-width: max-content; width: 100%;">
              ${renderSignupCustomColHtml(firstCol1)}
              ${renderSignupCustomColHtml(firstCol2)}
              ${renderSignupCustomColHtml(firstCol3)}
              ${renderSignupCustomColHtml(firstCol4)}
            </div>

            <!-- Toilets -->
            <div style="position: absolute; bottom: 0; left: 0; right: 0; display: flex; justify-content: space-around; pointer-events: none;">
              <div style="background:var(--bg-hover); border:1px solid var(--border); border-bottom: none; padding: 0.25rem 1.5rem; border-radius: 8px 8px 0 0; font-weight: 700; color:var(--text-secondary); letter-spacing: 1px; font-size: 11px;">
                TOILET-1
              </div>
              <div style="background:var(--bg-hover); border:1px solid var(--border); border-bottom: none; padding: 0.25rem 1.5rem; border-radius: 8px 8px 0 0; font-weight: 700; color:var(--text-secondary); letter-spacing: 1px; font-size: 11px;">
                TOILET-2
              </div>
            </div>
          </div>
        `;
      } else if (signupCurrentFloor === "Ground Floor") {
        html = `
          <div style="background:var(--bg-card); padding: 2rem 1rem 4rem 1rem; border-radius: 12px; position: relative; border:1px solid var(--border); overflow-x: auto;">
            <!-- Door -->
            <div style="position: absolute; top: 0; left: 50%; transform: translateX(-50%); background:var(--bg-hover); border:1px solid var(--border); border-top: none; padding: 0.25rem 1.5rem; border-radius: 0 0 8px 8px; font-weight: 700; color:var(--text-secondary); letter-spacing: 1px; font-size: 11px;">
              DOOR
            </div>
            
            <div style="display: flex; gap: 0.75rem; justify-content: center; min-width: max-content; width: 100%; align-items: flex-start;">
              ${renderSignupCustomColHtml(groundCol1)}
              ${renderSignupCustomColHtml(groundCol2)}
              ${renderSignupCustomColHtml(groundCol3)}
              ${renderSignupCustomColHtml(groundCol4)}
            </div>

            <!-- Toilets -->
            <div style="position: absolute; bottom: 0; left: 0; right: 0; display: flex; justify-content: space-around; pointer-events: none;">
              <div style="background:var(--bg-hover); border:1px solid var(--border); border-bottom: none; padding: 0.25rem 1.5rem; border-radius: 8px 8px 0 0; font-weight: 700; color:var(--text-secondary); letter-spacing: 1px; font-size: 11px;">
                TOILET-1
              </div>
              <div style="background:var(--bg-hover); border:1px solid var(--border); border-bottom: none; padding: 0.25rem 1.5rem; border-radius: 8px 8px 0 0; font-weight: 700; color:var(--text-secondary); letter-spacing: 1px; font-size: 11px;">
                TOILET-2
              </div>
            </div>
          </div>
        `;
      } else {
        // Fallback for any other custom floor (already non-A/B checked above).
        paintSignupGenericGrid();
        return;
      }

      grid.style.display = "block";
      grid.innerHTML = html;
    };

    window._signupSwitchFloor = (floor) => {
      signupCurrentFloor = floor;
      const gBtn = document.getElementById("signup-tab-ground");
      const fBtn = document.getElementById("signup-tab-first");
      if (gBtn && fBtn) {
        if (floor === "Ground Floor") {
          gBtn.style.background = "var(--bg-card)"; gBtn.style.color = "var(--text-primary)"; gBtn.style.boxShadow = "0 1px 2px rgba(0,0,0,0.05)";
          fBtn.style.background = "transparent"; fBtn.style.color = "var(--text-secondary)"; fBtn.style.boxShadow = "none";
        } else {
          fBtn.style.background = "var(--bg-card)"; fBtn.style.color = "var(--text-primary)"; fBtn.style.boxShadow = "0 1px 2px rgba(0,0,0,0.05)";
          gBtn.style.background = "transparent"; gBtn.style.color = "var(--text-secondary)"; gBtn.style.boxShadow = "none";
        }
      }
      renderSignupSeats();
    };

    window._signupSelectSeat = (seatId, seatNumber, isPickable) => {
      if (!isPickable) {
        window.showToast && window.showToast(
        isCheckinContext
          ? "This seat can't be taken right now. Choose a free seat — green (Available) or amber (Reserved)."
          : "This seat is not available. Please choose a green (Available) seat.",
        "warning");
        return;
      }
      signupSelectedId = seatId;
      const numInput = document.getElementById("selectedSeatNumber");
      const idInput  = document.getElementById("selectedSeatId");
      if (numInput) numInput.value = seatNumber;
      if (idInput)  idInput.value  = seatId;
      const label = document.getElementById("signup-selected-label");
      if (label) label.innerHTML = `<span style="color:#166534; font-weight:600;">✓ Seat ${seatNumber} selected</span>`;
      renderSignupSeats();
    };

    // Listen for live seat updates — unsubscribe the previous picker's
    // listener first (this init runs on every Check-In modal open).
    if (signupSeatsUnsub) { try { signupSeatsUnsub(); } catch (_) {} }
    signupSeatsUnsub = listenToAllSeats((records) => {
      signupAllSeats = records;
      renderSignupSeats();
    });

    // Re-paint seat colors when night/day theme toggles
    if (window.__seatThemeObserver) window.__seatThemeObserver.disconnect();
    window.__seatThemeObserver = new MutationObserver(() => renderSignupSeats());
    window.__seatThemeObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });

    return; // ── end signup mode ───────────────────────────────────────────
  }

  // ── NORMAL ADMIN / SEAT MAP PAGE MODE ────────────────────────────────────
  const container = document.getElementById("page-seats");
  if (!container) return; 

  const role = localStorage.getItem("userRole");
  if (role === "Student") return; // Security guard

  // Drop old non-plan seats ("2","3","4"… / R-names / dupes) so the map shows
  // only the A/B library plan. No-ops once the data is clean.
  // Silent background maintenance — never toast on page load; the user did
  // nothing to deserve a popup. Details go to the console.
  try {
    const clean = await cleanupNonPlanSeats();
    const changed = clean && clean.success ? ((clean.deleted || 0) + (clean.renamed || 0) + (clean.created || 0) + (clean.positioned || 0) + (clean.clearedStudents || 0) + (clean.fixedStudents || 0)) : 0;
    if (changed > 0) {
      console.info(`[seats] auto-cleanup: ${clean.deleted || 0} removed (${clean.deduped || 0} duplicates), ${clean.created || 0} created, ${clean.renamed || 0} renamed.`);
    }
  } catch (e) { console.warn("Seat cleanup skipped:", e); }

  // Seed seats if empty (now a single fast batch)
  await seedInitialSeats();

  // Self-heal occupancy mismatches (ghost Occupied / unmarked claims) so
  // the counts can never disagree with the map. Silent unless it fixed
  // something — then one toast says what changed.
  try {
    const fixed = await reconcileSeatOccupancy();
    seatHealthOrphans = (fixed && fixed.orphans) || [];
    if (fixed && (fixed.released + fixed.claimed) > 0) {
      const bits = [];
      if (fixed.released) bits.push(`${fixed.released} ghost seat${fixed.released > 1 ? "s" : ""} freed`);
      if (fixed.claimed) bits.push(`${fixed.claimed} seat${fixed.claimed > 1 ? "s" : ""} marked occupied`);
      console.info(`[seats] reconcile: ${bits.join(", ")}.`);
      if (typeof window.showToast === "function") {
        window.showToast(`Seat map corrected: ${bits.join(", ")}.`, "info");
      }
    }
    updateSeatAnalysis(allSeats);
  } catch (e) { console.warn("Seat reconcile skipped:", e); }

  // Initial UI Setup
  container.innerHTML = `
    <!-- Seat Action Modal -->
    <div id="seat-action-modal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:50; align-items:center; justify-content:center;">
      <div class="card" style="background:var(--bg-card, #fff); padding:2rem; border-radius:12px; width:100%; max-width:400px; box-shadow:0 10px 15px -3px rgba(0,0,0,0.1);">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.5rem;">
          <h3 id="seat-modal-title" style="font-size:18px; font-weight:600; color:var(--text-primary, #0f172a);">Seat Action</h3>
          <button id="btn-close-seat-modal" style="background:transparent; border:none; font-size:18px; cursor:pointer;">&times;</button>
        </div>
        
        <div id="seat-modal-options" style="display:flex; flex-direction:column; gap:0.75rem;">
          <!-- Action buttons injected here -->
        </div>

        <div id="seat-modal-assign-form" style="display:none; flex-direction:column; gap:1rem;">
          <p style="font-size:13px; color:var(--text-secondary, #475569);">Enter Name, Email, or Student ID to assign:</p>
          <input type="text" id="seat-assign-input" placeholder="Search student..." style="width:100%; padding:8px 12px; border:1px solid var(--border, #e2e8f0); border-radius:6px;">
          <div style="display:flex; justify-content:flex-end; gap:0.75rem; margin-top:0.5rem;">
            <button id="btn-cancel-assign" class="btn btn-ghost" style="padding:8px 16px; border:1px solid var(--border, #e2e8f0); border-radius:999px; background:transparent;">Cancel</button>
            <button id="btn-confirm-assign" class="btn btn-primary" style="padding:8px 16px; border:none; border-radius:999px; background:var(--primary); color:#fff;">Assign</button>
          </div>
        </div>
      </div>
    </div>

    <div class="page-header" style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--border); padding-bottom: 1rem; margin-bottom: 1.5rem;">
      <h2 style="margin:0; font-size: 18px; font-weight: 600; color:var(--text-primary);">Seat Map</h2>
      <div style="display: flex; gap: 0.75rem;">
        <button class="btn btn-ghost" id="btn-edit-layout" style="background:var(--bg-card); color:var(--text-primary); border:1px solid var(--border); border-radius: 999px; padding: 6px 16px;">✎ Edit layout</button>
      </div>
    </div>
    
    <div id="seatmap-view-existing">
      <div style="margin-bottom: 1rem;"><p class="page-subtitle" id="seat-subtitle">Loading...</p></div>
      <style>
        #seatmap-view-existing .legend-pill { padding:4px 12px; border-radius:999px; font-size:13px; font-weight:500; display:inline-flex; align-items:center; gap:6px; border:1px solid transparent; }
        #seatmap-view-existing .legend-av { background:#f0fdf4; color:#166534; border-color:#bbf7d0; }
        #seatmap-view-existing .legend-oc { background:#fef2f2; color:#991b1b; border-color:#fecaca; }
        #seatmap-view-existing .legend-rs { background:#fffbeb; color:#92400e; border-color:#fde68a; }
        #seatmap-view-existing .legend-mt { background:#eff6ff; color:#1e40af; border-color:#bfdbfe; }
        body:not(.light-mode) #seatmap-view-existing .legend-av { background:rgba(34,197,94,0.14); color:#4ade80; border-color:rgba(34,197,94,0.45); }
        body:not(.light-mode) #seatmap-view-existing .legend-oc { background:rgba(239,68,68,0.14); color:#f87171; border-color:rgba(239,68,68,0.45); }
        body:not(.light-mode) #seatmap-view-existing .legend-rs { background:rgba(245,158,11,0.16); color:#fbbf24; border-color:rgba(245,158,11,0.45); }
        body:not(.light-mode) #seatmap-view-existing .legend-mt { background:rgba(59,130,246,0.16); color:#60a5fa; border-color:rgba(59,130,246,0.5); }
      </style>
      <!-- Seat Legend -->
      <div class="seat-legend" style="display:flex; gap:1rem; margin-bottom:1.5rem;">
        <span class="legend-pill legend-av"><span style="width:8px; height:8px; border-radius:50%; background:currentColor;"></span><span data-i18n="status.available">Available</span></span>
        <span class="legend-pill legend-oc"><span style="width:8px; height:8px; border-radius:50%; background:currentColor;"></span><span data-i18n="status.occupied">Occupied</span></span>
        <span class="legend-pill legend-rs"><span style="width:8px; height:8px; border-radius:50%; background:currentColor;"></span><span data-i18n="status.reserved">Reserved</span></span>
        <span class="legend-pill legend-mt"><span style="width:8px; height:8px; border-radius:50%; background:currentColor;"></span><span data-i18n="status.maintenance">Maintenance</span></span>
      </div>

      <!-- Filters: name/seat search + status only -->
      <div class="seat-filterbar" style="display:flex; gap:0.5rem; margin-bottom:1rem; flex-wrap:wrap; align-items:center;">
        <input id="seat-filter-search" placeholder="Search name or seat…" class="input-field"
          style="flex:1; min-width:180px; padding:8px 14px; border:1px solid var(--border); border-radius:999px; background:var(--bg-card); color:var(--text-primary); font-size:13px;" />
        <select id="seat-filter-status" class="input-field"
          style="padding:8px 14px; border:1px solid var(--border); border-radius:999px; background:var(--bg-card); color:var(--text-primary); font-size:13px; cursor:pointer;">
          <option value="All">All statuses</option>
          <option value="Available">Available</option>
          <option value="Reserved">Reserved</option>
          <option value="Occupied">Occupied</option>
          <option value="Maintenance">Maintenance</option>
          <option value="Inactive">Inactive</option>
        </select>
        <button id="seat-filter-clear" style="padding:8px 16px; border:1px solid var(--border); border-radius:999px; background:transparent; color:var(--text-secondary); font-size:13px; cursor:pointer;">Clear</button>
        <span id="seat-filter-count" style="font-size:12px; color:var(--text-muted);"></span>
      </div>

      <!-- Floor Tabs -->
      <div class="floor-tabs" style="display:inline-flex; gap:0.5rem; background:var(--bg-hover); padding:4px; border-radius:999px; margin-bottom:1.5rem;">
        <button class="floor-tab active" data-floor="Ground Floor" style="border:none; background:var(--bg-card); color:var(--text-primary); padding:6px 16px; border-radius:999px; font-weight:500; font-size:13px; cursor:pointer; box-shadow:0 1px 2px rgba(0,0,0,0.05);" data-i18n="floor.ground">Ground Floor</button>
        <button class="floor-tab" data-floor="First Floor" style="border:none; background:transparent; color:var(--text-secondary); padding:6px 16px; border-radius:999px; font-weight:500; font-size:13px; cursor:pointer;" data-i18n="floor.first">First Floor</button>
      </div>

      <!-- Main Floor Card -->
      <div class="card" style="background:var(--bg-card); border:1px solid var(--border); border-radius:12px; padding:1.5rem; margin-bottom:2rem;">
        <h3 style="font-size:15px; font-weight:600; color:var(--text-primary); margin-bottom:4px;" id="current-floor-title" data-i18n="floor.ground">Ground Floor</h3>
        <p style="font-size:13px; color:var(--text-muted); margin-bottom:1.5rem;">Section A · Section B · click a seat to manage it</p>
        
        <div id="seat-grid">
          <div style="text-align:center; padding:2rem; color:var(--text-muted);">Loading live seat map...</div>
        </div>
      </div>
    </div>
  `;

  // View Tab Listeners — removed: Live Seat Map lives in the sidebar only.

  // Floor Tab Listeners
  document.querySelectorAll(".floor-tab").forEach(btn => {
    btn.addEventListener("click", (e) => {
      document.querySelectorAll(".floor-tab").forEach(b => {
        b.style.background = 'transparent';
        b.style.color = "var(--text-secondary)";
        b.style.boxShadow = 'none';
      });
      const target = e.target;
      target.style.background = "var(--bg-card)";
      target.style.color = "var(--text-primary)";
      target.style.boxShadow = '0 1px 2px rgba(0,0,0,0.05)';
      
      currentFilters.floor = target.getAttribute("data-floor");
      document.getElementById("current-floor-title").innerText = currentFilters.floor;
      renderSeatMap();
    });
  });

  // ── Inline filters: name/seat search + status (live, no modal) ───────────
  const seatSearchInput = document.getElementById("seat-filter-search");
  const seatStatusSelect = document.getElementById("seat-filter-status");
  const seatClearBtn = document.getElementById("seat-filter-clear");
  if (seatSearchInput) {
    seatSearchInput.value = currentFilters.search;
    seatSearchInput.addEventListener("input", () => {
      currentFilters.search = seatSearchInput.value.trim();
      renderSeatMap();
    });
  }
  if (seatStatusSelect) {
    seatStatusSelect.value = currentFilters.status;
    seatStatusSelect.addEventListener("change", () => {
      currentFilters.status = seatStatusSelect.value;
      renderSeatMap();
    });
  }
  if (seatClearBtn) {
    seatClearBtn.addEventListener("click", () => {
      currentFilters.search = "";
      currentFilters.status = "All";
      if (seatSearchInput) seatSearchInput.value = "";
      if (seatStatusSelect) seatStatusSelect.value = "All";
      renderSeatMap();
    });
  }

  // ── Playground: Edit-layout toggle (admins only) ─────────────────────────
  const btnEditLayout = document.getElementById("btn-edit-layout");
  if (btnEditLayout) {
    if (role === "Employee" || role === "Student") btnEditLayout.style.display = "none";
    btnEditLayout.addEventListener("click", () => {
      layoutEditMode = !layoutEditMode;
      btnEditLayout.innerText = layoutEditMode ? "✓ Done editing" : "✎ Edit layout";
      btnEditLayout.style.background = layoutEditMode ? "var(--primary)" : "var(--bg-card)";
      btnEditLayout.style.color = layoutEditMode ? "#fff" : "var(--text-primary)";
      if (window.showToast) window.showToast(layoutEditMode ? "Edit mode: drag seats to move, ✎ rename, × delete, click + to add." : "Layout saved. Back to operations.", layoutEditMode ? "warning" : "success");
      renderSeatMap();
    });
  }

  // Playground actions — called from tiles / empty cells in edit mode.
  window.addSeatAtCell = async (col, row) => {
    const res = await addSeatAt(currentFilters.floor, Number(col), Number(row));
    if (res.success) window.showToast(`Seat ${res.seatNumber} created!`, "success");
    else window.showToast(`Error: ${res.error}`, "error");
  };

  window.renameSeatPrompt = async (seatId, currentNumber) => {
    const next = window.prompt(`Rename seat ${currentNumber} to:`, currentNumber);
    if (!next || next.trim() === "" || next.trim() === currentNumber) return;
    const res = await renameSeat(seatId, next.trim());
    if (res.success) window.showToast(`Renamed to ${res.seatNumber}`, "success");
    else window.showToast(`Error: ${res.error}`, "error");
  };

  window.deleteSeatPrompt = async (seatId, seatNumber) => {
    const ok = window.confirm(`Delete seat ${seatNumber}?\n\nIt will be removed from the map. Its student (if any) loses the seat.`);
    if (!ok) return;
    const res = await deleteSeatById(seatId);
    if (res.success) window.showToast(`Seat ${seatNumber} deleted.`, "success");
    else window.showToast(`Error: ${res.error}`, "error");
  };

  // HTML5 drag & drop: drop onto an empty cell moves, onto a seat swaps.
  window._seatDragStart = (ev, seatId) => {
    dragSeatId = seatId;
    try { ev.dataTransfer.setData("text/plain", seatId); ev.dataTransfer.effectAllowed = "move"; } catch (_) {}
  };
  window._seatDragOver = (ev) => { ev.preventDefault(); try { ev.dataTransfer.dropEffect = "move"; } catch (_) {} };
  window._seatDropOnCell = async (ev, col, row) => {
    ev.preventDefault();
    const id = (ev.dataTransfer && ev.dataTransfer.getData("text/plain")) || dragSeatId;
    if (!id) return;
    dragSeatId = null;
    const dragged = allSeats.find(s => s.id === id);
    if (!dragged) return;
    col = Number(col); row = Number(row);
    if (Number(dragged.col) === col && Number(dragged.row) === row) return;
    const occupant = allSeats.find(s => s.id !== id && (s.floor || "Ground Floor") === currentFilters.floor && Number(s.col) === col && Number(s.row) === row);
    if (occupant) {
      // Swap the two seats so no position is ever lost.
      const from = { col: Number(dragged.col), row: Number(dragged.row) };
      await saveSeatPosition(occupant.id, from.col, from.row);
      await saveSeatPosition(id, col, row);
      window.showToast(`Swapped ${dragged.seatNumber} ↔ ${occupant.seatNumber}`, "success");
    } else {
      const res = await saveSeatPosition(id, col, row);
      if (res.success) window.showToast(`Moved ${dragged.seatNumber} to col ${col}, row ${row}`, "success");
      else window.showToast(`Error: ${res.error}`, "error");
    }
  };

  let currentSelectedSeat = null;

  // Create modal dynamically if it doesn't exist
  if (!document.getElementById("seat-action-modal")) {
    const modalHtml = `
      <div id="seat-action-modal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:9999; align-items:center; justify-content:center;">
        <div style="background:var(--bg-card); width:360px; border-radius:12px; padding:1.5rem; box-shadow:0 10px 25px rgba(0,0,0,0.1);">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.5rem;">
            <h3 id="seat-modal-title" style="margin:0; font-size:18px; color:var(--text-primary);">Seat Action</h3>
            <button id="btn-close-seat-modal" style="background:none; border:none; font-size:20px; cursor:pointer; color:var(--text-secondary);">&times;</button>
          </div>
          <div id="seat-modal-options" style="display:flex; flex-direction:column; gap:0.75rem;"></div>
          <div id="seat-modal-assign-form" style="display:none; flex-direction:column; gap:0.75rem;">
            <label style="font-size:13px; font-weight:600; color:var(--text-secondary);">Student Email / ID / Name</label>
            <input type="text" id="seat-assign-input" placeholder="Enter details..." style="padding:10px; border:1px solid var(--border); border-radius:8px;" />
            <div style="display:flex; justify-content:flex-end; gap:0.5rem; margin-top:0.5rem;">
              <button id="btn-cancel-assign" class="btn btn-ghost">Cancel</button>
              <button id="btn-confirm-assign" class="btn btn-primary">Assign</button>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
  }

  const seatModal = document.getElementById("seat-action-modal");
  const modalTitle = document.getElementById("seat-modal-title");
  const optionsDiv = document.getElementById("seat-modal-options");
  const assignForm = document.getElementById("seat-modal-assign-form");
  const assignInput = document.getElementById("seat-assign-input");

  if (document.getElementById("btn-close-seat-modal")) {
    document.getElementById("btn-close-seat-modal").addEventListener("click", () => {
      seatModal.style.display = "none";
    });
  }

  if (document.getElementById("btn-cancel-assign")) {
    document.getElementById("btn-cancel-assign").addEventListener("click", () => {
      assignForm.style.display = "none";
      optionsDiv.style.display = "flex";
    });
  }

  if (document.getElementById("btn-confirm-assign")) {
    document.getElementById("btn-confirm-assign").addEventListener("click", async () => {
      const val = assignInput.value.trim();
      if (!val) return;
      seatModal.style.display = "none";
      await triggerAssignSeat(currentSelectedSeat, val);
    });
  }

  // Seat click — opens the action modal immediately (no under-map detail line).
  // In edit-layout mode a click is for moving/renaming, not operations.
  window.handleSeatClick = (seatId) => {
    if (layoutEditMode) return;
    const clicked = allSeats.find(s => s.id === seatId);
    if (!clicked) return;
    currentSelectedSeat = clicked;
    window.manageSeat(seatId);
  };

  // Staff seat actions (assign / maintenance / inactive) — real backend
  window.manageSeat = (seatId) => {
    const role = localStorage.getItem("userRole");
    if (role === "Employee") {
      return window.showToast("You only have View permissions for seats.", "warning");
    }
    
    const seat = allSeats.find(s => s.id === seatId);
    if (!seat) return;
    currentSelectedSeat = seat;

    modalTitle.innerText = `Seat ${seat.seatNumber} (${seat.status})`;
    optionsDiv.innerHTML = "";
    optionsDiv.style.display = "flex";
    assignForm.style.display = "none";
    assignInput.value = "";

    const createBtn = (text, onClick) => {
      const btn = document.createElement("button");
      btn.innerText = text;
      btn.style.padding = "10px";
      btn.style.borderRadius = "8px";
      btn.style.border = "1px solid var(--border)";
      btn.style.background = "var(--bg-hover)";
      btn.style.cursor = "pointer";
      btn.style.fontWeight = "500";
      btn.style.textAlign = "left";
      btn.style.color = "var(--text-primary)";
      btn.onmouseover = () => btn.style.background = "var(--bg-hover)";
      btn.onmouseout = () => btn.style.background = "var(--bg-hover)";
      btn.onclick = () => {
        if (onClick) onClick();
      };
      return btn;
    };

    const handleAction = async (choice) => {
      seatModal.style.display = "none";
      await processSeatAction(seat, choice);
    };

    if (seat.status === "Available") {
      optionsDiv.appendChild(createBtn("Assign Student", () => {
        optionsDiv.style.display = "none";
        assignForm.style.display = "flex";
        assignInput.focus();
      }));
      optionsDiv.appendChild(createBtn("Mark Maintenance", () => handleAction("2")));
      optionsDiv.appendChild(createBtn("Mark Inactive", () => handleAction("3")));
    } else if (seat.status === "Reserved") {
      optionsDiv.appendChild(createBtn("Unassign Student", () => handleAction("1")));
      optionsDiv.appendChild(createBtn("Mark Maintenance", () => handleAction("2")));
      optionsDiv.appendChild(createBtn("Mark Inactive", () => handleAction("3")));
    } else if (seat.status === "Maintenance" || seat.status === "Inactive") {
      optionsDiv.appendChild(createBtn("Mark Available", () => handleAction("1")));
    } else if (seat.status === "Occupied") {
      const p = document.createElement("p");
      p.innerText = "Occupied seats cannot be modified directly until the student checks out.";
      p.style.fontSize = "13px";
      p.style.color = "var(--text-secondary)";
      optionsDiv.appendChild(p);
    }

    seatModal.style.display = "flex";
  };

  // Start Listener (kept for later backend wiring; display uses static data)
  if (unsubscribe) unsubscribe();
  unsubscribe = listenToAllSeats((records) => {
    allSeats = records;
    updateSeatAnalysis(allSeats);
    renderSeatMap();
  });

  // Re-paint seat colors when night/day theme toggles
  if (window.__seatThemeObserver) window.__seatThemeObserver.disconnect();
  window.__seatThemeObserver = new MutationObserver(() => renderSeatMap());
  window.__seatThemeObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
};

const processSeatAction = async (seat, choice) => {
  if (seat.status === "Occupied") {
    window.showToast("Cannot modify an occupied seat.", "error");
    return;
  }

  if (seat.status === "Available") {
    // choice === "1" is handled directly by modal assign action now
    if (choice === "2") return await changeSeatStatus(seat.id, "Maintenance");
    if (choice === "3") return await changeSeatStatus(seat.id, "Inactive");
  }

  if (seat.status === "Reserved") {
    if (choice === "1") {
      const confirmed = await window.showCustomConfirm("Unassign Seat", `Unassign ${seat.assignedStudentName} from this seat?`);
      if (confirmed) {
        await unassignSeat(seat.id);
      }
      return;
    }
    if (choice === "2") return await changeSeatStatus(seat.id, "Maintenance");
    if (choice === "3") return await changeSeatStatus(seat.id, "Inactive");
  }

  if (seat.status === "Maintenance" || seat.status === "Inactive") {
    if (choice === "1") return await changeSeatStatus(seat.id, "Available");
  }
  
  window.showToast("Invalid option or action not allowed.", "error");
};

const triggerAssignSeat = async (seat, studentEmailOrId) => {
  if (!studentEmailOrId) return;

  try {
    const q1 = query(collection(db, "students"), where("email", "==", studentEmailOrId));
    const q2 = query(collection(db, "students"), where("studentId", "==", studentEmailOrId));
    const q3 = query(collection(db, "students"), where("name", "==", studentEmailOrId));
    
    let studentSnap = await getDocs(q1);
    if (studentSnap.empty) studentSnap = await getDocs(q2);
    if (studentSnap.empty) studentSnap = await getDocs(q3);

    if (studentSnap.empty) {
      return window.showToast("Student not found.", "error");
    }

    const studentDoc = studentSnap.docs[0];
    const studentData = { id: studentDoc.id, ...studentDoc.data() };
    
    if (studentData.status !== "Active") return window.showToast("Cannot assign seat to inactive student.", "warning");
    if (studentData.seatNumber) return window.showToast(`Student already has a seat assigned: ${studentData.seatNumber}`, "warning");

    const res = await assignSeat(seat.id, studentData);
    if (!res.success) window.showToast("Failed to assign seat: " + res.error, "error");
    else window.showToast(`Successfully assigned ${studentData.name} to ${seat.seatNumber}`, "success");

  } catch (err) {
    window.showToast("Error finding student: " + err.message, "error");
  }
};

const updateSeatAnalysis = (seats) => {
  // Scoped to the floor actually on screen — the old global count is what
  // made "1 occupied" show while the visible map looked all-clean
  // (the occupied seat was on the other floor, or dimmed by a filter).
  const floor = (currentFilters && currentFilters.floor) || "Ground Floor";
  const onFloor = seats.filter(s => (s.floor || "Ground Floor") === floor);
  const occupied = onFloor.filter(s => s.status === "Occupied").length;
  const available = onFloor.filter(s => s.status === "Available").length;
  const occupiedOther = seats.filter(s => s.status === "Occupied" && (s.floor || "Ground Floor") !== floor);
  const subtitle = document.getElementById("seat-subtitle");
  if (subtitle) {
    let text = `${occupied} occupied · ${available} available on ${floor}`;
    if (occupiedOther.length > 0) {
      const names = occupiedOther.slice(0, 3).map(s => s.seatNumber).join(", ");
      const more = occupiedOther.length > 3 ? ` +${occupiedOther.length - 3} more` : "";
      text += ` · ${occupiedOther.length} occupied elsewhere (${names}${more}) — switch floor to see`;
    }
    // A status/search filter dims non-matching seats to near-invisible —
    // say so, or the scoped count looks wrong against a "clean" map.
    const st = currentFilters && currentFilters.status;
    const q = currentFilters && currentFilters.search;
    if ((st && st !== "All") || q) {
      text += ` · filtered view${st && st !== "All" ? `: ${st}` : ""}${q ? ` · “${q}”` : ""} (dimmed seats still counted above)`;
    }
    // Orphan claims: an Active student holds a seat name that isn't on the
    // library plan, so it can never render. Name them instead of silence.
    if (seatHealthOrphans.length > 0) {
      const shown = seatHealthOrphans.slice(0, 3).map(o => `${o.studentName} holds “${o.seatNumber}”`).join("; ");
      const more = seatHealthOrphans.length > 3 ? ` +${seatHealthOrphans.length - 3} more` : "";
      text += ` · ⚠ not on map: ${shown}${more} (fix the student's seat number)`;
    }
    subtitle.innerText = text;
  }
};

  const renderSeatMap = () => {
    const grid = document.getElementById("seat-grid");
    if (!grid) return;

    let filtered = allSeats.filter(seat => {
      const seatFloor = seat.floor || "Ground Floor";
      return seatFloor === currentFilters.floor;
    });

    // Spec layout names — also used to infer positions for backend docs that
    // predate col/row, and to know structural gaps (nulls).
    const groundCol1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18].map(n => 'A' + n);
    const groundCol2 = [null, 34, 33, 32, 31, 30, 29, 28, 27, 26, 25, 24, 67, 23, 22, 21, 20, 19].map(n => n ? 'A' + n : null);
    const groundCol3 = [null, 35, 36, null, 37, 38, 39, 40, 41, 42, null, 43, 68, 44, 45, 46, 47, 48].map(n => n ? 'A' + n : null);
    const groundCol4 = [66, 65, 64, 63, 62, 61, 60, 59, 58, 57, 56, 55, 54, 53, 52, 51, 50, 49].map(n => 'A' + n);

    const firstCol1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, null].map(n => n ? 'B' + n : null);
    const firstCol2 = [null, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11].map(n => n ? 'B' + n : null);
    const firstCol3 = [null, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30].map(n => n ? 'B' + n : null);
    const firstCol4 = [40, 39, 38, 37, 36, 35, 34, 33, 32, 31, null].map(n => n ? 'B' + n : null);

    const specCols = currentFilters.floor === "First Floor"
      ? [firstCol1, firstCol2, firstCol3, firstCol4]
      : [groundCol1, groundCol2, groundCol3, groundCol4];

    // name -> {col,row} from the spec (for docs that predate col/row)
    const specPosByName = new Map();
    specCols.forEach((arr, ci) => {
      arr.forEach((name, ri) => {
        if (name) specPosByName.set(normalizeSeatNumber(name), { col: ci + 1, row: ri + 1 });
      });
    });

    const isFilteredOut = (seat) => {
      if (currentFilters.status !== "All" && seat.status !== currentFilters.status) return true;
      if (currentFilters.search) {
        const q = currentFilters.search.toLowerCase();
        const sn = (seat.seatNumber||"").toLowerCase();
        const asn = (seat.assignedStudentName||"").toLowerCase();
        if (!sn.includes(q) && !asn.includes(q)) return true;
      }
      return false;
    };

    // "X of Y seats match" counter — updated on every render path.
    const matchCountEl = document.getElementById("seat-filter-count");
    if (matchCountEl) {
      const active = currentFilters.status !== "All" || currentFilters.search;
      matchCountEl.innerText = active
        ? `${filtered.filter(s => !isFilteredOut(s)).length} of ${filtered.length} seats match`
        : "";
    }

    // Single real seat tile. In edit mode: draggable + rename/delete buttons,
    // click suppressed (handleSeatClick early-returns in edit mode).
    const renderSeatCardBySeat = (seat) => {
      const filteredOut = isFilteredOut(seat);
      const __pal = seatPalette(seat.status);
      const editBtns = layoutEditMode ? `
        <span style="position:absolute; top:2px; right:4px; display:flex; gap:4px;">
          <span onclick="event.stopPropagation(); window.renameSeatPrompt('${seat.id}', '${seat.seatNumber}')" title="Rename seat"
            style="font-size:11px; cursor:pointer; opacity:0.75; padding:0 3px; border-radius:4px; background:rgba(0,0,0,0.08);">✎</span>
          <span onclick="event.stopPropagation(); window.deleteSeatPrompt('${seat.id}', '${seat.seatNumber}')" title="Delete seat"
            style="font-size:11px; cursor:pointer; opacity:0.75; padding:0 3px; border-radius:4px; background:rgba(0,0,0,0.08);">×</span>
        </span>` : "";
      const dragAttrs = layoutEditMode
        ? `draggable="true" ondragstart="window._seatDragStart(event, '${seat.id}')"`
        : "";
      const dropAttrs = layoutEditMode
        ? `ondragover="window._seatDragOver(event)" ondrop="window._seatDropOnCell(event, ${Number(seat.col)}, ${Number(seat.row)})"`
        : "";
      return `
        <div
          class="seat-card"
          ${dragAttrs} ${dropAttrs}
          onclick="window.handleSeatClick('${seat.id}')"
          style="
            position:relative;
            background: ${__pal.bg}; border: ${__pal.border}; color: ${__pal.color};
            border-radius: 8px; height: 50px; display: flex;
            align-items: center; justify-content: center;
            cursor: ${layoutEditMode ? "move" : "pointer"}; transition: box-shadow 0.15s, border-color 0.15s;
            opacity: ${filteredOut ? '0.15' : '1'};
          "
          onmouseover="this.style.boxShadow='0 0 0 2px currentColor';"
          onmouseout="this.style.boxShadow='none';"
          title="${seat.seatNumber} · ${seat.status}${seat.assignedStudentName ? ' · ' + seat.assignedStudentName : ''}${layoutEditMode ? ' · drag to move' : ''}"
        >
          ${editBtns}
          <div style="font-size: 14px; font-weight: 600;">${seat.seatNumber}</div>
        </div>
      `;
    };

    // Generic responsive grid — every seat of this floor in natural order.
    const paintAdminGenericGrid = () => {
      grid.style.display = "grid";
      grid.style.gridTemplateColumns = "repeat(auto-fill, minmax(85px, 1fr))";
      grid.style.gap = "1rem";

      const sortedSeats = [...filtered].sort((a, b) =>
        compareSeatNumbers(a.seatNumber, b.seatNumber));

      grid.innerHTML = sortedSeats.map(s => renderSeatCardBySeat(s)).join("");
    };

    // Seats not named A*/B* don't fit the room layout — generic grid.
    if (!shouldUseABLayout(filtered)) {
      paintAdminGenericGrid();
      return;
    }

    // ── Data-driven room: positions come from backend col/row ──────────────
    const posMap = new Map();
    const unplaced = [];
    filtered.forEach(seat => {
      const c = Number(seat.col), r = Number(seat.row);
      if (Number.isFinite(c) && Number.isFinite(r) && c >= 1 && c <= 4 && r >= 1) {
        const key = `${c}x${r}`;
        if (!posMap.has(key)) posMap.set(key, seat);
        else unplaced.push(seat);
      } else {
        const inferred = specPosByName.get(normalizeSeatNumber(seat.seatNumber));
        if (inferred) {
          const key = `${inferred.col}x${inferred.row}`;
          if (!posMap.has(key)) posMap.set(key, { ...seat, col: inferred.col, row: inferred.row });
          else unplaced.push(seat);
        } else {
          unplaced.push(seat);
        }
      }
    });

    const baseRows = currentFilters.floor === "First Floor" ? 11 : 18;
    let maxRow = baseRows;
    posMap.forEach(seat => { if (Number(seat.row) > maxRow) maxRow = Number(seat.row); });

    const renderCell = (col, row) => {
      const seat = posMap.get(`${col}x${row}`);
      if (seat) return renderSeatCardBySeat(seat);
      if (layoutEditMode) {
        return `
          <div class="seat-card empty-cell"
               onclick="window.addSeatAtCell(${col}, ${row})"
               ondragover="window._seatDragOver(event)"
               ondrop="window._seatDropOnCell(event, ${col}, ${row})"
               style="background:transparent; border:1px dashed var(--border-bright); border-radius: 8px; height: 50px; display: flex; align-items: center; justify-content: center; color:var(--text-muted); font-size: 18px; cursor: copy;"
               title="Click to add a seat here (col ${col}, row ${row})">+</div>`;
      }
      return `<div style="height: 50px; width: 100%;"></div>`;
    };

    const renderColByPosition = (colIdx) => {
      let colHtml = `<div style="display: flex; flex-direction: column; gap: 0.5rem; flex: 1;">`;
      for (let r = 1; r <= maxRow; r++) colHtml += renderCell(colIdx, r);
      colHtml += `</div>`;
      return colHtml;
    };

    const roomShell = (colsHtml, maxW) => `
        <div style="background:var(--bg-card); padding: 3rem 2rem 4rem 2rem; border-radius: 12px; position: relative; border:1px solid var(--border);${layoutEditMode ? " outline:2px dashed var(--primary);" : ""}">
          <div style="position: absolute; top: 0; left: 50%; transform: translateX(-50%); background:var(--bg-hover); border:1px solid var(--border); border-top: none; padding: 0.5rem 2.5rem; border-radius: 0 0 12px 12px; font-weight: 700; color:var(--text-secondary); letter-spacing: 2px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);">
            DOOR
          </div>
          ${layoutEditMode ? `<div style="text-align:center; font-size:12px; color:var(--text-muted); margin-bottom:1rem;">EDIT MODE — drag seats to move · ✎ rename · × delete · + add</div>` : ""}
          <div style="display: flex; gap: 1.5rem; justify-content: center; max-width: ${maxW}; margin: 0 auto; align-items: flex-start;">
            ${colsHtml}
          </div>
          <div style="position: absolute; bottom: 0; left: 0; right: 0; display: flex; justify-content: space-around; pointer-events: none;">
            <div style="background:var(--bg-hover); border:1px solid var(--border); border-bottom: none; padding: 0.5rem 2.5rem; border-radius: 12px 12px 0 0; font-weight: 700; color:var(--text-secondary); letter-spacing: 2px; box-shadow: 0 -4px 6px -1px rgba(0,0,0,0.05);">
              TOILET-1
            </div>
            <div style="background:var(--bg-hover); border:1px solid var(--border); border-bottom: none; padding: 0.5rem 2.5rem; border-radius: 12px 12px 0 0; font-weight: 700; color:var(--text-secondary); letter-spacing: 2px; box-shadow: 0 -4px 6px -1px rgba(0,0,0,0.05);">
              TOILET-2
            </div>
          </div>
        </div>
        ${unplaced.length ? `<div style="margin-top:1rem; font-size:12px; color:var(--text-muted);">+ ${unplaced.length} seat(s) without a position: ${unplaced.map(s => s.seatNumber).join(", ")}</div>` : ""}
      `;

    let html = "";
    if (currentFilters.floor === "First Floor") {
      html = roomShell(
        renderColByPosition(1) + renderColByPosition(2) + renderColByPosition(3) + renderColByPosition(4),
        "800px"
      );
    } else if (currentFilters.floor === "Ground Floor") {
      html = roomShell(
        renderColByPosition(1) + renderColByPosition(2) + renderColByPosition(3) + renderColByPosition(4),
        "900px"
      );
    } else {
      paintAdminGenericGrid();
      return;
    }

    grid.style.display = "block";
    grid.innerHTML = html;
  };

