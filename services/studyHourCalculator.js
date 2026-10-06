/**
 * Pure functional utility to calculate study hour metrics from an array of attendance records.
 * Records must have a `duration` field (in hours) and a `checkIn` timestamp.
 */

export const calculateStudyHours = (records) => {
  let todayHours = 0;
  let weeklyHours = 0;
  let monthlyHours = 0;
  let totalHours = 0;

  const now = new Date();
  
  // Set time boundaries
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  
  // Start of week (Assuming Monday is start of week for calculations)
  const dayOfWeek = now.getDay() || 7; // Sunday=0 -> 7
  const startOfWeek = new Date(startOfToday - ((dayOfWeek - 1) * 24 * 60 * 60 * 1000)).getTime();
  
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  records.forEach(r => {
    // Only count completed sessions with a valid duration
    if (r.status === "Completed" && r.duration) {
      totalHours += r.duration;
      
      if (r.checkIn >= startOfToday) todayHours += r.duration;
      if (r.checkIn >= startOfWeek) weeklyHours += r.duration;
      if (r.checkIn >= startOfMonth) monthlyHours += r.duration;
    }
  });

  return {
    todayHours: round2(todayHours),
    weeklyHours: round2(weeklyHours),
    monthlyHours: round2(monthlyHours),
    totalHours: round2(totalHours)
  };
};

const round2 = (num) => Math.round(num * 100) / 100;
