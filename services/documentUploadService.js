import { doc, setDoc, getDoc } from "firebase/firestore";
import { db } from "../firebase/firebase.js";

// ──────────────────────────────────────────────
// State for custom Selfie capture
// ──────────────────────────────────────────────
let capturedSelfieFile = null;
let selfieStream = null;

// ──────────────────────────────────────────────
// Image compression via Canvas (client-side, free)
// ──────────────────────────────────────────────

/**
 * Compress and resize an image File to a base64 string.
 * Max width/height: 600px. Quality: 0.6 (JPEG).
 * Ensures result is under 1MB (Firestore field limit).
 * @param {File} file
 * @returns {Promise<string>} base64 data URL
 */
export const compressImage = (file) => {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      // For non-images (e.g. PDF), read as base64 directly (no compression)
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
      return;
    }

    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let { width, height } = img;
      const MAX_DIM = 600;
      let quality = 0.6;

      // Scale down if needed
      if (width > MAX_DIM || height > MAX_DIM) {
        if (width > height) { height = Math.round((height / width) * MAX_DIM); width = MAX_DIM; }
        else { width = Math.round((width / height) * MAX_DIM); height = MAX_DIM; }
      }

      const tryCompress = (q) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        return canvas.toDataURL("image/jpeg", q);
      };

      // A Firestore document caps at ~1MB and `studentDocuments` holds FOUR
      // image fields (aadhaarFront, aadhaarBack, photo, paymentScreenshot).
      // 220k base64 chars each leaves comfortable headroom for metadata, and
      // the security rules reject anything over 240k.
      let dataUrl = tryCompress(quality);
      let attempts = 0;
      const MAX_BYTES = 220000;
      const MIN_QUALITY = 0.2;
      const MIN_DIM = 320;

      while (dataUrl.length > MAX_BYTES && quality > MIN_QUALITY && attempts < 6) {
        attempts++;
        quality = Math.max(MIN_QUALITY, Math.round((quality - 0.1) * 100) / 100);
        dataUrl = tryCompress(quality);
      }

      // Still too large -> shrink dimensions until it fits (or hit the floor).
      while (dataUrl.length > MAX_BYTES && (width > MIN_DIM || height > MIN_DIM)) {
        width = Math.max(1, Math.round(width * 0.8));
        height = Math.max(1, Math.round(height * 0.8));
        dataUrl = tryCompress(quality);
      }

      URL.revokeObjectURL(url);

      if (dataUrl.length > MAX_BYTES) {
        // Never write an oversized field: it would make the whole document
        // unwritable and silently break uploads for this student.
        return reject(new Error(
          "Image is still too large after compression. Please use a smaller photo (max ~200 KB) and try again."
        ));
      }
      resolve(dataUrl);
    };
    img.onerror = reject;
    img.src = url;
  });
};

// ──────────────────────────────────────────────
// Save / Load document images in Firestore
// ──────────────────────────────────────────────

/**
 * Save compressed document images into Firestore.
 * Stored in: studentDocuments/{studentId}
 * Legacy callers may still pass `selfie` / `profilePhoto` keys — they are
 * merged into the single canonical `photo` field so only one photo exists.
 * @param {Object} files - { aadhaarFront: File|null, aadhaarBack: File|null, photo: File|null }
 * @param {string} studentId
 * @param {function} onProgress - called with 0-100
 * @returns {Promise<Object>} field names added { aadhaarFrontUrl, aadhaarBackUrl, photoUrl }
 */
export const uploadAdmissionDocuments = async (files, studentId, onProgress = () => { }) => {
  // Normalise legacy keys -> single photo (last one wins, never duplicated).
  const normalised = { ...files };
  if (normalised.selfie && !normalised.photo) normalised.photo = normalised.selfie;
  if (normalised.profilePhoto && !normalised.photo) normalised.photo = normalised.profilePhoto;
  delete normalised.selfie;
  delete normalised.profilePhoto;

  const entries = Object.entries(normalised).filter(([, f]) => f !== null);
  if (entries.length === 0) return {};

  const docData = { studentId, updatedAt: new Date().toISOString() };
  const urlMap = {};
  let done = 0;

  for (const [key, file] of entries) {
    onProgress(Math.round((done / entries.length) * 90));
    const base64 = await compressImage(file);
    docData[key] = base64;                    // store in Firestore doc
    urlMap[`${key}Url`] = `firestore:${key}`; // marker so student doc knows it's stored
    done++;
  }

  // Write to Firestore sub-collection
  await setDoc(doc(db, "studentDocuments", studentId), docData, { merge: true });
  onProgress(100);
  setTimeout(() => onProgress(0), 600);
  return urlMap;
};

/**
 * Save a generic document into Firestore.
 * Stored in: globalDocuments (+ globalDocumentChunks for files > 1 chunk)
 *
 * Firestore limits a single document to ~1MB, so bigger files are split into
 * ~700KB base64 chunks written to the `globalDocumentChunks` collection.
 */
const CHUNK_SIZE = 700000;   // characters of base64 per chunk document
const MAX_FILE_SIZE = 10 * 1024 * 1024; // hard cap: 10 MB

export const uploadGlobalDocument = async (file, title, description, onProgress = () => { }) => {
  if (file && file.size > MAX_FILE_SIZE) {
    onProgress(0);
    const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
    throw new Error(`"${file.name}" is ${sizeMb} MB — maximum allowed size is 10 MB.`);
  }

  onProgress(10);
  const base64 = await compressImage(file);
  onProgress(50);

  const { collection, addDoc, setDoc, deleteDoc, doc: fsDoc } = await import("firebase/firestore");

  const docData = {
    title: title || file.name,
    description: description || "",
    fileName: file.name,
    fileType: file.type,
    uploadedAt: new Date().toISOString(),
    uploadedBy: localStorage.getItem("userId") || "unknown"
  };

  if (base64.length <= CHUNK_SIZE) {
    docData.base64Data = base64;
    await addDoc(collection(db, "globalDocuments"), docData);
  } else {
    const chunks = [];
    for (let i = 0; i < base64.length; i += CHUNK_SIZE) {
      chunks.push(base64.slice(i, i + CHUNK_SIZE));
    }
    docData.chunkCount = chunks.length;
    docData.base64Length = base64.length;
    docData.base64Data = ""; // placeholder so the field always exists

    const docRef = await addDoc(collection(db, "globalDocuments"), docData);
    try {
      for (let i = 0; i < chunks.length; i++) {
        onProgress(50 + Math.round((i / chunks.length) * 49));
        await setDoc(fsDoc(db, "globalDocumentChunks", `${docRef.id}_${i}`), {
          docId: docRef.id,
          part: i,
          data: chunks[i]
        });
      }
    } catch (e) {
      // Remove the half-written entry so the list doesn't show a broken document
      await deleteDoc(docRef).catch(() => { });
      throw e;
    }
  }

  onProgress(100);
  setTimeout(() => onProgress(0), 600);
  return true;
};

/**
 * Load generic documents from Firestore (re-assembles chunked files)
 */
export const loadGlobalDocuments = async () => {
  const { collection, getDocs, orderBy, query, where } = await import("firebase/firestore");
  const q = query(collection(db, "globalDocuments"), orderBy("uploadedAt", "desc"));
  const snap = await getDocs(q);
  const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Re-assemble any documents that were stored in chunks
  await Promise.all(docs.filter(d => d.chunkCount > 0).map(async d => {
    try {
      const cq = query(collection(db, "globalDocumentChunks"), where("docId", "==", d.id));
      const cs = await getDocs(cq);
      const parts = cs.docs.map(c => c.data()).sort((a, b) => a.part - b.part);
      d.base64Data = parts.map(p => p.data).join("");
      d.missingChunks = parts.length !== d.chunkCount;
    } catch (e) {
      console.error("Failed to load document chunks for", d.id, e);
      d.base64Data = "";
      d.missingChunks = true;
    }
  }));

  return docs;
};

/**
 * Load document images for a student from Firestore
 * @param {string} studentId
 * @returns {Promise<Object|null>}
 */
export const loadStudentDocuments = async (studentId, fallbackStudent = null) => {
  if (!studentId && !fallbackStudent) return null;

  const candidates = new Set();
  const addCandidate = (val) => {
    if (val && typeof val === "string") {
      const trimmed = val.trim();
      if (trimmed) candidates.add(trimmed);
    }
  };

  addCandidate(studentId);
  if (fallbackStudent && typeof fallbackStudent === "object") {
    addCandidate(fallbackStudent.id);
    addCandidate(fallbackStudent.uid);
    addCandidate(fallbackStudent.studentId);
    addCandidate(fallbackStudent.admissionNo);
  }

  // 1. Direct getDoc on each candidate ID
  for (const cid of candidates) {
    try {
      const snap = await getDoc(doc(db, "studentDocuments", cid));
      if (snap.exists()) {
        const d = snap.data();
        if (d && Object.keys(d).length > 0) return d;
      }
    } catch (_) {}
  }

  // 2. Query studentDocuments collection by studentId or uid field
  for (const cid of candidates) {
    try {
      const { query, collection, where, getDocs, limit } = await import("firebase/firestore");
      const q1 = query(collection(db, "studentDocuments"), where("studentId", "==", cid), limit(1));
      const s1 = await getDocs(q1);
      if (!s1.empty) return s1.docs[0].data();

      const q2 = query(collection(db, "studentDocuments"), where("uid", "==", cid), limit(1));
      const s2 = await getDocs(q2);
      if (!s2.empty) return s2.docs[0].data();
    } catch (_) {}
  }

  return null;
};

/**
 * Fields stored per student in `studentDocuments/{studentId}`.
 * There is exactly ONE photo field: `photo`. Legacy `selfie` and
 * `profilePhoto` copies from older builds are still READ as a fallback
 * (see getStudentPhoto) but never written any more.
 */
export const STUDENT_DOC_FIELDS = [
  { key: "aadhaarFront", label: "Aadhaar Front", accept: "image/*,.pdf", hint: "Front of ID proof" },
  { key: "aadhaarBack", label: "Aadhaar Back", accept: "image/*,.pdf", hint: "Back of ID proof" },
  { key: "photo", label: "Photo", accept: "image/*", hint: "Upload or take a live selfie — one photo only" },
];

/**
 * Single source of truth for a student's photo.
 * @param {Object|null} docs - studentDocuments/{id} data
 * @param {Object|null} student - students/{id} data (denormalised URLs)
 * @returns {string|null} base64 data URL or null
 */
export const getStudentPhoto = (docs, student) => {
  if (docs) {
    if (docs.photo) return docs.photo;
    if (docs.profilePhoto) return docs.profilePhoto; // legacy
    if (docs.selfie) return docs.selfie;               // legacy
  }
  if (student) {
    return student.profilePhotoUrl || student.photoUrl || student.photo || student.selfieUrl || null;
  }
  return null;
};

const notify = (msg, type = "info") => {
  if (typeof window !== "undefined" && typeof window.showToast === "function") window.showToast(msg, type);
  else console.log(`[${type}] ${msg}`);
};

/** Save/replace one document field for a student. */
export const uploadStudentDocument = async (studentId, key, file) => {
  if (!studentId) throw new Error("Missing student ID.");
  if (!file) throw new Error("No file selected.");
  if (file.size > MAX_FILE_SIZE) {
    const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
    throw new Error(`"${file.name}" is ${sizeMb} MB — maximum allowed size is 10 MB.`);
  }
  const base64 = await compressImage(file);
  await setDoc(
    doc(db, "studentDocuments", studentId),
    { studentId, [key]: base64, updatedAt: new Date().toISOString() },
    { merge: true }
  );
  // The single photo must ALSO reach the student record, otherwise the main
  // student list (which reads the denormalised thumb) never shows it.
  if (key === "photo" || key === "profilePhoto" || key === "selfie") {
    await denormalisePhoto(studentId, file, base64).catch(() => {});
  }
  return true;
};

/** Remove one document field for a student. */
export const removeStudentDocument = async (studentId, key) => {
  const { deleteField } = await import("firebase/firestore");
  await setDoc(doc(db, "studentDocuments", studentId), { [key]: deleteField() }, { merge: true });
  // Clearing the single photo also clears the list avatar.
  if (key === "photo" || key === "profilePhoto" || key === "selfie") {
    try {
      const { updateDoc } = await import("firebase/firestore");
      const wipe = { profilePhotoUrl: deleteField(), photoUrl: deleteField(), updatedAt: new Date().toISOString() };
      await updateDoc(doc(db, "students", studentId), wipe).catch(() => {});
    } catch (_) {}
  }
  return true;
};

/**
 * Tiny avatar copy (~192px, a few dozen KB) written to the student record so
 * the main list, seat map and profile update over the live listener in
 * ~1 second instead of waiting on a ~1MB full-photo write. The full photo
 * always stays in studentDocuments/{id}.photo for viewing/downloading.
 */
const compressThumbnail = (file) => {
  return new Promise((resolve, reject) => {
    if (!String(file.type || "").startsWith("image/")) {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
      return;
    }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const MAX = 192;
      let { width, height } = img;
      if (width > height) { height = Math.round((height / width) * MAX); width = MAX; }
      else { width = Math.round((width / height) * MAX); height = MAX; }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.65));
    };
    img.onerror = reject;
    img.src = url;
  });
};

/**
 * Backfill the list thumbnail from an already-stored full photo.
 * Heals uploads made before the thumbnail system existed: opening the
 * student profile once is enough, no re-upload needed.
 */
export const backfillPhotoThumb = async (studentId, base64) => {
  if (!studentId || !base64 || !String(base64).startsWith("data:")) return false;
  try {
    const blob = await (await fetch(base64)).blob();
    const file = new File([blob], "photo.jpg", { type: blob.type || "image/jpeg" });
    await denormalisePhoto(studentId, file, base64);
    return true;
  } catch (_) {
    return false;
  }
};

/** Write the fast thumbnail onto students/{id} (+ users fallback). */
const denormalisePhoto = async (studentId, file, fullBase64) => {
  let thumb = fullBase64;
  try {
    thumb = await compressThumbnail(file);
  } catch (_) { /* fall back to full image */ }
  const stamp = new Date().toISOString();
  try {
    const { updateDoc } = await import("firebase/firestore");
    await updateDoc(doc(db, "students", studentId), {
      profilePhotoUrl: thumb,
      photoUrl: thumb,
      updatedAt: stamp,
    });
  } catch (e) {
    try {
      const { updateDoc: _upd } = await import("firebase/firestore");
      await _upd(doc(db, "users", studentId), { profilePhotoUrl: thumb, photoUrl: thumb, updatedAt: stamp });
    } catch (_) {}
  }
  return thumb;
};

// Remember the last rendered list so uploads can refresh it
let lastDocRender = { studentId: null, containerId: "student-documents-list" };

/**
 * Render the student's documents with working Preview / Download / Upload / Remove.
 * @param {string} studentId - Student ID
 * @param {string} containerId - Container element ID
 */
export const renderStudentDocuments = async (studentId, containerId = "student-documents-list") => {
  const container = document.getElementById(containerId);
  if (!container) return;
  lastDocRender = { studentId, containerId };

  container.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--text-muted);">Loading documents…</div>`;

  let docs = null;
  try {
    docs = await loadStudentDocuments(studentId);
    if (typeof window !== "undefined") window.__studentDocsCache = docs || {};
  } catch (e) {
    console.error("Failed to load student documents:", e);
    const permission = /permission/i.test((e && e.message) || "");
    container.innerHTML = `<div style="text-align:center;padding:2rem;border:1px dashed var(--border);border-radius:12px;color:#ef4444;">
      ${permission
        ? "You don't have permission to view these documents."
        : "Could not load documents: " + ((e && e.message) || "unknown error")}
    </div>`;
    return;
  }

  let html = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:1rem;">`;

  for (const { key, label, accept, hint } of STUDENT_DOC_FIELDS) {
    const base64 = docs ? docs[key] : null;
    const isImage = typeof base64 === "string" && base64.startsWith("data:image");
    const hasFile = typeof base64 === "string" && base64.length > 0;

    const preview = hasFile
      ? (isImage
        ? `<img src="${base64}" alt="${label}" onclick="window.enlargeDocument(this.src, '${label}')" title="Click to view & enlarge" style="width:100%;height:110px;object-fit:cover;border-radius:8px;background:#000;cursor:pointer;">`
        : `<div style="width:100%;height:110px;border-radius:8px;background:var(--bg-hover);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;">
             <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
             <span style="font-size:11px;color:var(--text-muted);">File</span>
           </div>`)
      : `<div style="width:100%;height:110px;border-radius:8px;border:2px dashed var(--border);display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:12px;text-align:center;padding:8px;">
           No file yet
         </div>`;

    html += `
      <div style="border:1px solid var(--border);border-radius:12px;padding:.75rem;background:var(--bg-card);display:flex;flex-direction:column;gap:.5rem;">
        <div style="overflow:hidden;border-radius:8px;">${preview}</div>
        <div style="font-weight:600;font-size:12px;">${label}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:-4px;">${hint}</div>
        <div style="display:flex;flex-direction:column;gap:.4rem;margin-top:auto;">
          <button type="button" class="btn btn-primary" style="width:100%;font-size:12px;padding:7px;${hasFile ? "" : "opacity:.45;cursor:not-allowed;"}"
            ${hasFile ? `onclick="window.__downloadStudentDoc('${key}')"` : "disabled"}>Download</button>
          <label class="btn btn-secondary" style="width:100%;font-size:12px;padding:7px;margin:0;cursor:pointer;text-align:center;">
            ${containerId === "student-own-documents" ? (hasFile ? "Request Replace" : "Upload Document") : (hasFile ? "Replace" : "Upload")}
            <input type="file" accept="${accept}" style="display:none;"
              onchange="window.__uploadStudentDoc('${studentId}', '${key}', this, '${containerId}')" />
          </label>
          ${containerId === "student-own-documents"
            ? `<div style="font-size:10px; color:var(--text-muted); text-align:center;">Requires Admin Approval</div>`
            : (hasFile ? `<button type="button" class="btn btn-ghost" style="width:100%;font-size:11px;padding:5px;color:#ef4444;"
                onclick="window.__removeStudentDoc('${studentId}', '${key}', '${containerId}')">Remove</button>` : "")}
        </div>
      </div>`;
  }

  html += `</div>`;
  container.innerHTML = html;
};

// ── Global handlers (used by inline onclick/onchange above) ──
if (typeof window !== "undefined") {
  window.__downloadStudentDoc = (key) => {
    const docs = window.__studentDocsCache || {};
    const base64 = docs[key];
    if (!base64) {
      notify("No file uploaded for this item yet.", "error");
      return;
    }
    downloadBase64File(base64, `${key}_${lastDocRender.studentId || "student"}`);
  };

  window.__uploadStudentDoc = async (studentId, key, input, containerId) => {
    const file = input && input.files && input.files[0];
    if (!file) return;

    if (containerId === "student-own-documents") {
      notify(`Compressing and submitting ${file.name} for admin approval…`, "info");
      try {
        const base64 = await compressImage(file);
        const { submitProfileUpdateRequest } = await import("./studentPortalService.js");
        const currentStudent = window.currentStudent || { id: studentId };
        const res = await submitProfileUpdateRequest(currentStudent, { [key]: base64 });
        if (res.success) {
          notify("Document update request submitted! Admin will verify and approve.", "success");
        } else {
          notify("Failed to submit request: " + res.error, "error");
        }
      } catch (err) {
        console.error("Student document change request error:", err);
        notify("Failed: " + (err.message || err), "error");
      } finally {
        if (input) input.value = "";
      }
      return;
    }

    notify(`Uploading ${file.name}…`, "info");
    try {
      await uploadStudentDocument(studentId, key, file);
      notify("Document uploaded successfully!", "success");
      if (input) input.value = "";
      await renderStudentDocuments(studentId, containerId || lastDocRender.containerId);
      // Instant reflection: paint the new photo on the open profile card
      // right away (the main list follows via the live listener).
      if (key === "photo" || key === "profilePhoto" || key === "selfie") {
        const avatarEl = document.getElementById(`sp-avatar-${studentId}`);
        if (avatarEl && file.type.startsWith("image/")) {
          const localUrl = URL.createObjectURL(file);
          avatarEl.innerHTML = `<img src="${localUrl}" style="width:100%; height:100%; object-fit:cover;" alt="Photo" />`;
          avatarEl.style.background = "var(--bg-hover)";
        }
      }
    } catch (e) {
      console.error("Student document upload failed:", e);
      notify("Upload failed: " + ((e && e.message) || "unknown error"), "error");
    }
  };

  window.__removeStudentDoc = async (studentId, key, containerId) => {
    if (containerId === "student-own-documents") {
      notify("Verified documents cannot be deleted directly. Contact library admin.", "error");
      return;
    }
    if (!confirm("Remove this document?")) return;
    try {
      await removeStudentDocument(studentId, key);
      notify("Document removed.", "info");
      await renderStudentDocuments(studentId, containerId || lastDocRender.containerId);
    } catch (e) {
      console.error("Student document delete failed:", e);
      notify("Remove failed: " + ((e && e.message) || "unknown error"), "error");
    }
  };
}

/**
 * Download a base64 document/image
 * @param {string} base64Data - Base64 data URL
 * @param {string} fileName - File name for download
 */
export const downloadBase64File = (base64Data, fileName) => {
  try {
    // Extract mime type and data
    const matches = base64Data.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) {
      // Try direct base64
      const link = document.createElement('a');
      link.href = base64Data;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      return;
    }
    
    const mimeType = matches[1];
    const base64 = matches[2];
    const byteString = atob(base64);
    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);
    for (let i = 0; i < byteString.length; i++) {
      ia[i] = byteString.charCodeAt(i);
    }
    const blob = new Blob([ab], { type: mimeType });
    const url = URL.createObjectURL(blob);
    
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  } catch (e) {
    console.error("Download failed:", e);
    // Fallback
    const link = document.createElement('a');
    link.href = base64Data;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
};

// ──────────────────────────────────────────────
// UI rendering
// ──────────────────────────────────────────────

const DOC_TYPES = [
  {
    key: "aadhaarFront",
    label: "Aadhaar Front",
    sub: "Click to select",
    accept: "image/*,.pdf",
    iconSvg: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg>`
  },
  {
    key: "aadhaarBack",
    label: "Aadhaar Back",
    sub: "Click to select",
    accept: "image/*,.pdf",
    iconSvg: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect width="20" height="14" x="2" y="5" rx="2"/><circle cx="8" cy="12" r="2"/><line x1="14" x2="18" y1="11" y2="11"/><line x1="14" x2="18" y1="14" y2="14"/></svg>`
  },
  {
    // ONE photo only — upload a file OR take a live selfie, both land in
    // the same `photo` field.
    key: "photo",
    label: "Photo",
    sub: "Upload or take selfie",
    accept: "image/*",
    iconSvg: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>`
  },
  {
    // Its OWN card. File upload ONLY — a payment screenshot (SS), never a
    // live selfie, so there is deliberately no camera / Take Selfie button.
    key: "paymentScreenshot",
    label: "Payment screenshot",
    sub: "Upload screenshot file",
    accept: "image/*,.pdf",
    iconSvg: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 3h16v18l-3-2-2 2-3-2-3 2-2-2-3 2z"/><path d="M8 8h8"/><path d="M8 12h8"/><path d="M8 16h5"/></svg>`
  },
];

/**
 * Render the document upload UI inside container.
 *
 * @param {string} containerId
 * @param {Object} [opts]
 * @param {string[]} [opts.keys] render ONLY these cards (e.g. the payment
 *   step renders just `paymentScreenshot` instead of the whole set).
 * @param {string}  [opts.title] heading text
 * @param {string}  [opts.note]  heading's trailing note
 */
export const initDocumentUploads = (containerId = "doc-upload-section", opts = {}) => {
  const container = document.getElementById(containerId);
  if (!container) return;

  const keys = Array.isArray(opts.keys) && opts.keys.length ? opts.keys : null;
  const types = keys ? DOC_TYPES.filter(d => keys.indexOf(d.key) !== -1) : DOC_TYPES;
  const title = opts.title || "Document Uploads";
  const note = opts.note || "(Optional · stored securely)";

  container.innerHTML = `
    <label style="display:block;font-size:12.5px;font-weight:600;color:var(--text-secondary);
      text-transform:uppercase;letter-spacing:.04em;margin-bottom:.75rem;">
      ${title}
      <span style="color:var(--text-muted);font-weight:400;text-transform:none;margin-left:4px;">
        ${note}
      </span>
    </label>
    <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(130px, 1fr));gap:0.75rem;">
      ${types.map(d => {
    if (d.key === "photo") {
      // Single photo card: click uploads a file, dedicated button takes a
      // live selfie — both write the SAME photo field. No duplicates.
      return `
            <div id="doc-card-${d.key}" style="
              border:2px dashed var(--border-bright);border-radius:12px;padding:1rem .75rem;
              text-align:center;transition:border-color .2s,background .2s;
              position:relative;background:rgba(255,255,255,.02);"
              onclick="document.getElementById('doc-input-${d.key}').click()">
              <input type="file" id="doc-input-${d.key}" accept="${d.accept}"
                style="display:none;" data-key="${d.key}" />
              <div id="doc-preview-${d.key}" style="display:none;margin-bottom:.5rem;position:relative;">
                <img id="doc-img-${d.key}" style="width:100%;height:76px;object-fit:cover;
                  border-radius:8px;cursor:pointer;" src="" alt="preview" onclick="event.stopPropagation();window.enlargeDocument(this.src, '${d.label}')" title="Click to view & enlarge" />
                <button type="button"
                  onclick="event.stopPropagation();window.__clearDocUpload('${d.key}')"
                  style="position:absolute;top:3px;right:3px;background:rgba(244,63,94,.9);
                  border:none;color:#fff;width:20px;height:20px;border-radius:50%;font-size:12px;
                  cursor:pointer;line-height:1;">✕</button>
              </div>
              <div id="doc-placeholder-${d.key}">
                <div style="display:flex;justify-content:center;margin-bottom:.4rem;color:var(--primary);">${d.iconSvg}</div>
                <div style="font-size:12px;font-weight:600;color:var(--text-primary);">${d.label}</div>
                <div id="doc-sublabel-${d.key}" style="font-size:11px;color:var(--text-muted);margin-top:2px;">${d.sub || "Upload or take selfie"}</div>
              </div>
              <div id="doc-name-${d.key}" style="font-size:11px;color:var(--accent-emerald);
                margin-top:.3rem;display:none;word-break:break-all;"></div>
              <div style="display:flex;gap:.4rem;margin-top:.6rem;">
                <button type="button" onclick="event.stopPropagation();document.getElementById('doc-input-${d.key}').click()"
                  style="flex:1;padding:8px 6px;border-radius:9px;border:1px solid var(--border-bright);
                  background:var(--bg-hover);color:var(--text-primary);font-size:12px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:5px;"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> ${window.t ? window.t("common.upload", "Upload") : "Upload"}</button>
                <button type="button" onclick="event.stopPropagation();window.__openSelfieCamera()"
                  style="flex:1;padding:8px 6px;border-radius:9px;border:1px solid transparent;
                  background:var(--accent-emerald,#10b981);color:#fff;font-size:12px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:5px;"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg> ${window.t ? window.t("common.selfie", "Selfie") : "Selfie"}</button>
              </div>
            </div>
          `;
    } else {
      return `
            <div id="doc-card-${d.key}" style="
              border:2px dashed var(--border-bright);border-radius:12px;padding:1rem .75rem;
              text-align:center;cursor:pointer;transition:border-color .2s,background .2s;
              position:relative;background:rgba(255,255,255,.02);"
              onclick="document.getElementById('doc-input-${d.key}').click()">
              <input type="file" id="doc-input-${d.key}" accept="${d.accept}"
                style="display:none;" data-key="${d.key}" />
              <div id="doc-preview-${d.key}" style="display:none;margin-bottom:.5rem;position:relative;">
                <img id="doc-img-${d.key}" style="width:100%;height:76px;object-fit:cover;
                  border-radius:8px;cursor:pointer;" src="" alt="preview" onclick="event.stopPropagation();window.enlargeDocument(this.src, '${d.label}')" title="Click to view & enlarge" />
                <button type="button"
                  onclick="event.stopPropagation();window.__clearDocUpload('${d.key}')"
                  style="position:absolute;top:3px;right:3px;background:rgba(244,63,94,.9);
                  border:none;color:#fff;width:20px;height:20px;border-radius:50%;font-size:12px;
                  cursor:pointer;line-height:1;">✕</button>
              </div>
              <div id="doc-placeholder-${d.key}">
                <div style="display:flex;justify-content:center;margin-bottom:.4rem;color:var(--primary);">${d.iconSvg}</div>
                <div style="font-size:12px;font-weight:600;color:var(--text-primary);">${d.label}</div>
                <div id="doc-sublabel-${d.key}" style="font-size:11px;color:var(--text-muted);margin-top:2px;">${d.sub || "Click to select"}</div>
              </div>
              <div id="doc-name-${d.key}" style="font-size:11px;color:var(--accent-emerald);
                margin-top:.3rem;display:none;word-break:break-all;"></div>
            </div>
          `;
    }
  }).join("")}
    </div>

    <!-- Upload progress bar -->
    <div id="doc-upload-progress" style="display:none;margin-top:.75rem;">
      <div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px;">
        Saving documents… <span id="doc-progress-pct">0</span>%
      </div>
      <div style="height:4px;background:rgba(255,255,255,.08);border-radius:99px;overflow:hidden;">
        <div id="doc-progress-bar" style="height:100%;width:0%;
          background:linear-gradient(90deg,#8b5cf6,#10b981);transition:width .25s;"></div>
      </div>
    </div>
  `;

  // Ensure camera modal exists in the body
  if (!document.getElementById("selfie-camera-modal")) {
    const modalDiv = document.createElement("div");
    modalDiv.innerHTML = `
      <dialog id="selfie-camera-modal" class="selfie-modal">
        <style>
          #selfie-camera-modal.selfie-modal { padding:0; border:none; border-radius:16px; width:calc(100vw - 32px); max-width:420px; margin:auto; background:var(--bg-card,#fff); color:var(--text-primary,#0f172a); box-shadow:0 24px 64px rgba(0,0,0,.45); overflow:hidden; }
          #selfie-camera-modal.selfie-modal::backdrop { background:rgba(2,8,23,.6); backdrop-filter:blur(6px); }
          #selfie-camera-modal .selfie-head { display:flex; align-items:center; gap:.75rem; padding:1rem 1.25rem; border-bottom:1px solid var(--border,#e2e8f0); }
          #selfie-camera-modal .selfie-ico { width:38px; height:38px; border-radius:12px; flex:0 0 38px; display:flex; align-items:center; justify-content:center; background:rgba(16,185,129,.14); color:var(--accent-emerald,#10b981); }
          #selfie-camera-modal .selfie-title { font-size:1rem; font-weight:700; margin:0; line-height:1.2; }
          #selfie-camera-modal .selfie-sub { font-size:12px; color:var(--text-muted,#64748b); margin-top:2px; }
          #selfie-camera-modal .selfie-x { margin-left:auto; width:30px; height:30px; border-radius:50%; border:1px solid var(--border,#e2e8f0); background:transparent; color:var(--text-muted,#64748b); font-size:16px; line-height:1; cursor:pointer; display:flex; align-items:center; justify-content:center; }
          #selfie-camera-modal .selfie-x:hover { background:var(--bg-hover,#f1f5f9); color:var(--text-primary,#0f172a); }
          #selfie-camera-modal .selfie-body { padding:1.25rem; }
          #selfie-camera-modal .selfie-frame { position:relative; background:#020817; border-radius:14px; overflow:hidden; border:1px solid var(--border,#e2e8f0); aspect-ratio:4/3; display:flex; align-items:center; justify-content:center; }
          #selfie-camera-modal .selfie-frame video { width:100%; height:100%; object-fit:cover; display:block; transform:scaleX(-1); }
          #selfie-camera-modal .selfie-guide { position:absolute; inset:0; pointer-events:none; display:flex; align-items:center; justify-content:center; }
          #selfie-camera-modal .selfie-guide::before { content:""; width:52%; aspect-ratio:3/4; border:2px dashed rgba(255,255,255,.75); border-radius:999px; box-shadow:0 0 0 999px rgba(2,8,23,.28); }
          #selfie-camera-modal .selfie-hint { font-size:12px; color:var(--text-muted,#64748b); text-align:center; margin:.8rem 0 0; line-height:1.5; }
          #selfie-camera-modal .selfie-actions { display:flex; gap:.6rem; margin-top:1.1rem; }
          #selfie-camera-modal .selfie-actions .btn { flex:1; justify-content:center; padding:.7rem 1rem; border-radius:10px; font-size:13.5px; }
          @media (max-width:420px){ #selfie-camera-modal .selfie-body{padding:1rem;} }
        </style>
        <div class="selfie-head">
          <div class="selfie-ico"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg></div>
          <div>
            <h2 class="selfie-title">Take a selfie</h2>
            <div class="selfie-sub">Center your face in the oval · good lighting works best</div>
          </div>
          <button type="button" class="selfie-x" onclick="window.__closeSelfieCamera()" aria-label="Close">✕</button>
        </div>
        <div class="selfie-body">
          <div class="selfie-frame">
             <video id="selfie-video" autoplay muted playsinline></video>
             <div class="selfie-guide"></div>
          </div>
          <p class="selfie-hint">This becomes your admission photo — one photo only. You can retake or upload a file instead.</p>
          <div class="selfie-actions">
            <button type="button" class="btn btn-ghost" onclick="window.__closeSelfieCamera()">Cancel</button>
            <button type="button" class="btn btn-primary" onclick="window.__captureSelfie()"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg> Capture</button>
          </div>
        </div>
      </dialog>
    `;
    document.body.appendChild(modalDiv.firstElementChild);
  }

  // Wire each file input (photo card has BOTH upload input and selfie button)
  DOC_TYPES.forEach(({ key }) => {
    const input = document.getElementById(`doc-input-${key}`);
    if (!input) return;
    input.addEventListener("change", () => {
      const file = input.files[0];
      if (!file) return;
      // A manually picked file replaces any earlier live selfie — one photo.
      if (key === "photo") capturedSelfieFile = null;
      const img = document.getElementById(`doc-img-${key}`);
      const preview = document.getElementById(`doc-preview-${key}`);
      const placeholder = document.getElementById(`doc-placeholder-${key}`);
      const nameEl = document.getElementById(`doc-name-${key}`);
      const card = document.getElementById(`doc-card-${key}`);

      if (file.type.startsWith("image/")) {
        img.src = URL.createObjectURL(file);
        preview.style.display = "block";
        placeholder.style.display = "none";
      } else {
        preview.style.display = "none";
        placeholder.style.display = "block";
      }
      nameEl.textContent = file.name;
      nameEl.style.display = "block";
      card.style.borderColor = "var(--accent-emerald)";
      card.style.background = "rgba(16,185,129,.06)";
    });
  });

  // Hydrate any pre-existing documents on file
  const existingDocs = opts.existingDocs || {};
  DOC_TYPES.forEach(({ key, label }) => {
    let existingVal = existingDocs[key] || existingDocs[`${key}Url`];
    if (key === "photo" && !existingVal) {
      existingVal = existingDocs.selfie || existingDocs.profilePhoto || existingDocs.profilePhotoUrl;
    }
    if (existingVal && typeof existingVal === "string" && existingVal.trim().length > 0) {
      const img = document.getElementById(`doc-img-${key}`);
      const preview = document.getElementById(`doc-preview-${key}`);
      const placeholder = document.getElementById(`doc-placeholder-${key}`);
      const nameEl = document.getElementById(`doc-name-${key}`);
      const card = document.getElementById(`doc-card-${key}`);

      if (img && preview && placeholder && nameEl && card) {
        const isRenderable = existingVal.startsWith("data:") || existingVal.startsWith("http://") || existingVal.startsWith("https://") || existingVal.startsWith("/");
        if (isRenderable) {
          img.src = existingVal;
          preview.style.display = "block";
          placeholder.style.display = "none";
        }
        nameEl.innerHTML = `<span style="display:inline-flex;align-items:center;gap:4px;font-weight:600;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          ${window.t ? window.t("onb.uploadedOnFile", "Uploaded & verified on file") : "Uploaded & verified on file"}
        </span>`;
        nameEl.style.display = "block";
        nameEl.style.color = "var(--accent-emerald, #10b981)";
        card.style.borderColor = "var(--accent-emerald, #10b981)";
        card.style.background = "rgba(16,185,129,.06)";
      }
    }
  });

  // Global handlers for selfie camera
  window.__openSelfieCamera = async () => {
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert("Camera access requires a secure connection. Please access the site via HTTPS or localhost to use the live selfie feature.");
      return;
    }

    const modal = document.getElementById("selfie-camera-modal");
    const video = document.getElementById("selfie-video");
    modal.showModal();
    try {
      selfieStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } });
      video.srcObject = selfieStream;
    } catch (err) {
      alert("Camera permission is required to capture your selfie.");
      window.__closeSelfieCamera();
    }
  };

  window.__closeSelfieCamera = () => {
    const modal = document.getElementById("selfie-camera-modal");
    const video = document.getElementById("selfie-video");
    if (selfieStream) {
      selfieStream.getTracks().forEach(track => track.stop());
      selfieStream = null;
    }
    video.srcObject = null;
    modal.close();
  };

  window.__captureSelfie = () => {
    const video = document.getElementById("selfie-video");
    if (!selfieStream) return;

    // Draw to canvas
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 480;
    canvas.height = video.videoHeight || 640;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Convert to file (single canonical photo)
    canvas.toBlob((blob) => {
      const file = new File([blob], "photo.jpg", { type: "image/jpeg" });
      capturedSelfieFile = file;

      // Update UI
      const key = "photo";
      const img = document.getElementById(`doc-img-${key}`);
      const preview = document.getElementById(`doc-preview-${key}`);
      const placeholder = document.getElementById(`doc-placeholder-${key}`);
      const nameEl = document.getElementById(`doc-name-${key}`);
      const card = document.getElementById(`doc-card-${key}`);

      if (!img || !preview || !placeholder || !nameEl || !card) {
        window.__closeSelfieCamera();
        return;
      }
      img.src = URL.createObjectURL(file);
      preview.style.display = "block";
      placeholder.style.display = "none";
      nameEl.textContent = "Selfie captured — click card to replace";
      nameEl.style.display = "block";
      card.style.borderColor = "var(--accent-emerald)";
      card.style.background = "rgba(16,185,129,.06)";

      window.__closeSelfieCamera();
    }, "image/jpeg", 0.9);
  };

  // Clear handler (global so inline onclick works)
  window.__clearDocUpload = (key) => {
    if (key === "photo") {
      capturedSelfieFile = null;
      const inp = document.getElementById(`doc-input-${key}`);
      if (inp) inp.value = "";
    } else {
      const inp = document.getElementById(`doc-input-${key}`);
      if (inp) inp.value = "";
    }
    const prev = document.getElementById(`doc-preview-${key}`);
    if (prev) prev.style.display = "none";
    const ph = document.getElementById(`doc-placeholder-${key}`);
    if (ph) ph.style.display = "block";
    const nameEl = document.getElementById(`doc-name-${key}`);
    if (nameEl) {
      nameEl.style.display = "none";
      nameEl.textContent = "";
    }
    const card = document.getElementById(`doc-card-${key}`);
    if (card) {
      card.style.borderColor = "";
      card.style.background = "";
    }
    if (opts.existingDocs) {
      delete opts.existingDocs[key];
      delete opts.existingDocs[`${key}Url`];
      if (key === "photo") {
        delete opts.existingDocs.selfie;
        delete opts.existingDocs.profilePhoto;
        delete opts.existingDocs.profilePhotoUrl;
      }
    }
  };
};

/**
 * Collect the selected File objects from the upload UI.
 * Single photo: file-input choice and live-selfie capture are merged —
 * the selfie wins if both are present, so only ONE photo is ever stored.
 * (`selfie` alias kept so older callers keep working.)
 * @returns {{ aadhaarFront: File|null, aadhaarBack: File|null, photo: File|null, selfie: File|null }}
 */
export const getSelectedDocumentFiles = () => {
  const getFile = (id) => {
    const el = document.getElementById(id);
    return el && el.files && el.files[0] ? el.files[0] : null;
  };
  const uploaded = getFile("doc-input-photo");
  const photo = capturedSelfieFile || uploaded || null;
  return {
    aadhaarFront: getFile("doc-input-aadhaarFront"),
    aadhaarBack: getFile("doc-input-aadhaarBack"),
    photo,
    selfie: photo, // legacy alias
    paymentScreenshot: getFile("doc-input-paymentScreenshot"),
  };
};

/**
 * Update the progress bar UI.
 * @param {number} pct - 0 to 100
 */
export const setUploadProgress = (pct) => {
  const wrap = document.getElementById("doc-upload-progress");
  const bar = document.getElementById("doc-progress-bar");
  const label = document.getElementById("doc-progress-pct");
  if (!wrap) return;
  wrap.style.display = (pct > 0 && pct <= 100) ? "block" : "none";
  if (bar) bar.style.width = pct + "%";
  if (label) label.textContent = pct;
};

// ──────────────────────────────────────────────
// Profile photo (student portal)
// Stored as compressed base64 so it works on the Spark plan (no Storage).
// Saved to studentDocuments/{uid}.photo (canonical, single photo) and
// denormalised to students/{uid}.profilePhotoUrl / photoUrl so every
// avatar picks it up. Legacy `profilePhoto` / `selfie` fields are left
// untouched for old records (read-only fallback, never written).
// ──────────────────────────────────────────────

/**
 * Upload / replace the student's photo (single photo).
 * @param {File} file - image file (JPG/PNG, ideally < 2MB before compression)
 * @param {string} studentId - students/{uid}
 * @returns {Promise<{success: boolean, url?: string, error?: string}>}
 */
export const uploadProfilePhoto = async (file, studentId) => {
  try {
    if (!file) throw new Error("No file selected.");
    if (!studentId) throw new Error("Missing student ID.");
    if (!String(file.type || "").startsWith("image/")) throw new Error("Please select an image file (JPG/PNG).");
    if (file.size > 10 * 1024 * 1024) throw new Error("Image is too large. Maximum 10 MB.");

    const base64 = await compressImage(file);
    if (!base64 || base64.length < 100) throw new Error("Could not read image. Please try another file.");

    const stamp = new Date().toISOString();
    // 1. Canonical copy in studentDocuments (viewable by staff + self per rules)
    await setDoc(
      doc(db, "studentDocuments", studentId),
      { studentId, photo: base64, updatedAt: stamp },
      { merge: true }
    );

    // 2. Fast thumbnail on the student doc for instant list/avatar rendering
    // (full photo stays in studentDocuments for viewing/downloading).
    await denormalisePhoto(studentId, file, base64).catch(() => {});

    return { success: true, url: base64 };
  } catch (e) {
    console.warn("[profile-photo] upload failed:", e);
    return { success: false, error: (e && e.message) || "Upload failed." };
  }
};

/**
 * Legacy alias — older portal code imports this name.
 * Kept as a no-op wrapper so the import never breaks.
 */
export const initializePhotoUpload = async () => ({ success: true });
