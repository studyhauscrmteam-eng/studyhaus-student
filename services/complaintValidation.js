/**
 * Validates a student's complaint submission.
 */
export const validateComplaint = (category, description) => {
  if (!category || String(category).trim() === '') {
    throw new Error('Please select a complaint category.');
  }

  const validCategories = ['Noise', 'Light', 'Fan', 'Charging Point', 'Furniture', 'Cleaning', 'Washroom', 'WiFi', 'Others'];
  const trimmedCat = String(category).trim();
  const matched = validCategories.find(c => c.toLowerCase() === trimmedCat.toLowerCase());
  const finalCategory = matched || (trimmedCat.length > 0 ? trimmedCat : 'Others');

  if (!description || String(description).trim() === '') {
    throw new Error('Please enter a description for your issue.');
  }

  if (String(description).trim().length < 2) {
    throw new Error('Please provide more detail in your description.');
  }

  return finalCategory;
};
