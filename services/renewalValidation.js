export const validateRenewal = (data) => {
  const { newPlanId, startDate, endDate, amount, paymentMethod } = data;
  
  if (!newPlanId) {
    throw new Error("Please select a membership plan.");
  }
  
  if (!startDate || !endDate) {
    throw new Error("Start Date and End Date are required.");
  }
  
  const start = new Date(startDate);
  const end = new Date(endDate);
  
  if (start >= end) {
    throw new Error("End Date must be after the Start Date.");
  }
  
  if (!paymentMethod) {
    throw new Error("Please select a payment method.");
  }
  
  if (amount < 0 || isNaN(amount)) {
    throw new Error("Invalid renewal amount.");
  }
  
  return true;
};
