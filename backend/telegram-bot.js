require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");
const { generateReport } = require("./pdf-reports");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false } }
);

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMINS = (process.env.TELEGRAM_ADMIN_IDS || "")
  .split(",")
  .map(id => id.trim())
  .filter(Boolean);

const API = `https://api.telegram.org/bot${TOKEN}`;
const conversations = new Map();
let offset = 0;

// TELEGRAM API

async function telegram(method, body = {}) {
  const response = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const result = await response.json();

  if (!result.ok) {
    throw new Error(result.description || "Telegram API error");
  }

  return result.result;
}

async function send(chatId, text) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text: String(text).slice(0, 4000)
  });
}

// ROUND FUNCTIONS

async function activeRound() {
  const { data, error } = await supabase
    .from("rounds")
    .select("id,name,max_number,status")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function availableNumbers(round) {
  const { data, error } = await supabase
    .from("allocations")
    .select("number")
    .eq("round_id", round.id)
    .eq("allocation_status", "allocated");

  if (error) throw error;

  const used = new Set(
    (data || []).map(item => Number(item.number))
  );

  const result = [];

  for (let n = 1; n <= round.max_number; n++) {
    if (!used.has(n)) result.push(n);
  }

  return result;
}

async function sendNumberList(chatId, round) {
  const numbers = await availableNumbers(round);

  if (!numbers.length) {
    return send(chatId, `No numbers are available in ${round.name}.`);
  }

  const header =
    `AVAILABLE NUMBERS\nRound: ${round.name}\n` +
    `Available: ${numbers.length}\n\n`;

  let chunk = header;

  for (const number of numbers) {
    const item = `${number}, `;

    if (chunk.length + item.length > 3500) {
      await send(chatId, chunk);
      chunk = "";
    }

    chunk += item;
  }

  if (chunk) await send(chatId, chunk);

  return true;
}

// REGISTRATION CONVERSATION

async function registerStep(chatId, text, telegramUser) {
  const state = conversations.get(chatId);

  if (!state) return false;

  // Allow commands to be handled normally.
  if (text.startsWith("/")) return false;

  if (state.step === "name") {
    const name = text.trim();

    if (name.length < 2) {
      await send(chatId, "Please enter a valid full name.");
      return true;
    }

    state.full_name = name;
    state.step = "phone";

    await send(chatId, "Enter the participant's phone number:");
    return true;
  }

  if (state.step === "phone") {
    const phone = text.trim();

    if (!/^\+?[0-9\s-]{7,20}$/.test(phone)) {
      await send(chatId, "Invalid phone number. Please try again.");
      return true;
    }

    state.phone = phone;
    state.step = "number";

    await send(
      chatId,
      `Enter the number to allocate (1-${state.round.max_number}):`
    );

    return true;
  }

  if (state.step === "number") {
    const number = Number(text);

    if (
      !Number.isInteger(number) ||
      number < 1 ||
      number > state.round.max_number
    ) {
      await send(
        chatId,
        `Enter a valid number between 1 and ${state.round.max_number}.`
      );
      return true;
    }

    const { data, error } = await supabase
      .from("allocations")
      .select("id")
      .eq("round_id", state.round.id)
      .eq("number", number)
      .eq("allocation_status", "allocated")
      .maybeSingle();

    if (error) throw error;

    if (data) {
      await send(chatId, `Number ${number} is already allocated. Enter another number:`);
      return true;
    }

    state.number = number;
    state.step = "payment";

    await send(
      chatId,
      `Number ${number} selected.\n\nIs the payment paid or unpaid?\nReply with: paid or unpaid`
    );

    return true;
  }

  if (state.step === "payment") {
    const paymentStatus = text.toLowerCase().trim();

    if (!["paid", "unpaid"].includes(paymentStatus)) {
      await send(chatId, "Please reply with either paid or unpaid.");
      return true;
    }

    // Recheck round status and number availability.
    const { data: round, error: roundError } = await supabase
      .from("rounds")
      .select("id,max_number,status")
      .eq("id", state.round.id)
      .single();

    if (roundError) throw roundError;

    if (round.status !== "active") {
      conversations.delete(chatId);
      await send(chatId, "This round is no longer active. Registration cancelled.");
      return true;
    }

    // Create participant.
    const { data: participant, error: participantError } = await supabase
      .from("participants")
      .insert({
        full_name: state.full_name,
        phone: state.phone
      })
      .select("id")
      .single();

    if (participantError) throw participantError;

    // Create allocation.
    const { data: allocation, error: allocationError } = await supabase
      .from("allocations")
      .insert({
        round_id: state.round.id,
        participant_id: participant.id,
        number: state.number,
        payment_status: paymentStatus,
        allocation_status: "allocated"
      })
      .select("id")
      .single();

    if (allocationError) {
      // Remove unused participant record if allocation failed.
      await supabase
        .from("participants")
        .delete()
        .eq("id", participant.id);

      if (allocationError.code === "23505") {
        await send(chatId, "Sorry, that number was just allocated to someone else. Start again with /register.");
        conversations.delete(chatId);
        return true;
      }

      throw allocationError;
    }

    conversations.delete(chatId);

    await send(
      chatId,
      `REGISTRATION SUCCESSFUL\n\n` +
      `Name: ${state.full_name}\n` +
      `Phone: ${state.phone}\n` +
      `Round: ${state.round.name}\n` +
      `Number: ${state.number}\n` +
      `Payment: ${paymentStatus.toUpperCase()}\n\n` +
      `Registration saved successfully.`
    );

    return true;
  }

  return false;
}

// PAYMENT UPDATE

async function updatePayment(chatId, number, status) {
  const round = await activeRound();

  if (!round) {
    return send(chatId, "There is no active round.");
  }

  const { data: allocation, error: findError } = await supabase
    .from("allocations")
    .select("id,participant_id")
    .eq("round_id", round.id)
    .eq("number", number)
    .eq("allocation_status", "allocated")
    .maybeSingle();

  if (findError) throw findError;

  if (!allocation) {
    return send(chatId, `Number ${number} is not allocated.`);
  }

  const { error: updateError } = await supabase
    .from("allocations")
    .update({ payment_status: status })
    .eq("id", allocation.id);

  if (updateError) throw updateError;

  return send(
    chatId,
    `Number ${number} payment status updated to ${status.toUpperCase()}.`
  );
}

// MESSAGE HANDLER

async function handleMessage(message) {
  const chatId = message.chat.id;
  const userId = String(message.from.id);
  const text = (message.text || "").trim();

  if (!ADMINS.includes(userId)) {
    return send(chatId, "Access denied. You are not an authorized administrator.");
  }

  if (await registerStep(chatId, text, message.from)) return;

  const [command, argument] = text.split(/\s+/);
  const cmd = (command || "").toLowerCase().split("@")[0];

  // HELP

  if (cmd === "/start" || cmd === "/help") {
    return send(
      chatId,
      "NUMBER ALLOCATION MANAGER\n\n" +
      "/round - Show active round\n" +
      "/available - List available numbers\n" +
      "/publish - Publish available numbers here\n" +
      "/check 25 - Check a number\n" +
      "/register - Register a participant\n" +
      "/paid 25 - Mark number paid\n" +
      "/unpaid 25 - Mark number unpaid\n" +
      "/cancel - Cancel current registration\n\n" +
      "PDF DOWNLOADS:\n" +
      "/pdf_available - Download available numbers\n" +
      "/pdf_registrations - Download registrations\n" +
      "/pdf_paid - Download paid report\n" +
      "/pdf_unpaid - Download unpaid report\n" +
      "/pdf_round - Download current round report\n" +
      "/pdf_all - Download all rounds report"
    );
  }

  // CANCEL

  if (cmd === "/cancel") {
    conversations.delete(chatId);
    return send(chatId, "Current registration cancelled.");
  }

  // ACTIVE ROUND

  if (cmd === "/round") {
    const round = await activeRound();

    if (!round) {
      return send(chatId, "There is no active round.");
    }

    const numbers = await availableNumbers(round);

    return send(
      chatId,
      `ACTIVE ROUND: ${round.name}\n` +
      `Maximum number: ${round.max_number}\n` +
      `Available: ${numbers.length}\n` +
      `Allocated: ${round.max_number - numbers.length}`
    );
  }

  // AVAILABLE NUMBERS

  if (cmd === "/available" || cmd === "/publish") {
    const round = await activeRound();

    if (!round) {
      return send(chatId, "There is no active round.");
    }

    return sendNumberList(chatId, round);
  }

  // CHECK NUMBER

  if (cmd === "/check") {
    const number = Number(argument);

    if (!Number.isInteger(number) || number < 1) {
      return send(chatId, "Usage: /check 25");
    }

    const round = await activeRound();

    if (!round) {
      return send(chatId, "There is no active round.");
    }

    if (number > round.max_number) {
      return send(chatId, "That number is outside this round.");
    }

    const { data, error } = await supabase
      .from("allocations")
      .select("payment_status")
      .eq("round_id", round.id)
      .eq("number", number)
      .eq("allocation_status", "allocated")
      .maybeSingle();

    if (error) throw error;

    return send(
      chatId,
      data
        ? `Number ${number} is ALLOCATED. Payment: ${data.payment_status}.`
        : `Number ${number} is AVAILABLE.`
    );
  }

  // PDF REPORTS

  const pdfCommands = {
    "/pdf_available": "available",
    "/pdf_registrations": "registrations",
    "/pdf_paid": "paid",
    "/pdf_unpaid": "unpaid",
    "/pdf_round": "round",
    "/pdf_all": "all"
  };

  if (pdfCommands[cmd]) {
    await send(chatId, "Generating your PDF report...");

    return generateReport(
      chatId,
      pdfCommands[cmd],
      { supabase, API, activeRound, availableNumbers }
    );
  }

  // START REGISTRATION

  if (cmd === "/register") {
    const round = await activeRound();

    if (!round) {
      return send(chatId, "There is no active round.");
    }

    conversations.set(chatId, {
      step: "name",
      round
    });

    return send(chatId, "Enter the participant's full name:");
  }

  // PAYMENT COMMANDS

  if (cmd === "/paid" || cmd === "/unpaid") {
    const number = Number(argument);

    if (!Number.isInteger(number) || number < 1) {
      return send(chatId, `Usage: ${cmd} 25`);
    }

    return updatePayment(
      chatId,
      number,
      cmd === "/paid" ? "paid" : "unpaid"
    );
  }

  return send(chatId, "Unknown command. Send /help to see available commands.");
}

// BOT STARTUP

async function main() {
  if (!TOKEN || !ADMINS.length) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_ADMIN_IDS in .env");
  }

  const me = await telegram("getMe");

  console.log(`Telegram bot running: @${me.username}`);
  console.log("Authorized administrator IDs:", ADMINS.join(", "));

  while (true) {
    try {
      const updates = await telegram("getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message"]
      });

      for (const update of updates) {
        offset = update.update_id + 1;

        if (update.message?.text) {
          try {
            await handleMessage(update.message);
          } catch (error) {
            console.error("Message error:", error.message);

            await send(
              update.message.chat.id,
              `Error: ${error.message}`
            );
          }
        }
      }
    } catch (error) {
      console.error("Polling error:", error.message);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
