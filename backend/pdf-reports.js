const PDFDocument = require("pdfkit");

async function generateReport(chatId, type, context) {
  const { supabase, API, activeRound, availableNumbers } = context;

  async function getAllocations(roundId = null, paymentStatus = null) {
    let results = [];
    let start = 0;

    while (true) {
      let query = supabase
        .from("allocations")
        .select("round_id,number,payment_status,allocation_status,participants(full_name,phone)")
        .eq("allocation_status", "allocated")
        .order("number")
        .range(start, start + 999);

      if (roundId) query = query.eq("round_id", roundId);
      if (paymentStatus) query = query.eq("payment_status", paymentStatus);

      const { data, error } = await query;
      if (error) throw error;

      results.push(...(data || []));
      if (!data || data.length < 1000) break;
      start += 1000;
    }

    return results;
  }

  function createPdf(title, subtitle, records) {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        size: "A4",
        margin: 45
      });

      const chunks = [];
      doc.on("data", chunk => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      doc.fontSize(20).font("Helvetica-Bold")
        .text("NUMBER ALLOCATION SYSTEM");

      doc.moveDown();
      doc.fontSize(16).text(title);
      doc.fontSize(10).font("Helvetica")
        .fillColor("gray").text(subtitle).fillColor("black");

      doc.moveDown();
      doc.text(`Generated: ${new Date().toLocaleString()}`);
      doc.text(`Total records: ${records.length}`);
      doc.moveDown();

      doc.moveTo(45, doc.y).lineTo(550, doc.y).stroke();
      doc.moveDown();

      records.forEach((record, index) => {
        if (doc.y > 735) doc.addPage();

        doc.fontSize(9).font("Helvetica")
          .text(`${index + 1}. ${record}`, {
            width: 500,
            lineGap: 3
          });

        doc.moveDown(0.5);
      });

      if (!records.length) doc.text("No records found.");

      doc.end();
    });
  }

  async function sendPdf(title, subtitle, records, filename) {
    const pdf = await createPdf(title, subtitle, records);

    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append(
      "document",
      new Blob([pdf], { type: "application/pdf" }),
      filename
    );
    form.append("caption", title);

    const response = await fetch(`${API}/sendDocument`, {
      method: "POST",
      body: form
    });

    const result = await response.json();
    if (!result.ok) throw new Error(result.description || "PDF delivery failed");
  }

  const allRounds = type === "all";
  const round = allRounds ? null : await activeRound();

  if (!allRounds && !round) {
    throw new Error("There is no active round.");
  }

  if (type === "available") {
    const numbers = await availableNumbers(round);
    const records = [];

    for (let i = 0; i < numbers.length; i += 8) {
      records.push(numbers.slice(i, i + 8).join("     "));
    }

    return sendPdf(
      "Available Numbers",
      `Round: ${round.name}`,
      records,
      "available-numbers.pdf"
    );
  }

  const allocations = await getAllocations(
    round?.id || null,
    type === "paid" ? "paid" :
    type === "unpaid" ? "unpaid" : null
  );

  let roundMap = new Map();

  if (allRounds) {
    const { data, error } = await supabase
      .from("rounds")
      .select("id,name")
      .order("created_at", { ascending: false });

    if (error) throw error;
    roundMap = new Map((data || []).map(r => [r.id, r.name]));
  } else {
    roundMap.set(round.id, round.name);
  }

  const records = allocations.map(a => {
    const participant = a.participants || {};

    return [
      `Round: ${roundMap.get(a.round_id) || "Unknown"}`,
      `Name: ${participant.full_name || "Unknown"}`,
      `Phone: ${participant.phone || "-"}`,
      `Number: ${a.number}`,
      `Payment: ${a.payment_status.toUpperCase()}`
    ].join(" | ");
  });

  const titles = {
    registrations: "Registration Report",
    paid: "Paid Participants Report",
    unpaid: "Unpaid Participants Report",
    round: "Round Final Report",
    all: "All Rounds Consolidated Report"
  };

  if (type === "round" || type === "all") {
    const paid = allocations.filter(a => a.payment_status === "paid").length;
    const unpaid = allocations.filter(a => a.payment_status === "unpaid").length;

    records.unshift(
      `SUMMARY: ${allocations.length} registrations | Paid: ${paid} | Unpaid: ${unpaid}`
    );
  }

  return sendPdf(
    titles[type] || "Allocation Report",
    allRounds ? "All rounds" : `Round: ${round.name}`,
    records,
    `allocation-${type}.pdf`
  );
}

module.exports = { generateReport };
