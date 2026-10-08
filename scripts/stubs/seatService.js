/**
 * Test double for services/seatService.js — supplies production-shaped seat
 * data with NO Firestore, so the render test exercises the real seatMapUI
 * code (layout, palette, normalisation, selection) against real data.
 *
 * 108 seats: A1-A68 (Ground Floor) + B1-B40 (First Floor), matching the live
 * collection exactly, including a couple of Occupied rows.
 */
const seats = [];
for (let i = 1; i <= 68; i++) {
  seats.push({
    id: `A${i}`,
    seatNumber: `A${i}`,
    floor: "Ground Floor",
    col: i,
    row: 1,
    status: i === 5 || i === 50 ? "Occupied" : "Available",
    assignedStudentId: i === 5 || i === 50 ? "someone-else" : null,
    assignedStudentName: i === 5 || i === 50 ? "Existing Member" : null,
  });
}
for (let i = 1; i <= 40; i++) {
  seats.push({
    id: `B${i}`,
    seatNumber: `B${i}`,
    floor: "First Floor",
    col: i,
    row: 1,
    status: i === 7 ? "Occupied" : "Available",
    assignedStudentId: i === 7 ? "someone-else" : null,
    assignedStudentName: i === 7 ? "Existing Member" : null,
  });
}

export const listenToAllSeats = (onUpdate, onError) => {
  // Deliver asynchronously like a real snapshot, then stay subscribed.
  const t = setTimeout(() => {
    try {
      onUpdate(JSON.parse(JSON.stringify(seats)));
    } catch (e) {
      if (typeof onError === "function") onError(e);
    }
  }, 0);
  return () => clearTimeout(t);
};

// Everything below exists only so the admin-branch code paths still link.
export const assignSeat = async () => ({ success: true });
export const unassignSeat = async () => ({ success: true });
export const changeSeatStatus = async () => ({ success: true });
export const seedInitialSeats = async () => ({ success: true });
export const reconcileSeatOccupancy = async () => ({ success: true, released: 0, claimed: 0 });
export const cleanupNonPlanSeats = async () => ({
  success: true, deleted: 0, created: 0, renamed: 0, positioned: 0,
  clearedStudents: 0, fixedStudents: 0,
});
export const saveSeatPosition = async () => ({ success: true });
export const renameSeat = async () => ({ success: true });
export const addSeatAt = async () => ({ success: true });
export const deleteSeatById = async () => ({ success: true });
