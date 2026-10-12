/**
 * Parse a membership plan duration into months + days.
 * Plans store duration as text ("1 Month", "2 Months", "15 Days", "1 Week",
 * "6 Months", "1 Year") or a number (days). Never throws — falls back to
 * 1 month so subscription math always has a real value.
 *
 * @param {string|number|null|undefined} duration
 * @returns {{ months: number, days: number }}
 */
export const parsePlanDuration = (duration) => {
  if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
    return { months: 0, days: Math.round(duration) };
  }
  const raw = String(duration == null ? "" : duration).trim().toLowerCase();
  if (!raw) return { months: 1, days: 0 };
  const numMatch = raw.match(/(\d+(?:\.\d+)?)/);
  const num = numMatch ? parseFloat(numMatch[1]) : NaN;
  if (!Number.isFinite(num) || num <= 0) return { months: 1, days: 0 };

  if (raw.includes("year")) return { months: Math.round(num * 12), days: 0 };
  if (raw.includes("month") || raw.includes("mon")) return { months: Math.round(num), days: 0 };
  if (raw.includes("week")) return { months: 0, days: Math.round(num * 7) };
  if (raw.includes("day")) return { months: 0, days: Math.round(num) };
  // Bare number string like "30" means days.
  if (/^\d+(\.\d+)?$/.test(raw)) return { months: 0, days: Math.round(num) };
  return { months: 1, days: 0 };
};

/**
 * Add months + days to a date, day-safe (Jan 31 + 1 month stays end of Feb,
 * never overflows into March).
 * @param {Date} date
 * @param {number} months
 * @param {number} days
 * @returns {Date}
 */
export const addDurationToDate = (date, months = 0, days = 0) => {
  const d = new Date(date);
  const m = Number(months) || 0;
  const dy = Number(days) || 0;
  if (m > 0) {
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + m);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, lastDay));
  }
  if (dy > 0) d.setDate(d.getDate() + dy);
  return d;
};

/**
 * Human subscription remaining, e.g. "1 month 15 days left", "15 days left",
 * "1 month left". Pure display — inputs are day counts.
 * @param {number} totalDays
 * @returns {string}
 */
export const formatSubscriptionLeft = (totalDays) => {
  const t = Math.max(0, Math.ceil(Number(totalDays) || 0));
  if (t <= 0) return "Expired";
  if (t < 30) return `${t} day${t === 1 ? "" : "s"} left`;
  const months = Math.floor(t / 30);
  const days = t % 30;
  if (days === 0) return `${months} month${months === 1 ? "" : "s"} left`;
  return `${months} month${months === 1 ? "" : "s"} ${days} day${days === 1 ? "" : "s"} left`;
};
