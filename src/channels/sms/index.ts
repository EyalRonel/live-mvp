import { requireEnv } from "../../shared/config";
import { setSmsWebhook, sendSms } from "../../services/twilio/client";
import { messageTwiml } from "../../services/twilio/messaging";
import { respond } from "../../agent/brain";
import { getHistory, append } from "./memory";
import { Gateway, createGateway } from "../../gateway/server";

export function mountSms(gw: Gateway): void {
  // Twilio messaging webhook -> brain -> TwiML <Message> reply.
  gw.app.post("/sms", async (req, res) => {
    const from = (req.body?.From as string) || "";
    const text = ((req.body?.Body as string) || "").trim();
    console.log(`\n✉️  ${from}: ${text}`);
    let reply = "Sorry, something went wrong.";
    try {
      reply = await respond(text, { channel: "sms", from, history: getHistory(from) });
      append(from, { role: "user", content: text });
      append(from, { role: "assistant", content: reply });
      console.log(`🤖 → ${from}: ${reply}`);
    } catch (err) {
      console.error("SMS reply failed:", err);
    }
    res.type("text/xml").send(messageTwiml(reply));
  });
}

// Standalone: `npm run sms` (inbound) or `npm run sms -- <number> <message>` (outbound).
async function main() {
  requireEnv("TWILIO_ACCOUNT_SID");
  requireEnv("TWILIO_AUTH_TOKEN");
  requireEnv("TWILIO_PHONE_NUMBER");

  const to = process.argv[2];
  const message = process.argv.slice(3).join(" ");
  if (to) {
    if (!message) {
      console.error('Usage: npm run sms -- <number> "<message>"');
      process.exit(1);
    }
    const sid = await sendSms(to, message);
    console.log(`✉️  Sent to ${to} (message ${sid})`);
    process.exit(0);
  }

  requireEnv("OPENAI_API_KEY");
  const gw = createGateway(parseInt(process.env.SMS_PORT || "8082", 10));
  mountSms(gw);
  await gw.start();
  const smsUrl = `${gw.urls.https}/sms`;
  await setSmsWebhook(smsUrl);
  console.log(`SMS webhook set to ${smsUrl}`);
  console.log(`✉️  Ready. Text ${process.env.TWILIO_PHONE_NUMBER} to chat. (Ctrl+C to stop)`);
  process.on("SIGINT", () => process.exit(0));
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
