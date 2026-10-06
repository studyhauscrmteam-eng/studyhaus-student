/**
 * PDF Generation Service
 * Dynamically loads jsPDF from CDN and generates the Attendance Report.
 */

const loadScript = (src) => {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
};

export const generateAttendancePDF = async (studentName, records, totalHours) => {
  try {
    // Load jsPDF and AutoTable plugins
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js");
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.28/jspdf.plugin.autotable.min.js");

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();

    // Header
    doc.setFontSize(18);
    doc.text("Attendance Summary Report", 14, 20);
    
    doc.setFontSize(12);
    doc.text(`Student: ${studentName}`, 14, 30);
    doc.text(`Total Study Hours: ${totalHours}h`, 14, 38);
    doc.text(`Generated On: ${new Date().toLocaleDateString()}`, 14, 46);

    // Filter to only completed sessions for the table
    const completedRecords = records.filter(r => r.status === "Completed");
    
    // Table Data
    const tableColumn = ["Date", "Check In", "Check Out", "Duration", "Seat"];
    const tableRows = [];

    completedRecords.forEach(r => {
      const rowData = [
        r.date,
        new Date(r.checkIn).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        new Date(r.checkOut).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        `${r.duration}h`,
        r.seatNumber
      ];
      tableRows.push(rowData);
    });

    // Generate Table
    doc.autoTable({
      head: [tableColumn],
      body: tableRows,
      startY: 55,
      theme: 'grid',
      styles: { fontSize: 10 },
      headStyles: { fillColor: [79, 70, 229] } // Brand primary color
    });

    // Save PDF
    doc.save(`${studentName.replace(/\\s+/g, '_')}_Attendance.pdf`);
    return { success: true };
    
  } catch (error) {
    console.error("PDF Generation Error:", error);
    return { success: false, error: error.message };
  }
};

export const generateOldStudentsPDF = async (records) => {
  try {
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js");
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.28/jspdf.plugin.autotable.min.js");

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();

    doc.setFontSize(18);
    doc.text("Old Students Pending Fees Report", 14, 20);
    doc.setFontSize(12);
    doc.text(`Generated On: ${new Date().toLocaleDateString()}`, 14, 30);

    const tableColumn = ["Name", "Phone", "Job Details", "Exit Date", "Exit Reason", "Fee Status", "Outstanding Amount"];
    const tableRows = [];

    records.forEach(r => {
      tableRows.push([
        r.name || "Unknown",
        r.phone || "N/A",
        r.jobDetails || "N/A",
        r.exitDate || "N/A",
        r.exitReason || "N/A",
        r.pendingFee && r.pendingFee > 0 ? "Pending" : "Paid",
        `Rs. ${r.pendingFee || 0}`
      ]);
    });

    doc.autoTable({
      head: [tableColumn],
      body: tableRows,
      startY: 40,
      theme: 'grid',
      styles: { fontSize: 10 },
      headStyles: { fillColor: [79, 70, 229] }
    });

    doc.save(`Old_Students_Pending_Fees.pdf`);
    return { success: true };
    
  } catch (error) {
    console.error("PDF Generation Error:", error);
    return { success: false, error: error.message };
  }
};
