/**
 * Validates check-in rules based on the student's plan.
 */
export const validateCheckInRules = (student) => {
  const planName = (student.planName || "").toLowerCase();

  // Night Study Plan Validation (7 PM to 7 AM)
  if (planName.includes("night")) {
    const now = new Date();
    const hour = now.getHours(); // 0 - 23
    
    // Valid if hour is >= 19 (7 PM) or < 7 (7 AM)
    if (hour >= 7 && hour < 19) {
      throw new Error("Night Study plan only allows check-in between 7:00 PM and 7:00 AM.");
    }
  }

  // Rotational max 30 validation happens on the service layer via query

  return true;
};

/**
 * Validates if a seat can be assigned to a specific student.
 */
export const validateSeatAssignment = (seatData) => {
  if (seatData.status === "Maintenance") {
    throw new Error("Cannot assign a seat that is currently under maintenance.");
  }
  if (seatData.status === "Inactive") {
    throw new Error("Cannot assign an inactive seat.");
  }
  if (seatData.status === "Occupied") {
    throw new Error("Cannot assign a seat that is currently occupied.");
  }
  
  return true;
};
