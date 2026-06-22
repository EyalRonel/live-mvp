import readline from "readline";
import { requireEnv } from "../../shared/config";
import { respond, Msg } from "../../agent/brain";

// Local chat with the agent brain — no Twilio, no carrier. Iterate on brain.ts here.
requireEnv("OPENAI_API_KEY");

const history: Msg[] = [];
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "you   > " });

console.log("Local brain simulator (channel=sms). Type a message; Ctrl+C to quit.\n");
rl.prompt();

rl.on("line", async (line) => {
  const text = line.trim();
  if (!text) return rl.prompt();
  try {
    const reply = await respond(text, { channel: "sms", from: "+local", history });
    history.push({ role: "user", content: text }, { role: "assistant", content: reply });
    console.log(`rally > ${reply}\n`);
  } catch (err) {
    console.error("error:", (err as Error).message, "\n");
  }
  rl.prompt();
});

rl.on("close", () => process.exit(0));
