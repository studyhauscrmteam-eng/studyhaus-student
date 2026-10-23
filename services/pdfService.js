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

export const generateInvoicePDF = async (invoiceData = {}) => {
  try {
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js");
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.28/jspdf.plugin.autotable.min.js");

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({
      orientation: "portrait",
      unit: "mm",
      format: "a4"
    });

    // 1. Fetch dynamic settings configured in Admin Settings
    let settings = invoiceData.settings || null;
    if (!settings) {
      try {
        const { getDoc, doc: fsDoc } = await import("firebase/firestore");
        const { db } = await import("../firebase/firebase.js");
        const snap = await getDoc(fsDoc(db, "settings", "global_settings"));
        if (snap.exists()) settings = snap.data();
      } catch (_) {}
    }
    settings = settings || {};

    const libraryName = (settings.spaceName || "Shreeji Reading Library").trim();
    const librarySubtitle = (settings.subtitle || "PREMIUM STUDY LOUNGE & READING HALL").trim();
    const libraryAddress = (settings.address || "").trim();
    const libraryPhone = (settings.phone || "").trim();
    const libraryEmail = (settings.email || "").trim();
    const libraryGst = (settings.gstNumber || "").trim();
    const libraryPlaceOfSupply = (settings.placeOfSupply || "Gujarat (24)").trim();

    // 2. Real Student details with email fallback
    const numAmt = Number(invoiceData.amount || 0);
    const amtStr = `Rs. ${numAmt.toFixed(2)}`;
    const studentName = String(invoiceData.studentName || "Student").trim();
    const clientId = String(invoiceData.studentId || invoiceData.clientId || "—").trim();
    const phone = String(invoiceData.studentPhone || invoiceData.phone || "—").trim();
    
    let resolvedEmail = String(invoiceData.studentEmail || invoiceData.email || "").trim();
    if (!resolvedEmail || resolvedEmail === "—") {
      try {
        const { auth } = await import("../firebase/firebase.js");
        const ae = auth?.currentUser?.email;
        if (ae && !ae.endsWith("@student.shreejilibrary.com")) {
          resolvedEmail = ae;
        }
      } catch (_) {}
    }
    const email = resolvedEmail || "—";

    const planName = String(invoiceData.planName || "Regular Fixed Seat").trim();
    const duration = invoiceData.duration || "1 Months";
    const sessions = invoiceData.sessions || invoiceData.days || "30";
    const startDate = invoiceData.startDate || invoiceData.date || new Date().toISOString().split("T")[0];
    const endDate = invoiceData.endDate || invoiceData.dueDate || new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];
    const paymentMode = invoiceData.paymentMode || "UPI";
    const invoiceNo = invoiceData.invoiceNo || `SRL//2026-27/${Date.now().toString().slice(-4)}`;
    const invoiceDate = invoiceData.date || new Date().toLocaleDateString("en-GB").replace(/\//g, "-");

    // 3. Helper to load logo dynamically into base64 with natural dimensions
    const loadLogoDataUrl = () => new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const w = img.naturalWidth || img.width || 100;
          const h = img.naturalHeight || img.height || 100;
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0);
          resolve({
            dataUrl: canvas.toDataURL("image/jpeg", 0.95),
            width: w,
            height: h
          });
        } catch (_) {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = window.location.pathname.includes("/student/") || window.location.pathname.includes("/admin/") || window.location.pathname.includes("/manager/") || window.location.pathname.includes("/employee/")
        ? "../assets/logo.jpg"
        : "./assets/logo.jpg";
      setTimeout(() => resolve(null), 1200);
    });

    // Top Banner: Charcoal "Tax Invoice" Bar
    doc.setFillColor(60, 64, 67);
    doc.rect(14, 12, 182, 11, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.text("Tax Invoice", 105, 19.5, { align: "center" });

    // Logo with Preserved Aspect Ratio (never stretched or shrinked)
    let logoInfo = null;
    try {
      logoInfo = await loadLogoDataUrl();
    } catch (_) {}

    const maxLogoW = 26;
    const maxLogoH = 14;
    let renderLogoW = 14;
    let renderLogoH = 14;

    if (logoInfo && logoInfo.width && logoInfo.height) {
      const imgRatio = logoInfo.width / logoInfo.height;
      if (imgRatio >= maxLogoW / maxLogoH) {
        renderLogoW = maxLogoW;
        renderLogoH = maxLogoW / imgRatio;
      } else {
        renderLogoH = maxLogoH;
        renderLogoW = maxLogoH * imgRatio;
      }
      const offsetY = 25 + (maxLogoH - renderLogoH) / 2;
      try {
        doc.addImage(logoInfo.dataUrl, "JPEG", 14, offsetY, renderLogoW, renderLogoH);
      } catch (_) {}
    } else {
      renderLogoW = 14;
      renderLogoH = 14;
      doc.setFillColor(30, 41, 59);
      doc.roundedRect(14, 25, 14, 14, 2, 2, "F");
      doc.setTextColor(255, 255, 255);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.text("SRL", 21, 33.5, { align: "center" });
    }

    const headerTextX = 14 + renderLogoW + 3.5;
    doc.setTextColor(15, 23, 42);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12.5);
    doc.text(libraryName.toUpperCase(), headerTextX, 30.5);
    doc.setFontSize(7.5);
    doc.setTextColor(100, 116, 139);
    doc.setFont("helvetica", "bold");
    doc.text(librarySubtitle.toUpperCase(), headerTextX, 35.5);

    // Right: Invoice ID & Date
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.setFont("helvetica", "bold");
    doc.text("Invoice ID:", 142, 30.5);
    doc.setTextColor(15, 23, 42);
    doc.setFont("helvetica", "bold");
    doc.text(invoiceNo, 196, 30.5, { align: "right" });

    doc.setTextColor(100, 116, 139);
    doc.text("Invoice Date:", 142, 36);
    doc.setTextColor(15, 23, 42);
    doc.setFont("helvetica", "normal");
    doc.text(invoiceDate, 196, 36, { align: "right" });

    // Greeting
    doc.setFontSize(9.5);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(15, 23, 42);
    doc.text(`Hi ${studentName},`, 14, 45.5);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(71, 85, 105);
    doc.text("Thank you for your purchase. Here is an overview of your recent purchase:", 14, 49.5);

    // Two-Column Billing Info
    // Left: Billing From (Dynamic from Admin Settings)
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.text("BILLING FROM", 14, 57);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.5);
    doc.setTextColor(15, 23, 42);
    doc.text(libraryName, 14, 61.5);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(71, 85, 105);
    let fromY = 66;
    if (libraryAddress) {
      const splitAddr = doc.splitTextToSize(libraryAddress, 90);
      doc.text(splitAddr, 14, fromY);
      fromY += (splitAddr.length * 3.8);
    }
    if (libraryPhone) {
      doc.text(`Mobile: ${libraryPhone}`, 14, fromY);
      fromY += 3.8;
    }
    if (libraryEmail) {
      doc.text(`Email: ${libraryEmail}`, 14, fromY);
      fromY += 3.8;
    }
    if (libraryGst) {
      doc.text(`GSTIN: ${libraryGst}`, 14, fromY);
      fromY += 3.8;
    }
    if (libraryPlaceOfSupply) {
      doc.text(`Place of Supply: ${libraryPlaceOfSupply}`, 14, fromY);
      fromY += 3.8;
    }

    // Right: Billing To (Real Student details)
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.text("BILLING TO", 196, 57, { align: "right" });

    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(30, 64, 175);
    doc.text(studentName.toUpperCase(), 196, 61.5, { align: "right" });

    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(71, 85, 105);
    doc.text(`Client ID: ${clientId}`, 196, 66, { align: "right" });
    doc.text(`Mobile: ${phone}`, 196, 70, { align: "right" });
    doc.text(`Email: ${email}`, 196, 74, { align: "right" });
    if (invoiceData.seatNumber) {
      doc.text(`Seat: Seat ${invoiceData.seatNumber} (${invoiceData.seatFloor || 'Ground Floor'})`, 196, 78, { align: "right" });
    }

    // Selected Plans Table (Using serial number 1, no fake random numbers)
    const tableStartY = Math.max(fromY + 2, 83);
    doc.autoTable({
      head: [["#", "Plan Name", "Duration", "Sessions", "Start Date", "End Date", "Amount", "Discount"]],
      body: [
        [
          "1",
          planName,
          duration,
          sessions,
          startDate,
          endDate,
          amtStr,
          "Rs. 0.00"
        ]
      ],
      startY: tableStartY,
      margin: { left: 14, right: 14 },
      theme: "grid",
      headStyles: {
        fillColor: [60, 64, 67],
        textColor: [255, 255, 255],
        fontStyle: "bold",
        fontSize: 7.5,
        halign: "center",
        cellPadding: 2.5
      },
      styles: {
        fontSize: 7.5,
        cellPadding: 2.8,
        textColor: [30, 41, 59],
        lineColor: [203, 213, 225],
        lineWidth: 0.1
      },
      columnStyles: {
        0: { halign: "center", fontStyle: "bold" },
        1: { halign: "left", fontStyle: "bold" },
        2: { halign: "center" },
        3: { halign: "center" },
        4: { halign: "center" },
        5: { halign: "center" },
        6: { halign: "right", fontStyle: "bold" },
        7: { halign: "right" }
      }
    });

    // Totals Section (Two Columns)
    let curY = doc.lastAutoTable.finalY + 6;
    doc.setFontSize(8);
    doc.setTextColor(30, 41, 59);

    const leftTotals = [
      ["Selected Plans Total:", amtStr],
      ["SGST (0%):", "Rs. 0.00"],
      ["CGST (0%):", "Rs. 0.00"],
      ["Sub Total:", amtStr],
      ["Surcharge (%):", "Rs. 0.00"]
    ];
    leftTotals.forEach(([k, v], i) => {
      doc.setFont("helvetica", "bold");
      doc.setTextColor(100, 116, 139);
      doc.text(k, 14, curY + (i * 4.8));
      doc.setFont("helvetica", "normal");
      doc.setTextColor(15, 23, 42);
      doc.text(v, 50, curY + (i * 4.8));
    });

    const rightTotals = [
      ["Payable Amount:", amtStr],
      ["Amount Paid:", amtStr],
      ["Balance Amount:", "Rs. 0.00"]
    ];
    rightTotals.forEach(([k, v], i) => {
      doc.setFont("helvetica", "bold");
      doc.setTextColor(100, 116, 139);
      doc.text(k, 125, curY + (i * 5));
      doc.setTextColor(15, 23, 42);
      doc.text(v, 162, curY + (i * 5));
    });

    curY += Math.max(leftTotals.length * 4.8, rightTotals.length * 5) + 6;

    // Payment Log Section (Serial number 1, clean format)
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(15, 23, 42);
    doc.text("Payment Log", 14, curY);

    doc.autoTable({
      head: [["#", "Payment Date", "Amount Paid", "Payment Mode", "Invoice/Receipt No.", "Received By"]],
      body: [
        [
          "1",
          invoiceDate,
          amtStr,
          paymentMode,
          invoiceNo,
          "Admin"
        ]
      ],
      startY: curY + 2,
      margin: { left: 14, right: 14 },
      theme: "grid",
      headStyles: {
        fillColor: [60, 64, 67],
        textColor: [255, 255, 255],
        fontStyle: "bold",
        fontSize: 7.5,
        halign: "center",
        cellPadding: 2.5
      },
      styles: {
        fontSize: 7.5,
        cellPadding: 2.8,
        textColor: [30, 41, 59],
        lineColor: [203, 213, 225],
        lineWidth: 0.1
      },
      columnStyles: {
        0: { halign: "center" },
        1: { halign: "center" },
        2: { halign: "center", fontStyle: "bold" },
        3: { halign: "center" },
        4: { halign: "center" },
        5: { halign: "center" }
      }
    });

    curY = doc.lastAutoTable.finalY + 8;

    // 8. Terms & Conditions
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    doc.setTextColor(30, 41, 59);
    doc.text("Terms & Conditions", 14, curY);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(100, 116, 139);
    const tcText = "1. Fees once paid will not be refundable, non-extendable, and non-transferable. 2. Outside footwear is strictly prohibited inside the study hall. 3. This receipt confirms that you have accepted the rules and regulations of Shreeji Reading Library. 4. Management is not responsible for personal belongings.";
    const splitTc = doc.splitTextToSize(tcText, 182);
    doc.text(splitTc, 14, curY + 3.8);

    const safeFilename = `${studentName.replace(/\s+/g, '_')}_Tax_Invoice_${invoiceDate.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
    doc.save(safeFilename);
    return { success: true };
  } catch (error) {
    console.error("Invoice PDF Error:", error);
    return { success: false, error: error.message };
  }
};

