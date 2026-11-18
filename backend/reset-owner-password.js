require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const readline = require("readline");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false } }
);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.question("Enter your new password: ", async (password) => {
  if (!password || password.length < 6) {
    console.log("Password must contain at least 6 characters.");
    rl.close();
    return;
  }

  const { data, error } = await supabase.auth.admin.updateUserById(
    "0ce05c4c-b760-4a02-85d5-9d04eef54bca",
    { password }
  );

  if (error) {
    console.log("Password update failed:", error.message);
  } else {
    console.log("SUCCESS: Your password has been changed.");
  }

  rl.close();
});
