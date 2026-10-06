export const normalizePhone = (phone) => {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  if (digits.length === 10) return digits;
  return digits;
};

export const formatPhoneForDisplay = (phone) => {
  const n = normalizePhone(phone);
  if (n.length !== 10) return phone;
  return '+91 ' + n.slice(0,5) + ' ' + n.slice(5);
};

export const isValidPhone = (phone) => normalizePhone(phone).length === 10;

export const phoneToAuthEmail = (phone) => {
  const n = normalizePhone(phone);
  if (n.length === 10) return n + '@student.shreejilibrary.com';
  return phone;
};

export const authEmailToPhone = (email) => {
  if (!email) return null;
  const m = email.match(/^(\d{10})@student\.shreejilibrary\.com$/);
  return m ? m[1] : null;
};