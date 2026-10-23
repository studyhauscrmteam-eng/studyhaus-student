import { logWhatsAppMessage } from "./messageLogService.js";
import { getSettings } from "./settingsService.js";

/**
 * Replaces placeholders in a message template based on student data.
 * Supports any field from student data plus known standard aliases.
 */
export const replacePlaceholders = (templateString, studentData = {}) => {
  if (!templateString) return "";

  let result = templateString;

  const fullName = studentData.fullName || studentData.name || "Student";
  const seatNum = studentData.seatNumber || studentData.seatAssigned || "";
  const seatFloor = studentData.seatFloor || studentData.floor || (seatNum ? "Ground Floor" : "");
  const seatDisplay = seatNum ? (seatNum.includes("(") ? seatNum : `${seatNum} (${seatFloor})`) : "N/A";
  const plan = studentData.planName || studentData.membershipPlan || "Plan";
  const pending = studentData.pendingAmount != null ? String(studentData.pendingAmount) : "0";
  const renewal = studentData.endDate || studentData.renewalDate || "Date";
  const libName = "Shreeji Library";

  result = result.replace(/{StudentName}/gi, fullName);
  result = result.replace(/{FullName}/gi, fullName);
  result = result.replace(/{SeatNumber}/gi, seatDisplay);
  result = result.replace(/{SeatFloor}/gi, seatFloor);
  result = result.replace(/{MembershipPlan}/gi, plan);
  result = result.replace(/{PlanName}/gi, plan);
  result = result.replace(/{PendingAmount}/gi, pending);
  result = result.replace(/{RenewalDate}/gi, renewal);
  result = result.replace(/{EndDate}/gi, renewal);
  result = result.replace(/{StartDate}/gi, studentData.startDate || "");
  result = result.replace(/{Phone}/gi, studentData.phone || "");
  result = result.replace(/{Email}/gi, studentData.email || "");
  result = result.replace(/{College}/gi, studentData.college || "");
  result = result.replace(/{Course}/gi, studentData.course || "");
  result = result.replace(/{ParentPhone}/gi, studentData.parentPhone || "");
  result = result.replace(/{Address}/gi, studentData.address || "");
  result = result.replace(/{LibraryName}/gi, libName);

  // Dynamic regex fallback for any arbitrary field present in studentData
  result = result.replace(/{([a-zA-Z0-9_]+)}/g, (match, field) => {
    if (studentData[field] !== undefined && studentData[field] !== null) {
      return String(studentData[field]);
    }
    // Case-insensitive key lookup
    const lowerKey = field.toLowerCase();
    const foundKey = Object.keys(studentData).find(k => k.toLowerCase() === lowerKey);
    if (foundKey && studentData[foundKey] !== undefined && studentData[foundKey] !== null) {
      return String(studentData[foundKey]);
    }
    return match;
  });

  return result;
};

/**
 * Generates Click-to-Chat URL and logs the message.
 * Respects the WhatsApp messaging enabled/disabled setting.
 */
export const sendWhatsAppMessage = async (studentData, templateName, rawMessage) => {
  try {
    const settings = await getSettings();
    if (settings && settings.whatsappEnabled === false) {
      if (typeof window.showToast === 'function') {
        window.showToast("WhatsApp messaging is disabled in Settings.", "warning");
      } else {
        alert("WhatsApp messaging is disabled in Settings.");
      }
      return false;
    }
  } catch (_) {}

  if (!studentData || !studentData.phone) {
    if (typeof window.showToast === 'function') {
      window.showToast("Error: Student phone number is missing.", "error");
    } else {
      alert("Error: Student phone number is missing.");
    }
    return false;
  }

  const finalMessage = replacePlaceholders(rawMessage, studentData);
  const encodedMessage = encodeURIComponent(finalMessage);

  // Format phone number (Assume India +91 if length is 10)
  let phoneStr = String(studentData.phone).replace(/[^0-9]/g, "");
  if (phoneStr.length === 10) {
    phoneStr = "91" + phoneStr;
  }

  const url = `https://wa.me/${phoneStr}?text=${encodedMessage}`;

  // Log to Firestore
  const author = localStorage.getItem("userName") || "Admin";
  await logWhatsAppMessage({
    studentId: studentData.id || "",
    studentName: studentData.fullName || studentData.name || "Student",
    phone: phoneStr,
    templateName: templateName || "Message",
    message: finalMessage,
    sentBy: author
  });

  // Open WhatsApp in new tab
  window.open(url, '_blank');
  return true;
};
