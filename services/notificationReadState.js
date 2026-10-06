/**
 * Shared read/dismiss state for notification lists (admin + student portals).
 * Clicking a notification marks it read (persisted per user in localStorage)
 * so it stays gone after refresh. Badge counts only unread items.
 */

const storeKey = () => `readNotifs_${(typeof localStorage !== "undefined" && localStorage.getItem("userId")) || "anon"}`;

export const getReadIds = () => {
  try {
    const raw = localStorage.getItem(storeKey()) || "[]";
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch (_) {
    return new Set();
  }
};

export const isNotifRead = (id) => {
  if (id == null) return false;
  return getReadIds().has(String(id));
};

export const markNotifRead = (id) => {
  if (id == null) return;
  try {
    const set = getReadIds();
    set.add(String(id));
    localStorage.setItem(storeKey(), JSON.stringify([...set].slice(-300)));
  } catch (_) {}
};

export const countUnread = (ids) => {
  const read = getReadIds();
  return (ids || []).filter((id) => !read.has(String(id))).length;
};
