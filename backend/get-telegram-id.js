require("dotenv").config();

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    console.log("Telegram token missing from backend/.env");
    return;
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/getUpdates`
  );

  const result = await response.json();

  if (!result.ok || !result.result.length) {
    console.log("No messages found. Send /start to your bot and try again.");
    return;
  }

  for (const update of result.result) {
    const user = update.message?.from;
    if (user) {
      console.log("Telegram ID:", user.id);
      console.log("Username:", user.username || "No username");
    }
  }
}

main().catch(console.error);
