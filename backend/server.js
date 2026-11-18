const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

const PORT = process.env.PORT || 3000;

// ---------- AUTHENTICATION ----------

async function requireAdmin(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ")
      ? header.slice(7)
      : null;

    if (!token) {
      return res.status(401).json({ error: "Authentication required." });
    }

    const { data: authData, error: authError } =
      await supabase.auth.getUser(token);

    if (authError || !authData.user) {
      return res.status(401).json({ error: "Invalid or expired session." });
    }

    const { data: admin, error } = await supabase
      .from("admins")
      .select("user_id, full_name, role, is_active")
      .eq("user_id", authData.user.id)
      .single();

    if (error || !admin || !admin.is_active) {
      return res.status(403).json({ error: "You are not an active admin." });
    }

    req.user = authData.user;
    req.admin = admin;
    next();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

function handleError(res, error) {
  console.error(error);
  res.status(400).json({ error: error.message || "Request failed." });
}

// ---------- GENERAL ----------

app.get("/", (req, res) => {
  res.json({ message: "Number Allocation API is running." });
});

app.get("/api/health", async (req, res) => {
  const { data, error } = await supabase
    .from("rounds")
    .select("id, name, status")
    .limit(5);

  if (error) return res.status(500).json({ success: false, message: error.message });

  res.json({ success: true, message: "Supabase connected successfully.", rounds: data });
});

app.get("/api/me", requireAdmin, (req, res) => {
  res.json({ user: req.user, admin: req.admin });
});

// ---------- ROUNDS ----------

app.get("/api/rounds", requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from("rounds")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return handleError(res, error);
  res.json(data);
});

app.post("/api/rounds", requireAdmin, async (req, res) => {
  try {
    const { name, max_number } = req.body;
    const max = Number(max_number);

    if (!name || !Number.isInteger(max) || max < 1 || max > 100000) {
      return res.status(400).json({ error: "Enter a round name and a maximum number from 1 to 100000." });
    }

    const { data, error } = await supabase
      .from("rounds")
      .insert({
        name: name.trim(),
        max_number: max,
        status: "draft",
        created_by: req.user.id
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    handleError(res, error);
  }
});

app.patch("/api/rounds/:id/status", requireAdmin, async (req, res) => {
  const allowed = ["draft", "active", "paused", "closed", "archived"];
  const { status } = req.body;

  if (!allowed.includes(status)) {
    return res.status(400).json({ error: "Invalid round status." });
  }

  const updates = { status };
  if (status === "closed") updates.closed_at = new Date().toISOString();
  if (status === "active") updates.opened_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("rounds")
    .update(updates)
    .eq("id", req.params.id)
    .select()
    .single();

  if (error) return handleError(res, error);
  res.json(data);
});

// ---------- AVAILABLE NUMBERS ----------

app.get("/api/rounds/:id/available", requireAdmin, async (req, res) => {
  try {
    const { data: round, error: roundError } = await supabase
      .from("rounds")
      .select("id, name, max_number, status")
      .eq("id", req.params.id)
      .single();

    if (roundError) throw roundError;

    const { data: allocations, error } = await supabase
      .from("allocations")
      .select("number")
      .eq("round_id", req.params.id)
      .eq("allocation_status", "allocated");

    if (error) throw error;

    const used = new Set(allocations.map(item => item.number));
    const available = [];

    for (let number = 1; number <= round.max_number; number++) {
      if (!used.has(number)) available.push(number);
    }

    res.json({ round, count: available.length, numbers: available });
  } catch (error) {
    handleError(res, error);
  }
});

// ---------- ALLOCATIONS ----------

app.get("/api/rounds/:id/allocations", requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from("allocations")
    .select("*, participants(full_name, phone, telegram_username)")
    .eq("round_id", req.params.id)
    .order("number", { ascending: true });

  if (error) return handleError(res, error);
  res.json(data);
});

app.post("/api/rounds/:id/allocations", requireAdmin, async (req, res) => {
  try {
    const { full_name, phone, telegram_username, number, payment_status } = req.body;
    const selectedNumber = Number(number);

    if (!full_name || !Number.isInteger(selectedNumber) || selectedNumber < 1) {
      return res.status(400).json({ error: "Participant name and a valid number are required." });
    }

    if (!["paid", "unpaid"].includes(payment_status || "unpaid")) {
      return res.status(400).json({ error: "Invalid payment status." });
    }

    const { data: round, error: roundError } = await supabase
      .from("rounds")
      .select("id, status, max_number")
      .eq("id", req.params.id)
      .single();

    if (roundError) throw roundError;

    if (round.status !== "active") {
      return res.status(400).json({ error: "This round is not active." });
    }

    if (selectedNumber > round.max_number) {
      return res.status(400).json({ error: "Number exceeds this round's maximum." });
    }

    const { data: participant, error: participantError } = await supabase
      .from("participants")
      .insert({
        full_name: full_name.trim(),
        phone: phone || null,
        telegram_username: telegram_username || null
      })
      .select()
      .single();

    if (participantError) throw participantError;

    const { data: allocation, error: allocationError } = await supabase
      .from("allocations")
      .insert({
        round_id: req.params.id,
        participant_id: participant.id,
        number: selectedNumber,
        payment_status: payment_status || "unpaid",
        allocation_status: "allocated",
        registered_by: req.user.id,
        updated_by: req.user.id
      })
      .select()
      .single();

    if (allocationError) throw allocationError;

    res.status(201).json({ allocation, participant });
  } catch (error) {
    handleError(res, error);
  }
});

app.patch("/api/allocations/:id/payment", requireAdmin, async (req, res) => {
  const { payment_status } = req.body;

  if (!["paid", "unpaid"].includes(payment_status)) {
    return res.status(400).json({ error: "Payment status must be paid or unpaid." });
  }

  const { data, error } = await supabase
    .from("allocations")
    .update({
      payment_status,
      updated_by: req.user.id
    })
    .eq("id", req.params.id)
    .eq("allocation_status", "allocated")
    .select()
    .single();

  if (error) return handleError(res, error);
  res.json(data);
});

app.patch("/api/allocations/:id/cancel", requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from("allocations")
    .update({
      allocation_status: "cancelled",
      cancelled_at: new Date().toISOString(),
      updated_by: req.user.id
    })
    .eq("id", req.params.id)
    .eq("allocation_status", "allocated")
    .select()
    .single();

  if (error) return handleError(res, error);
  res.json(data);
});

// ---------- CSV REPORTS ----------

function csvCell(value) {
  const text = String(value ?? "");
  return '"' + text.replace(/"/g, '""') + '"';
}

function sendCsv(res, filename, rows, headers) {
  const lines = [
    headers.map(csvCell).join(","),
    ...rows.map(row => headers.map(key => csvCell(row[key])).join(","))
  ];

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send("\uFEFF" + lines.join("\r\n"));
}

app.get("/api/rounds/:id/report.csv", requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from("allocations")
    .select("number, payment_status, allocation_status, registered_at, participants(full_name, phone)")
    .eq("round_id", req.params.id)
    .order("number");

  if (error) return handleError(res, error);

  const rows = data.map(item => ({
    participant_name: item.participants?.full_name || "",
    phone: item.participants?.phone || "",
    payment_status: item.payment_status,
    allocation_status: item.allocation_status,
    number: item.number,
    registered_at: item.registered_at
  }));

  sendCsv(res, "round-report.csv", rows, [
    "participant_name", "phone", "payment_status",
    "allocation_status", "number", "registered_at"
  ]);
});

// ---------- START ----------

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
