import { logWhatsAppMessage } from "./messageLogService.js";

/**
 * Replaces placeholders in a message template based on student data.
 */
export const replacePlaceholders = (templateString, studentData) => {
  if (!templateString) return "";
  
  let result = templateString;
  result = result.replace(/{StudentName}/g, studentData.fullName || "Student");
  result = result.replace(/{SeatNumber}/g, studentData.seatNumber || "N/A");
  result = result.replace(/{MembershipPlan}/g, studentData.planName || "Plan");
  result = result.replace(/{PendingAmount}/g, studentData.pendingAmount || "0");
  result = result.replace(/{RenewalDate}/g, studentData.endDate || "Date");
  result = result.replace(/{LibraryName}/g, "Studyhaus");
  return result;
};

/**
 * Generates Click-to-Chat URL and logs the message.
 */
export const sendWhatsAppMessage = async (studentData, templateName, rawMessage) => {
  if (!studentData.phone) {
    window.showToast("Error: Student phone number is missing.", "error");
    return false;
  }

  const finalMessage = replacePlaceholders(rawMessage, studentData);
  const encodedMessage = encodeURIComponent(finalMessage);

  // Format phone number (Assume India +91 if length is 10)
  let phoneStr = studentData.phone.replace(/[^0-9]/g, "");
  if (phoneStr.length === 10) {
    phoneStr = "91" + phoneStr;
  }

  const url = `https://wa.me/${phoneStr}?text=${encodedMessage}`;

  // Log to Firestore
  const author = localStorage.getItem("userName") || "Admin";
  await logWhatsAppMessage({
    studentId: studentData.id,
    studentName: studentData.fullName,
    phone: phoneStr,
    templateName,
    message: finalMessage,
    sentBy: author
  });

  // Open WhatsApp in new tab
  window.open(url, '_blank');
  return true;
};
