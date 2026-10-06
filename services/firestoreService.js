import { 
  collection, 
  doc, 
  addDoc, 
  updateDoc, 
  deleteDoc, 
  getDoc, 
  getDocs, 
  query 
} from "firebase/firestore";
import { db } from "../firebase/firebase.js";

/**
 * Add a new document to a specific collection
 * @param {string} collectionName - Name of the collection
 * @param {Object} data - Data to add to the new document
 * @returns {Promise<string>} The ID of the newly created document
 */
export const addDocument = async (collectionName, data) => {
  try {
    const docRef = await addDoc(collection(db, collectionName), data);
    return docRef.id;
  } catch (error) {
    console.error(`Error adding document to ${collectionName}:`, error.message);
    throw error;
  }
};

/**
 * Update an existing document by its ID
 * @param {string} collectionName - Name of the collection
 * @param {string} documentId - ID of the document to update
 * @param {Object} data - Data to update (merges with existing data)
 * @returns {Promise<void>}
 */
export const updateDocument = async (collectionName, documentId, data) => {
  try {
    const docRef = doc(db, collectionName, documentId);
    await updateDoc(docRef, data);
  } catch (error) {
    console.error(`Error updating document ${documentId} in ${collectionName}:`, error.message);
    throw error;
  }
};

/**
 * Delete a document by its ID
 * @param {string} collectionName - Name of the collection
 * @param {string} documentId - ID of the document to delete
 * @returns {Promise<void>}
 */
export const deleteDocument = async (collectionName, documentId) => {
  try {
    const docRef = doc(db, collectionName, documentId);
    await deleteDoc(docRef);
  } catch (error) {
    console.error(`Error deleting document ${documentId} in ${collectionName}:`, error.message);
    throw error;
  }
};

/**
 * Get a single document by its ID
 * @param {string} collectionName - Name of the collection
 * @param {string} documentId - ID of the document to retrieve
 * @returns {Promise<Object|null>} The document data or null if it doesn't exist
 */
export const getDocument = async (collectionName, documentId) => {
  try {
    const docRef = doc(db, collectionName, documentId);
    const docSnap = await getDoc(docRef);
    if (docSnap.exists()) {
      return { id: docSnap.id, ...docSnap.data() };
    }
    return null;
  } catch (error) {
    console.error(`Error getting document ${documentId} in ${collectionName}:`, error.message);
    throw error;
  }
};

/**
 * Get all documents in a collection
 * @param {string} collectionName - Name of the collection
 * @returns {Promise<Array>} Array of document data objects
 */
export const getCollection = async (collectionName) => {
  try {
    const querySnapshot = await getDocs(collection(db, collectionName));
    const results = [];
    querySnapshot.forEach((doc) => {
      results.push({ id: doc.id, ...doc.data() });
    });
    return results;
  } catch (error) {
    console.error(`Error getting collection ${collectionName}:`, error.message);
    throw error;
  }
};

/**
 * Query a collection based on specific conditions
 * @param {string} collectionName - Name of the collection
 * @param {Array} queryConstraints - Array of query constraints (e.g., where(), orderBy())
 * @returns {Promise<Array>} Array of document data objects matching the query
 */
export const queryCollection = async (collectionName, queryConstraints) => {
  try {
    const q = query(collection(db, collectionName), ...queryConstraints);
    const querySnapshot = await getDocs(q);
    const results = [];
    querySnapshot.forEach((doc) => {
      results.push({ id: doc.id, ...doc.data() });
    });
    return results;
  } catch (error) {
    console.error(`Error querying collection ${collectionName}:`, error.message);
    throw error;
  }
};
