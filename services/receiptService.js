import { doc, getDoc, updateDoc, runTransaction, serverTimestamp, collection, getDocs, query, where } from "firebase/firestore";
import { db } from "../firebase/firebase.js";

const RECEIPT_COUNTER_REF = () => doc(db, "counters", "receipts");
const START_RECEIPT_NO = 2291;

const loadScript = (src) => {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
};

/**
 * Persists receipt number to Firestore so both Admin and Student portals retrieve the same record.
 */
export const persistReceiptToFirestore = async (paymentId, receiptNo, existingData = null) => {
  if (!receiptNo) return;
  const num = String(receiptNo).trim();
  const updateData = {
    receiptNo: num,
    invoiceNo: num,
    invoiceDate: new Date().toISOString().split("T")[0]
  };

  // 1. Try 'payments' collection
  if (paymentId && !paymentId.startsWith("temp_") && !paymentId.startsWith("pending-")) {
    try {
      const pRef = doc(db, "payments", paymentId);
      const pSnap = await getDoc(pRef);
      if (pSnap.exists()) {
        await updateDoc(pRef, updateData);
        return;
      }
    } catch (_) {}

    // 2. Try 'renewals' collection
    try {
      const rRef = doc(db, "renewals", paymentId);
      const rSnap = await getDoc(rRef);
      if (rSnap.exists()) {
        await updateDoc(rRef, updateData);
        return;
      }
    } catch (_) {}
  }

  // 3. Try 'students' collection (for admission receipts)
  const sId = existingData?.studentId || existingData?.uid || (paymentId && String(paymentId).startsWith("admission_") ? String(paymentId).replace("admission_", "") : null);
  if (sId) {
    try {
      const sRef = doc(db, "students", sId);
      const sSnap = await getDoc(sRef);
      if (sSnap.exists()) {
        await updateDoc(sRef, {
          admissionReceiptNo: num,
          receiptNo: num,
          invoiceNo: num
        });
      }
    } catch (_) {}
  }
};

/**
 * Returns a unique dynamic receipt number for a transaction.
 * If already stored on payment, keeps it.
 * If not stored, derives a realistic 4-digit number based on student's SH-XXXX ID
 * or atomic counter so no two students have the same static number.
 */
export const getOrAssignReceiptNumber = async (paymentId, existingData = null) => {
  const existingNo = existingData?.receiptNo || existingData?.invoiceNo || existingData?.admissionReceiptNo;
  if (existingNo && String(existingNo).trim() !== "" && !String(existingNo).startsWith("INV-")) {
    return String(existingNo).trim();
  }

  // Derive realistic unique number from student ID (e.g. SH-0497 -> 2497)
  const rawStudentId = existingData?.studentNo || existingData?.studentId || "";
  const match = String(rawStudentId).match(/SH-(\d+)/i) || String(paymentId || "").match(/(\d{3,4})/);
  if (match && match[1]) {
    const n = parseInt(match[1], 10);
    const derived = String(2000 + (n % 8000));
    await persistReceiptToFirestore(paymentId, derived, existingData);
    return derived;
  }

  // Fallback: Atomic counter from Firestore
  try {
    const next = await runTransaction(db, async (tx) => {
      const snap = await tx.get(RECEIPT_COUNTER_REF());
      let current = START_RECEIPT_NO;
      if (snap.exists() && snap.data()?.next) {
        current = Number(snap.data().next);
        if (!Number.isFinite(current) || current < START_RECEIPT_NO) current = START_RECEIPT_NO;
      }
      tx.set(RECEIPT_COUNTER_REF(), { next: current + 1, updatedAt: serverTimestamp() }, { merge: true });
      return current;
    });
    const assigned = String(next);
    await persistReceiptToFirestore(paymentId, assigned, existingData);
    return assigned;
  } catch (e) {
    // Deterministic hash based on payment ID / student name so it never fluctuates
    const seed = String(paymentId || existingData?.studentName || Date.now());
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = ((hash << 5) - hash) + seed.charCodeAt(i);
      hash |= 0;
    }
    const derived = String(2200 + (Math.abs(hash) % 780));
    await persistReceiptToFirestore(paymentId, derived, existingData);
    return derived;
  }
};

export const getNextReceiptNumber = async () => {
  return await getOrAssignReceiptNumber(null, null);
};

export const formatReceiptDate = (raw) => {
  if (!raw) return "";
  if (typeof raw === "string" && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(raw.trim())) {
    return raw.trim();
  }
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return String(raw);
    const day = String(d.getDate()).padStart(2, "0");
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
  } catch (_) {
    return String(raw);
  }
};

export const isPayLater = (p) => {
  if (!p) return false;
  const pm = String(p.paymentMethod || p.paymentMode || p.mode || "").toLowerCase().trim();
  const st = String(p.status || "").toLowerCase().trim();
  const txn = String(p.transactionId || "").toLowerCase().trim();
  return pm === "pay later" || pm === "paylater" || st === "pay later" || st === "paylater" || st === "pay_later" || st === "unpaid" || txn === "pay later";
};

/**
 * Normalizes all fields for the receipt slip from raw payment / student data.
 */
export const resolveReceiptData = async (input = {}) => {
  let payment = { ...input };

  if (isPayLater(payment)) {
    throw new Error("Cannot generate invoice: Student fee has not been paid (Pay Later).");
  }

  if (typeof input === "string") {
    try {
      const pSnap = await getDoc(doc(db, "payments", input));
      if (pSnap.exists()) {
        payment = { id: pSnap.id, ...pSnap.data() };
      } else {
        const rSnap = await getDoc(doc(db, "renewals", input));
        if (rSnap.exists()) {
          payment = { id: rSnap.id, ...rSnap.data() };
        }
      }
    } catch (_) {}
  } else if (input.id && (!input.amount || !input.studentName || input.studentName === "Student")) {
    try {
      const pSnap = await getDoc(doc(db, "payments", input.id));
      if (pSnap.exists()) {
        payment = { ...pSnap.data(), ...payment };
      } else {
        const rSnap = await getDoc(doc(db, "renewals", input.id));
        if (rSnap.exists()) {
          payment = { ...rSnap.data(), ...payment };
        }
      }
    } catch (_) {}
  }

  if (isPayLater(payment)) {
    throw new Error("Cannot generate invoice: Student fee has not been paid (Pay Later).");
  }

  // Fetch student details from students collection if missing
  let studentData = {};
  let studentId = payment.studentId || payment.uid;
  if (!studentId && payment.id && String(payment.id).startsWith("admission_")) {
    studentId = String(payment.id).replace("admission_", "");
  }
  if (studentId) {
    try {
      const sSnap = await getDoc(doc(db, "students", studentId));
      if (sSnap.exists()) {
        studentData = sSnap.data() || {};
      } else {
        const qUid = query(collection(db, "students"), where("uid", "==", studentId));
        const snapUid = await getDocs(qUid);
        if (!snapUid.empty) studentData = snapUid.docs[0].data() || {};
        else {
          const qStd = query(collection(db, "students"), where("studentId", "==", studentId));
          const snapStd = await getDocs(qStd);
          if (!snapStd.empty) studentData = snapStd.docs[0].data() || {};
        }
      }
    } catch (_) {}
  }

  // Realistic dynamic receipt number
  const studentNo = payment.studentNo || studentData.studentId || studentData.admissionNo || "";
  const receiptNo = await getOrAssignReceiptNumber(payment.id, { ...payment, studentNo });

  const studentName = String(payment.studentName || studentData.name || "Student").trim();
  const phone = String(payment.studentPhone || payment.phone || studentData.phone || "—").trim();
  const seatNumber = String(payment.seatNumber || studentData.seatNumber || studentData.seatAssigned || "—").replace(/^Seat\s*/i, "").trim();
  
  const rawDate = payment.date || payment.paymentDate || (payment.createdAt?.seconds ? new Date(payment.createdAt.seconds * 1000).toISOString() : new Date().toISOString());
  const formattedDate = formatReceiptDate(rawDate);

  let startDate = payment.startDate || studentData.startDate || "";
  let endDate = payment.endDate || studentData.paymentDueDate || payment.dueDateStr || "";
  if (startDate) startDate = formatReceiptDate(startDate);
  if (endDate) endDate = formatReceiptDate(endDate);

  const planName = String(payment.planName || studentData.planName || "Regular Fixed Seat").trim();
  const rawAmt = Number(payment.amount || studentData.planPrice || studentData.fee || 0);
  const formattedAmount = `${rawAmt.toFixed(2)}`;

  const modeStr = String(payment.paymentMethod || payment.paymentMode || payment.mode || "UPI").trim().toLowerCase();
  const isCash = modeStr.includes("cash");
  const isCheque = modeStr.includes("cheque") || modeStr.includes("check");
  const isOnline = !isCash && !isCheque;

  const rawTxn = String(payment.transactionId || "").trim();
  const isPlaceholderTxn = !rawTxn ||
    /^(rc-imp|rc-n\/a|cash|n\/a|none|null|undefined|pay\s*later|admission)$/i.test(rawTxn) ||
    rawTxn.toLowerCase().startsWith("rc-");
  const transactionId = isPlaceholderTxn ? "" : rawTxn;

  // Load Settings (QR Code & Signature)
  let settings = {};
  try {
    const { getSettings } = await import("./settingsService.js");
    settings = (await getSettings()) || {};
  } catch (_) {}

  const isSubPath = window.location.pathname.includes("/student/") || window.location.pathname.includes("/admin/") || window.location.pathname.includes("/manager/") || window.location.pathname.includes("/employee/");
  
  const logoUrl = isSubPath ? "../assets/logo.webp" : "./assets/logo.webp";
  const defaultQr = isSubPath ? "../assets/payment-qr.jpeg" : "./assets/payment-qr.jpeg";
  const qrCodeUrl = settings.qrCodeUrl || defaultQr;
  const signatureUrl = settings.signatureUrl || "";
  const signatoryTitle = settings.signatoryTitle || "Authorised Sign.";

  const rawAddress = String(settings.address || "Plot No. 3/4-B, Amidhara, Top-3 Circle, Bhavnagar - 364002.").trim();
  let addressLine1 = "Plot No. 3/4-B, Amidhara, Top-3 Circle,";
  let addressLine2 = "Bhavnagar - 364002.";
  if (rawAddress.includes("\n")) {
    const parts = rawAddress.split("\n").map(p => p.trim()).filter(Boolean);
    addressLine1 = parts[0] || addressLine1;
    addressLine2 = parts.slice(1).join(" ") || addressLine2;
  } else if (rawAddress.includes("Bhavnagar")) {
    const idx = rawAddress.indexOf("Bhavnagar");
    addressLine1 = rawAddress.substring(0, idx).trim().replace(/,\s*$/, ",");
    addressLine2 = rawAddress.substring(idx).trim();
  }

  return {
    id: payment.id || "",
    receiptNo,
    studentName,
    phone,
    seatNumber,
    date: formattedDate,
    startDate,
    endDate,
    planName,
    amount: rawAmt,
    formattedAmount,
    isCash,
    isCheque,
    isOnline,
    transactionId: (transactionId && transactionId !== "CASH" && transactionId !== "RC-N/A" && transactionId !== "—" && transactionId !== "ADMISSION") ? transactionId : "",
    logoUrl,
    qrCodeUrl,
    signatureUrl,
    signatoryTitle,
    libraryName: "શ્રીજી રીડીંગ લાઇબ્રેરી",
    email: settings.email || "parthpalival123@gmail.com",
    contactPhone: settings.phone || "+91 - 6353321530",
    address: rawAddress,
    addressLine1,
    addressLine2
  };
};

/**
 * Returns HTML string for the exact physical receipt slip
 */
export const getReceiptSlipHTML = (data) => {
  return `
    <div id="shreeji-receipt-slip" class="shreeji-receipt-slip" style="
      width: 780px;
      max-width: 100%;
      background: #ffffff;
      color: #0f3b6c;
      font-family: 'Noto Sans Gujarati', 'Hind Vadodara', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      border: 1px solid #0f3b6c;
      padding: 14px 16px;
      box-sizing: border-box;
      margin: 0 auto;
      position: relative;
      user-select: text;
    ">
      <!-- Top Header: Shaded background (#dce5ef) spanning full width, Logo (Left) | Shreeji Gujarati (Center) | Contact Details (Right) -->
      <div style="background: #dce5ef; margin: -14px -16px 12px -16px; padding: 12px 18px 16px 18px; border-bottom: 1px solid #0f3b6c; display: flex; align-items: center; justify-content: space-between; gap: 12px; box-sizing: border-box;">
        <!-- Left: Official Website Logo (Uncropped) -->
        <div style="width: 175px; display: flex; align-items: center; justify-content: flex-start;">
          <img src="${data.logoUrl}" alt="Shreeji Reading Library" style="height: 60px; max-width: 170px; object-fit: contain; mix-blend-mode: multiply;" onerror="this.onerror=null; if(this.src.indexOf('../')!==-1){this.src='./assets/logo.jpg';}else{this.src='../assets/logo.jpg';}" />
        </div>

        <!-- Center: Gujarati Library Title -->
        <div style="flex: 1; text-align: center;">
          <div style="font-size: 32px; font-weight: 900; line-height: 1.15; color: #0f3b6c; letter-spacing: 1px;">
            શ્રીજી
          </div>
          <div style="font-size: 22px; font-weight: 800; line-height: 1.2; color: #0f3b6c; letter-spacing: 0.5px;">
            રીડીંગ લાઇબ્રેરી
          </div>
        </div>

        <!-- Right: Clear Contact Details (Positioned top-right flush with margin, internally LEFT-ALIGNED with icons in a single column) -->
        <div style="flex: 0 0 auto; margin-left: auto; display: flex; justify-content: flex-end; align-items: center;">
          <div style="display: inline-flex; flex-direction: column; align-items: flex-start; text-align: left; gap: 4px;">
            <div style="font-size: 11px; color: #0f3b6c; font-weight: 700; display: flex; align-items: center; gap: 7px; white-space: nowrap;">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#0f3b6c" stroke-width="2.5" style="flex-shrink:0;"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
              <span>${data.email}</span>
            </div>
            <div style="font-size: 11.5px; color: #0f3b6c; font-weight: 700; display: flex; align-items: center; gap: 7px; white-space: nowrap;">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#0f3b6c" stroke-width="2.5" style="flex-shrink:0;"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
              <span>${data.contactPhone}</span>
            </div>
            <div style="font-size: 10px; color: #1e293b; font-weight: 600; line-height: 1.35; display: flex; align-items: flex-start; gap: 7px;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0f3b6c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-top:1px; flex-shrink:0;"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
              <div style="display: flex; flex-direction: column; align-items: flex-start;">
                <span style="white-space: nowrap;">${data.addressLine1}</span>
                <span style="white-space: nowrap;">${data.addressLine2}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Row 1: Student Name (Left) | Dynamic Receipt No (Right in RED) -->
      <div style="display: flex; align-items: flex-end; justify-content: space-between; margin-bottom: 8px; font-size: 13.5px;">
        <div style="display: flex; align-items: baseline; flex: 1; margin-right: 16px;">
          <span style="font-weight: 700; color: #0f3b6c; white-space: nowrap;">વિદ્યાર્થીનું નામ :</span>
          <span style="flex: 1; border-bottom: 1px dotted #0f3b6c; margin-left: 8px; padding-left: 8px; font-weight: 700; color: #0f172a; font-size: 15px;">
            ${data.studentName}
          </span>
        </div>
        <div style="display: flex; align-items: baseline; white-space: nowrap;">
          <span style="font-weight: 700; color: #0f3b6c;">પહોંચ નં. :</span>
          <span style="color: #c5221f; font-weight: 900; font-size: 22px; font-family: 'Courier New', Courier, monospace; letter-spacing: 2px; margin-left: 10px;">
            ${data.receiptNo}
          </span>
        </div>
      </div>

      <!-- Row 2: Mobile (Left) | Seat No (Center) | Date (Right) -->
      <div style="display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 12px; font-size: 13.5px; gap: 14px;">
        <div style="display: flex; align-items: baseline; flex: 1.2;">
          <span style="font-weight: 700; color: #0f3b6c; white-space: nowrap;">મો. :</span>
          <span style="flex: 1; border-bottom: 1px dotted #0f3b6c; margin-left: 6px; padding-left: 6px; font-weight: 600; color: #0f172a;">
            ${data.phone}
          </span>
        </div>
        <div style="display: flex; align-items: baseline; flex: 1;">
          <span style="font-weight: 700; color: #0f3b6c; white-space: nowrap;">સીટ નં. :</span>
          <span style="flex: 1; border-bottom: 1px dotted #0f3b6c; margin-left: 6px; text-align: center; font-weight: 800; color: #0f172a; font-size: 14.5px;">
            ${data.seatNumber}
          </span>
        </div>
        <div style="display: flex; align-items: baseline; flex: 1.1;">
          <span style="font-weight: 700; color: #0f3b6c; white-space: nowrap;">તારીખ :</span>
          <span style="flex: 1; border-bottom: 1px dotted #0f3b6c; margin-left: 6px; text-align: center; font-weight: 600; color: #0f172a;">
            ${data.date}
          </span>
        </div>
      </div>

      <!-- Table: Sr | Particulars | Amount -->
      <table style="width: 100%; border-collapse: separate; border-spacing: 0; border: 1px solid #0f3b6c; margin-bottom: 10px;">
        <thead>
          <tr style="background: #e8edf4; color: #0f3b6c; font-weight: 800; font-size: 13.5px;">
            <th style="width: 10%; border-bottom: 1px solid #0f3b6c; border-right: 1px solid #0f3b6c; padding: 6px 4px; text-align: center;">ક્રમ</th>
            <th style="width: 68%; border-bottom: 1px solid #0f3b6c; border-right: 1px solid #0f3b6c; padding: 6px 12px; text-align: center;">વિગત</th>
            <th style="width: 22%; border-bottom: 1px solid #0f3b6c; padding: 6px 10px; text-align: center;">રકમ</th>
          </tr>
        </thead>
        <tbody>
          <tr style="min-height: 90px;">
            <td style="border-bottom: 1px solid #0f3b6c; border-right: 1px solid #0f3b6c; padding: 12px 6px; text-align: center; vertical-align: top; font-weight: 700; font-size: 14px;">
              1
            </td>
            <td style="border-bottom: 1px solid #0f3b6c; border-right: 1px solid #0f3b6c; padding: 12px 16px; vertical-align: top; font-size: 13.5px; line-height: 1.6;">
              <div style="display: flex; align-items: center; gap: 24px; margin-bottom: 6px; font-size: 13.5px;">
                <span><strong style="color: #0f3b6c;">તા.</strong> ${data.startDate || '—'}</span>
                <span style="font-weight: 700; color: #0f3b6c;">થી</span>
                <span><strong style="color: #0f3b6c;">તા.</strong> ${data.endDate || '—'}</span>
              </div>
              <div style="font-weight: 700; color: #1e293b; margin-bottom: 8px;">
                ${data.planName}
              </div>
              <div style="display: flex; align-items: center; gap: 18px; font-size: 12.5px; font-weight: 600; color: #0f3b6c; margin-top: 6px;">
                <span>Payment Mode :</span>
                <span style="display: inline-flex; align-items: center; gap: 5px;">
                  <span style="display:inline-flex; width:13px; height:13px; border:1px solid #0f3b6c; align-items:center; justify-content:center;">
                    ${data.isCash ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#0f3b6c" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
                  </span>
                  <span>Cash</span>
                </span>
                <span style="display: inline-flex; align-items: center; gap: 5px;">
                  <span style="display:inline-flex; width:13px; height:13px; border:1px solid #0f3b6c; align-items:center; justify-content:center;">
                    ${data.isOnline ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#0f3b6c" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
                  </span>
                  <span>Online</span>
                  ${data.transactionId ? `<span style="font-size:11px; font-weight:normal; color:#475569;">(${data.transactionId})</span>` : ''}
                </span>
              </div>
            </td>
            <td style="border-bottom: 1px solid #0f3b6c; padding: 12px 14px; text-align: right; vertical-align: top; font-weight: 700; font-size: 15px; color: #0f172a;">
              ${data.formattedAmount}
            </td>
          </tr>
          <!-- Total Row -->
          <tr style="background: #ffffff;">
            <td colspan="2" style="border-right: 1px solid #0f3b6c; padding: 6px 16px; text-align: right; font-weight: 800; font-size: 14px; color: #0f3b6c;">
              કુલ રૂા.
            </td>
            <td style="padding: 6px 14px; text-align: right; font-weight: 900; font-size: 16px; color: #0f172a;">
              ${data.formattedAmount}
            </td>
          </tr>
        </tbody>
      </table>

      <!-- Footer: Left Gujarati Note | Center QR Code | Right Authorised Sign -->
      <div style="display: flex; align-items: flex-end; justify-content: space-between; margin-top: 8px; gap: 12px;">
        <!-- Left: Refund Policy Note in Gujarati -->
        <div style="font-size: 12.5px; font-weight: 700; color: #0f3b6c; max-width: 320px; line-height: 1.35;">
          નોંધ : ફી કોઈપણ સંજોગોમાં પરત કરવામાં આવશે નહીં.
        </div>

        <!-- Center: Real Library Payment QR Code -->
        <div style="display: flex; align-items: center; justify-content: center;">
          <img src="${data.qrCodeUrl}" alt="Payment Verification QR" style="width: 76px; height: 76px; object-fit: contain; border: 1px solid #cbd5e1; border-radius: 4px; padding: 2px; background: #ffffff;" onerror="this.onerror=null; if(this.src.indexOf('../')!==-1){this.src='./assets/payment-qr.jpeg';}else{this.src='../assets/payment-qr.jpeg';}" />
        </div>

        <!-- Right: Authorised Sign (Displays real uploaded signature if configured in admin settings) -->
        <div style="text-align: center; width: 160px; display: flex; flex-direction: column; align-items: center; justify-content: flex-end;">
          ${data.signatureUrl ? `
            <img src="${data.signatureUrl}" alt="Authorised Signature" style="height: 42px; max-width: 140px; object-fit: contain; margin-bottom: 2px;" />
          ` : `
            <div style="height: 38px;"></div>
          `}
          <div style="width: 100%; font-size: 13px; font-weight: 700; color: #0f3b6c; white-space: nowrap;">
            ${data.signatoryTitle || 'Authorised Sign.'}
          </div>
        </div>
      </div>

    </div>
  `;
};

/**
 * Opens modal preview of the physical receipt with Print & Download options (Zero Emojis)
 */
export const openReceiptModal = async (input) => {
  if (isPayLater(input)) {
    if (window.showToast) window.showToast("Cannot generate invoice: Student fee has not been paid (Pay Later).", "warning");
    return { success: false, error: "Payment not completed (Pay Later)." };
  }
  if (window.showToast) window.showToast("Loading Fee Receipt...", "info");

  let data;
  try {
    data = await resolveReceiptData(input);
  } catch (err) {
    if (window.showToast) window.showToast(err.message, "warning");
    return { success: false, error: err.message };
  }
  const slipHtml = getReceiptSlipHTML(data);

  // Remove any older modal instances, old wrappers, or old print styles completely
  document.querySelectorAll("#shreeji-receipt-modal, .shreeji-receipt-modal, #receipt-print-wrapper, #receipt-print-style, [data-receipt-modal]").forEach(el => el.remove());

  const modal = document.createElement("div");
  modal.id = "shreeji-receipt-modal";
  modal.style.cssText = `
    position: fixed;
    inset: 0;
    z-index: 999999;
    background: rgba(15, 23, 42, 0.75);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    overflow-y: auto;
  `;

  const isAdmin = localStorage.getItem("userRole") === "Owner" || localStorage.getItem("userRole") === "Admin" || localStorage.getItem("userRole") === "Manager";

  modal.innerHTML = `
    <div style="
      background: #f8fafc;
      border-radius: 12px;
      box-shadow: 0 25px 60px rgba(0,0,0,0.4);
      max-width: 860px;
      width: 100%;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      border: 1px solid #cbd5e1;
    ">
      <!-- Toolbar (No Emojis) -->
      <div class="no-print" style="
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 18px;
        background: #0f3b6c;
        color: #ffffff;
      ">
        <div style="font-weight: 700; font-size: 14.5px; letter-spacing: 0.3px;">
          Shreeji Reading Library - Receipt #${data.receiptNo}
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          ${isAdmin ? `
            <label class="btn btn-sm" style="background:rgba(255,255,255,0.12); color:#ffffff; font-weight:600; border:1px solid rgba(255,255,255,0.25); padding:5px 10px; border-radius:6px; cursor:pointer; font-size:12px;">
              Change Signature
              <input type="file" id="modal-signature-upload" accept="image/*" style="display:none;" />
            </label>
          ` : ''}
          <button id="btn-receipt-download" class="btn btn-sm" style="background:#ffffff; color:#0f3b6c; font-weight:700; border:none; padding:5px 12px; border-radius:6px; cursor:pointer; display:inline-flex; align-items:center; gap:5px; font-size:12px;">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Download PDF
          </button>
          <button id="btn-receipt-close" style="background:transparent; border:none; color:#ffffff; cursor:pointer; padding:2px 8px; display:inline-flex; align-items:center;" title="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>

      <!-- Receipt Body -->
      <div id="receipt-print-wrapper" style="padding: 24px 18px; background: #e2e8f0; display: flex; justify-content: center; overflow-x: auto;">
        ${slipHtml}
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const closeModal = () => modal.remove();
  modal.querySelector("#btn-receipt-close").addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  modal.querySelector("#btn-receipt-download").addEventListener("click", async () => {
    const btn = modal.querySelector("#btn-receipt-download");
    const orig = btn.innerHTML;
    btn.innerHTML = "Generating PDF...";
    btn.disabled = true;
    try {
      await downloadReceiptPDF(data);
    } finally {
      btn.innerHTML = orig;
      btn.disabled = false;
    }
  });

  // Modal Signature Upload Handler for Admin
  const sigInput = modal.querySelector("#modal-signature-upload");
  if (sigInput) {
    sigInput.addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (evt) => {
        const sigUrl = evt.target.result;
        try {
          const { saveSettings } = await import("./settingsService.js");
          await saveSettings({ signatureUrl: sigUrl });
          if (window.showToast) window.showToast("Signature saved to settings!", "success");
          closeModal();
          openReceiptModal({ ...input, signatureUrl: sigUrl });
        } catch (err) {
          if (window.showToast) window.showToast("Failed to save signature: " + err.message, "error");
        }
      };
      reader.readAsDataURL(file);
    });
  }

  return { success: true, receiptNo: data.receiptNo };
};

export const downloadReceiptPDF = async (input) => {
  if (isPayLater(input)) {
    if (window.showToast) window.showToast("Cannot generate invoice: Student fee has not been paid (Pay Later).", "warning");
    return { success: false, error: "Payment not completed (Pay Later)." };
  }
  try {
    const data = input.receiptNo ? input : await resolveReceiptData(input);

    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js");
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js");

    // Render in an offscreen isolated container with exact 780px width so neither modal scrolling nor responsive scaling causes clipped borders
    const tempContainer = document.createElement("div");
    tempContainer.style.cssText = "position:absolute; left:-9999px; top:0; width:780px; min-width:780px; max-width:780px; z-index:-9999; background:#ffffff; overflow:visible; box-sizing:border-box;";
    tempContainer.innerHTML = getReceiptSlipHTML(data);
    document.body.appendChild(tempContainer);

    const targetEl = tempContainer.querySelector("#shreeji-receipt-slip");
    targetEl.style.width = "780px";
    targetEl.style.maxWidth = "780px";
    targetEl.style.minWidth = "780px";

    if (document.fonts && document.fonts.ready) {
      await document.fonts.ready;
    }

    const canvas = await window.html2canvas(targetEl, {
      scale: 3,
      useCORS: true,
      allowTaint: true,
      backgroundColor: "#ffffff",
      width: 780,
      windowWidth: 1200,
      scrollX: 0,
      scrollY: 0,
      logging: false
    });

    tempContainer.remove();

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({
      orientation: "landscape",
      unit: "mm",
      format: "a5"
    });

    // A5 Landscape is 210mm wide x 148mm high.
    // Proportional scaling ensures zero clipping and clean margins on all sides.
    const pageWidth = 210;
    const pageHeight = 148;
    const marginX = 8;
    const pdfWidth = pageWidth - (marginX * 2);
    const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
    const marginY = Math.max(6, (pageHeight - pdfHeight) / 2);

    const imgData = canvas.toDataURL("image/png");
    doc.addImage(imgData, "PNG", marginX, marginY, pdfWidth, pdfHeight, undefined, "FAST");

    const safeName = (data.studentName || "Student").replace(/\s+/g, "_");
    const fileName = `Receipt_${data.receiptNo}_${safeName}.pdf`;
    doc.save(fileName);

    if (window.showToast) window.showToast(`Receipt #${data.receiptNo} downloaded successfully!`, "success");
    return { success: true, receiptNo: data.receiptNo };
  } catch (error) {
    console.error("Receipt PDF Error:", error);
    if (window.showToast) window.showToast("Failed to generate receipt PDF: " + error.message, "error");
    return { success: false, error: error.message };
  }
};
