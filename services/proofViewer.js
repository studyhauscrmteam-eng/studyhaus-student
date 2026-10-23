/**
 * Comprehensive Proof & Document Enlarger Lightbox
 * Features:
 *  - Enlarge / Fullscreen modal toggle (98vw x 96vh)
 *  - Interactive zoom (50% to 400%) with live percentage display
 *  - Mouse wheel zoom + double-click toggle (1x / 2x)
 *  - Drag-to-pan when zoomed in
 *  - 90-degree image rotation (↺ Left / ↻ Right) for rotated UPI receipts
 *  - Multi-image pagination (Prev / Next) for multiple screenshot attachments
 *  - Open original in new browser tab
 *  - Download proof button
 *  - Keyboard shortcuts (Esc, +, -, 0, R, F, Arrow keys)
 *  - Handles Images, Data URLs, HTTPS URLs, Blobs and PDFs
 */

export const openProofViewer = (options = {}) => {
  let sources = [];
  if (Array.isArray(options.sources)) {
    sources = options.sources.filter(Boolean);
  } else if (options.src || options.dataUrl) {
    sources = [options.src || options.dataUrl];
  } else if (typeof options === "string") {
    sources = [options];
  }

  const title = options.title || "Proof Viewer";
  let currentIndex = Math.max(0, Math.min(options.initialIndex || 0, Math.max(0, sources.length - 1)));

  if (!sources.length) {
    if (window.showToast) window.showToast("No screenshot proof available to display.", "warning");
    return;
  }

  // Remove any previously open proof modal
  const existing = document.getElementById("proof-enlarger-modal");
  if (existing) existing.remove();

  // State
  let scale = 1;
  let rotation = 0;
  let panX = 0;
  let panY = 0;
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let isFullscreen = false;

  const dialog = document.createElement("dialog");
  dialog.id = "proof-enlarger-modal";
  dialog.className = "card smooth-modal";
  dialog.style.cssText = `
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 0;
    box-shadow: 0 28px 70px rgba(0, 0, 0, 0.65);
    background: var(--bg-card);
    color: var(--text-primary);
    width: min(920px, 95vw);
    height: min(84vh, 820px);
    margin: auto;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    outline: none;
    transition: width 0.25s ease, height 0.25s ease;
  `;

  dialog.innerHTML = `
    <!-- Top Header -->
    <div style="padding: 0.85rem 1.25rem; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); background: var(--bg-card); flex-shrink: 0; z-index: 2;">
      <div style="display: flex; align-items: center; gap: 10px; min-width: 0;">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--primary); flex-shrink:0;">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </svg>
        <div style="min-width: 0;">
          <h3 style="margin: 0; font-size: 1.02rem; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${title}</h3>
          <span id="pv-subinfo" style="font-size: 11px; color: var(--text-muted); display: block;"></span>
        </div>
      </div>
      <div style="display: flex; align-items: center; gap: 6px;">
        <button id="pv-toggle-fullscreen" class="btn btn-ghost btn-sm" title="Toggle Fullscreen Enlarge (F)" style="padding: 5px 10px; font-size: 12px; display: inline-flex; align-items: center; gap: 5px;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
          <span id="pv-fs-label">Enlarge</span>
        </button>
        <button id="pv-close" class="btn btn-ghost" title="Close (Esc)" style="padding: 4px 10px; font-size: 1.2rem; line-height: 1; cursor: pointer;">✕</button>
      </div>
    </div>

    <!-- Interactive Controls Bar -->
    <div id="pv-toolbar" style="padding: 6px 12px; background: var(--bg-hover); border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; font-size: 12px; flex-shrink: 0; z-index: 2;">
      <!-- Zoom Controls -->
      <div style="display: flex; align-items: center; gap: 4px;">
        <button id="pv-zoom-out" class="btn btn-secondary btn-sm" title="Zoom Out (-)" style="padding: 4px 8px; font-weight: 700;">−</button>
        <button id="pv-zoom-reset" class="btn btn-ghost btn-sm" title="Reset Zoom (0)" style="padding: 4px 8px; font-weight: 600; font-variant-numeric: tabular-nums;">
          <span id="pv-zoom-level">100%</span>
        </button>
        <button id="pv-zoom-in" class="btn btn-secondary btn-sm" title="Zoom In (+)" style="padding: 4px 8px; font-weight: 700;">+</button>
      </div>

      <!-- Rotation Controls -->
      <div style="display: flex; align-items: center; gap: 4px;">
        <button id="pv-rotate-left" class="btn btn-secondary btn-sm" title="Rotate Left 90°" style="padding: 4px 9px; display: inline-flex; align-items: center; gap: 4px;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
          ↺ -90°
        </button>
        <button id="pv-rotate-right" class="btn btn-secondary btn-sm" title="Rotate Right 90° (R)" style="padding: 4px 9px; display: inline-flex; align-items: center; gap: 4px;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
          ↻ +90°
        </button>
      </div>

      <!-- Multi-image Pagination (hidden if only 1 image) -->
      <div id="pv-pagination" style="display: flex; align-items: center; gap: 6px;">
        <button id="pv-prev" class="btn btn-secondary btn-sm" title="Previous Image (←)" style="padding: 4px 9px;">← Prev</button>
        <span id="pv-page-indicator" style="font-weight: 600; color: var(--text-muted); font-size: 11.5px;"></span>
        <button id="pv-next" class="btn btn-secondary btn-sm" title="Next Image (→)" style="padding: 4px 9px;">Next →</button>
      </div>

      <!-- Actions -->
      <div style="display: flex; align-items: center; gap: 6px;">
        <a id="pv-open-tab" class="btn btn-secondary btn-sm" target="_blank" rel="noopener noreferrer" title="Open original image in a new tab" style="padding: 4px 10px; display: inline-flex; align-items: center; gap: 4px; text-decoration: none;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          Open Full
        </a>
        <a id="pv-download" class="btn btn-primary btn-sm" download="payment-proof.jpg" title="Download proof image" style="padding: 4px 12px; display: inline-flex; align-items: center; gap: 4px; text-decoration: none; font-weight: 600;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Download
        </a>
      </div>
    </div>

    <!-- Viewer Stage -->
    <div id="pv-stage-container" style="flex: 1; position: relative; overflow: hidden; background: #0c0e14; display: flex; align-items: center; justify-content: center; cursor: grab; user-select: none;">
      <div id="pv-viewport" style="width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; transform-origin: center center; transition: transform 0.12s ease-out;">
        <!-- Image or PDF rendered here -->
      </div>
      <!-- Hint overlay -->
      <div id="pv-hint" style="position: absolute; bottom: 12px; left: 16px; background: rgba(0, 0, 0, 0.65); backdrop-filter: blur(4px); color: #e2e8f0; font-size: 11px; padding: 4px 10px; border-radius: 6px; pointer-events: none; opacity: 0.85; transition: opacity 0.3s;">
        Scroll to Zoom · Drag to Pan · Double-click to Toggle 2x
      </div>
    </div>
  `;

  document.body.appendChild(dialog);

  const stageContainer = dialog.querySelector("#pv-stage-container");
  const viewport = dialog.querySelector("#pv-viewport");
  const zoomLevelEl = dialog.querySelector("#pv-zoom-level");
  const subinfoEl = dialog.querySelector("#pv-subinfo");
  const pageIndicatorEl = dialog.querySelector("#pv-page-indicator");
  const paginationDiv = dialog.querySelector("#pv-pagination");
  const openTabBtn = dialog.querySelector("#pv-open-tab");
  const downloadBtn = dialog.querySelector("#pv-download");
  const prevBtn = dialog.querySelector("#pv-prev");
  const nextBtn = dialog.querySelector("#pv-next");
  const fsBtn = dialog.querySelector("#pv-toggle-fullscreen");
  const fsLabel = dialog.querySelector("#pv-fs-label");

  const isPdf = (src) => typeof src === "string" && (src.startsWith("data:application/pdf") || src.toLowerCase().endsWith(".pdf"));

  const applyTransform = () => {
    viewport.style.transform = `translate(${panX}px, ${panY}px) scale(${scale}) rotate(${rotation}deg)`;
    zoomLevelEl.textContent = `${Math.round(scale * 100)}%`;
    stageContainer.style.cursor = scale > 1 ? (isDragging ? "grabbing" : "grab") : "default";
  };

  const resetTransform = () => {
    scale = 1;
    rotation = 0;
    panX = 0;
    panY = 0;
    applyTransform();
  };

  const updateFullscreenState = () => {
    if (isFullscreen) {
      dialog.style.width = "98vw";
      dialog.style.height = "96vh";
      dialog.style.maxWidth = "none";
      dialog.style.maxHeight = "none";
      dialog.style.borderRadius = "8px";
      fsLabel.textContent = "Contract";
    } else {
      dialog.style.width = "min(920px, 95vw)";
      dialog.style.height = "min(84vh, 820px)";
      dialog.style.borderRadius = "16px";
      fsLabel.textContent = "Enlarge";
    }
  };

  const renderCurrent = () => {
    resetTransform();
    const currentSrc = sources[currentIndex];
    const isCurrentPdf = isPdf(currentSrc);

    // Multi-image indicator
    if (sources.length > 1) {
      paginationDiv.style.display = "flex";
      pageIndicatorEl.textContent = `${currentIndex + 1} of ${sources.length}`;
      prevBtn.disabled = currentIndex === 0;
      nextBtn.disabled = currentIndex === sources.length - 1;
      subinfoEl.textContent = `Viewing file ${currentIndex + 1} of ${sources.length} · Click 'Enlarge' for full screen`;
    } else {
      paginationDiv.style.display = "none";
      subinfoEl.textContent = "Interactive Enlarge Viewer · Click 'Enlarge' for full screen";
    }

    openTabBtn.href = currentSrc;
    downloadBtn.href = currentSrc;
    const cleanExt = isCurrentPdf ? "pdf" : "jpg";
    downloadBtn.download = `${(title || "proof").replace(/[^a-zA-Z0-9_-]/g, "_")}-${currentIndex + 1}.${cleanExt}`;

    if (isCurrentPdf) {
      dialog.querySelector("#pv-toolbar").style.display = "none";
      stageContainer.style.cursor = "default";
      viewport.innerHTML = `<iframe src="${currentSrc}" style="width:100%; height:100%; border:none; background:#fff;"></iframe>`;
      return;
    }

    dialog.querySelector("#pv-toolbar").style.display = "flex";
    viewport.innerHTML = `
      <img id="pv-img" src="${currentSrc}" alt="${title}"
        onerror="this.onerror=null; this.parentElement.innerHTML='<div style=\\'padding:3rem; color:#f87171; text-align:center; font-size:14px;\\'>⚠️ Screenshot proof could not be loaded or format is unsupported.</div>';"
        style="max-width: 96%; max-height: 96%; object-fit: contain; pointer-events: none; border-radius: 6px; box-shadow: 0 10px 35px rgba(0,0,0,0.5);"
      />
    `;
  };

  // Zoom handlers
  const zoomIn = () => {
    scale = Math.min(4.0, Math.round((scale + 0.25) * 100) / 100);
    applyTransform();
  };

  const zoomOut = () => {
    scale = Math.max(0.5, Math.round((scale - 0.25) * 100) / 100);
    if (scale <= 1) { panX = 0; panY = 0; }
    applyTransform();
  };

  dialog.querySelector("#pv-zoom-in").onclick = zoomIn;
  dialog.querySelector("#pv-zoom-out").onclick = zoomOut;
  dialog.querySelector("#pv-zoom-reset").onclick = resetTransform;

  // Rotation handlers
  dialog.querySelector("#pv-rotate-left").onclick = () => {
    rotation = (rotation - 90) % 360;
    applyTransform();
  };
  dialog.querySelector("#pv-rotate-right").onclick = () => {
    rotation = (rotation + 90) % 360;
    applyTransform();
  };

  // Enlarge / Fullscreen toggle
  fsBtn.onclick = () => {
    isFullscreen = !isFullscreen;
    updateFullscreenState();
  };

  // Multi-image handlers
  prevBtn.onclick = () => {
    if (currentIndex > 0) {
      currentIndex--;
      renderCurrent();
    }
  };
  nextBtn.onclick = () => {
    if (currentIndex < sources.length - 1) {
      currentIndex++;
      renderCurrent();
    }
  };

  // Mouse wheel zoom
  stageContainer.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (e.deltaY < 0) {
      scale = Math.min(4.0, Math.round((scale + 0.15) * 100) / 100);
    } else {
      scale = Math.max(0.5, Math.round((scale - 0.15) * 100) / 100);
      if (scale <= 1) { panX = 0; panY = 0; }
    }
    applyTransform();
  }, { passive: false });

  // Double-click to toggle 2x zoom
  stageContainer.addEventListener("dblclick", (e) => {
    if (scale > 1.2) {
      resetTransform();
    } else {
      scale = 2.0;
      panX = 0;
      panY = 0;
      applyTransform();
    }
  });

  // Pan / Drag implementation
  stageContainer.addEventListener("mousedown", (e) => {
    if (scale <= 1) return;
    isDragging = true;
    dragStartX = e.clientX - panX;
    dragStartY = e.clientY - panY;
    stageContainer.style.cursor = "grabbing";
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    panX = e.clientX - dragStartX;
    panY = e.clientY - dragStartY;
    applyTransform();
  });

  const stopDrag = () => {
    if (isDragging) {
      isDragging = false;
      stageContainer.style.cursor = scale > 1 ? "grab" : "default";
    }
  };
  window.addEventListener("mouseup", stopDrag);

  // Keyboard navigation
  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      close();
    } else if (e.key === "+" || e.key === "=") {
      zoomIn();
    } else if (e.key === "-" || e.key === "_") {
      zoomOut();
    } else if (e.key === "0") {
      resetTransform();
    } else if (e.key === "r" || e.key === "R") {
      rotation = (rotation + 90) % 360;
      applyTransform();
    } else if (e.key === "f" || e.key === "F") {
      isFullscreen = !isFullscreen;
      updateFullscreenState();
    } else if (e.key === "ArrowLeft") {
      if (currentIndex > 0) { currentIndex--; renderCurrent(); }
    } else if (e.key === "ArrowRight") {
      if (currentIndex < sources.length - 1) { currentIndex++; renderCurrent(); }
    }
  };
  window.addEventListener("keydown", onKeyDown);

  const close = () => {
    window.removeEventListener("mouseup", stopDrag);
    window.removeEventListener("keydown", onKeyDown);
    dialog.close();
    dialog.remove();
  };

  dialog.querySelector("#pv-close").onclick = close;
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) close();
  });

  renderCurrent();
  dialog.showModal();
};

// Global bindings for backward compatibility across all modules
if (typeof window !== "undefined") {
  window.openProofViewer = openProofViewer;
  window.enlargeDocument = (src, title) => openProofViewer({ sources: [src], title: title || "Document Preview" });
  window.viewAdminProofModal = (dataUrl, title) => openProofViewer({ sources: [dataUrl], title: title || "Payment Screenshot Proof" });
  window.viewStudentProofModal = (dataUrl, title) => openProofViewer({ sources: [dataUrl], title: title || "Payment Screenshot Proof" });
}
