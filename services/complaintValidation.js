/**
 * Validates a student's complaint submission.
 */
export const validateComplaint = (category, description) => {
  if (!category || category.trim() === "") {
    throw new Error("Please select a complaint category.");
  }

  const validCategories = ["Noise", "Light", "Fan", "Charging Point", "Furniture", "Cleaning", "Washroom", "WiFi", "Others"];
  if (!validCategories.includes(category)) {
    throw new Error("Invalid category selected.");
  }

  if (!description || description.trim() === "") {
    throw new Error("Please enter a description for your issue.");
  }

  if (description.trim().length < 10) {
    throw new Error("Please provide more detail in your description (minimum 10 characters).");
  }

  return true;
};
