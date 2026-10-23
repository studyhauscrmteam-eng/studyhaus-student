import { getDoc, doc } from "firebase/firestore";
import { db } from "../firebase/firebase.js";

export const DEFAULT_SCHEDULES = {
  normal: {
    dayStart: "06:00",
    dayEnd: "18:00",
    nightStart: "18:00",
    nightEnd: "06:00"
  },
  premium: {
    dayStart: "06:00",
    dayEnd: "18:00",
    nightStart: "18:00",
    nightEnd: "06:00"
  }
};

export const timeToMinutes = (timeStr) => {
  if (!timeStr || typeof timeStr !== "string") return 0;
  const parts = timeStr.trim().split(":");
  const h = Number(parts[0]) || 0;
  const m = Number(parts[1]) || 0;
  return (h * 60) + m;
};

export const isTimeInRange = (currentHHMM, startHHMM, endHHMM) => {
  const cur = timeToMinutes(currentHHMM);
  const start = timeToMinutes(startHHMM);
  const end = timeToMinutes(endHHMM);

  if (start === end) return true;

  if (start < end) {
    return cur >= start && cur < end;
  } else {
    return cur >= start || cur < end;
  }
};

export const getCurrentTimeString = (date = new Date()) => {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
};

let cachedSchedules = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 60000;

export const getLibrarySchedules = async () => {
  const now = Date.now();
  if (cachedSchedules && (now - lastFetchTime) < CACHE_TTL_MS) {
    return cachedSchedules;
  }
  try {
    const snap = await getDoc(doc(db, "settings", "global_settings"));
    const data = snap.exists() ? snap.data() : {};
    const schedules = {
      normal: {
        ...DEFAULT_SCHEDULES.normal,
        ...(data.schedules?.normal || {
          dayStart: data.normalDayStart || DEFAULT_SCHEDULES.normal.dayStart,
          dayEnd: data.normalDayEnd || DEFAULT_SCHEDULES.normal.dayEnd,
          nightStart: data.normalNightStart || DEFAULT_SCHEDULES.normal.nightStart,
          nightEnd: data.normalNightEnd || DEFAULT_SCHEDULES.normal.nightEnd
        })
      },
      premium: {
        ...DEFAULT_SCHEDULES.premium,
        ...(data.schedules?.premium || {
          dayStart: data.premiumDayStart || DEFAULT_SCHEDULES.premium.dayStart,
          dayEnd: data.premiumDayEnd || DEFAULT_SCHEDULES.premium.dayEnd,
          nightStart: data.premiumNightStart || DEFAULT_SCHEDULES.premium.nightStart,
          nightEnd: data.premiumNightEnd || DEFAULT_SCHEDULES.premium.nightEnd
        })
      }
    };
    cachedSchedules = schedules;
    lastFetchTime = now;
    return schedules;
  } catch (_) {
    return DEFAULT_SCHEDULES;
  }
};

export const invalidateScheduleCache = () => {
  cachedSchedules = null;
  lastFetchTime = 0;
};

export const getCurrentShift = (schedule, timeStr = getCurrentTimeString()) => {
  const isNight = isTimeInRange(timeStr, schedule.nightStart, schedule.nightEnd);
  return isNight ? "night" : "day";
};

export const validateStudentScheduleAccess = async (student, targetFloor = "Ground Floor", nowDate = new Date()) => {
  const schedules = await getLibrarySchedules();
  const isPremiumFloor = String(targetFloor || "").toLowerCase().includes("first") || String(targetFloor || "").toLowerCase().includes("premium");
  const libSchedule = isPremiumFloor ? schedules.premium : schedules.normal;

  const currentTime = getCurrentTimeString(nowDate);
  const planName = String(student.planName || "").toLowerCase();

  const isNightPlan = planName.includes("night") || planName.includes("ln") || planName.includes("pn");
  const isDayPlan = (planName.includes("day") || planName.includes("lr") || planName.includes("pr")) && !planName.includes("full") && !planName.includes("24");
  const isFullDayOr24h = planName.includes("24") || planName.includes("full") || (!isNightPlan && !isDayPlan);

  const planShift = isNightPlan ? "night" : (isDayPlan ? "day" : "24hr");
  const currentShift = getCurrentShift(libSchedule, currentTime);

  if (isFullDayOr24h) {
    return { allowed: true, currentShift, planShift };
  }

  if (isNightPlan) {
    const inNight = isTimeInRange(currentTime, libSchedule.nightStart, libSchedule.nightEnd);
    if (!inNight) {
      return {
        allowed: false,
        reason: `Your night-shift plan permits entry between ${libSchedule.nightStart} and ${libSchedule.nightEnd}. Current time is ${currentTime}.`,
        currentShift,
        planShift
      };
    }
    return { allowed: true, currentShift, planShift };
  }

  if (isDayPlan) {
    const inDay = isTimeInRange(currentTime, libSchedule.dayStart, libSchedule.dayEnd);
    if (!inDay) {
      return {
        allowed: false,
        reason: `Your day-shift plan permits entry between ${libSchedule.dayStart} and ${libSchedule.dayEnd}. Current time is ${currentTime}.`,
        currentShift,
        planShift
      };
    }
    return { allowed: true, currentShift, planShift };
  }

  return { allowed: true, currentShift, planShift };
};
