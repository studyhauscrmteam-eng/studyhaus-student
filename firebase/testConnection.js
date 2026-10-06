import { addDocument, getDocument } from "../services/firestoreService.js";

/**
 * Test Firebase Connection
 * Creates a sample document in Firestore, reads it back, and displays the result.
 */
export const testFirebaseConnection = async () => {
  // console.log("Testing Firebase connection...");
  const collectionName = "test_connection";
  const testData = {
    message: "Firebase connection successful!",
    timestamp: new Date().toISOString()
  };

  try {
    // Show a loading state (simulated in console)
    // console.log("Loading... Writing to Firestore");
    
    // Write document
    const docId = await addDocument(collectionName, testData);
    // console.log(`Successfully wrote test document with ID: ${docId}`);

    // Read document back
    // console.log("Loading... Reading from Firestore");
    const retrievedData = await getDocument(collectionName, docId);
    
    if (retrievedData) {
      // console.log("Successfully retrieved test document:", retrievedData);
      alert("Firebase connection successfully tested! Check console for details.");
    } else {
      console.error("Test document not found after creation.");
      alert("Firebase test failed: Document not found after creation.");
    }
  } catch (error) {
    console.error("Firebase connection test failed:", error);
    alert("Firebase test failed. See console for details.");
  }
};
