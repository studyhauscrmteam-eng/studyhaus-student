import { getSettings } from "./settingsService.js?v=ui1";

// Single source of truth for the payment QR shown across the whole portal
// (admin modals, student admission, pending-payment popup, pay page).
// Admin uploads it once in Settings → Payment Settings; everything else
// just calls paintQrImages(). No hardcoded image, no external placeholder.

let cachedQr = undefined; // undefined = not loaded yet, "" = none set

const NOT_SET_SVG =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><rect width="180" height="180" fill="#f1f5f9"/><text x="90" y="82" text-anchor="middle" font-family="Arial" font-size="13" fill="#64748b">QR not set</text><text x="90" y="102" text-anchor="middle" font-family="Arial" font-size="11" fill="#94a3b8">contact the desk</text></svg>`
  );

export const getQrUrl = async () => {
  if (cachedQr !== undefined) return cachedQr;
  try {
    const s = await getSettings();
    cachedQr = (s && s.qrCodeUrl) || "";
  } catch (_) {
    cachedQr = "";
  }
  return cachedQr;
};

/** Re-read settings (call after admin saves a new QR). */
export const refreshQrCache = async () => {
  cachedQr = undefined;
  return getQrUrl();
};

/** Paint every `img.payment-qr-img` under root with the live QR. */
export const paintQrImages = async (root) => {
  const url = await getQrUrl();
  const scope = root && root.querySelectorAll ? root : document;
  scope.querySelectorAll("img.payment-qr-img").forEach((img) => {
    img.onerror = null; // never fall back to external placeholders
    img.src = url || NOT_SET_SVG;
  });
};
