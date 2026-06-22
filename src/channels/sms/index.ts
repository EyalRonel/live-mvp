import http from "http";
import { requireEnv } from "../../shared/config";
import { startTunnel } from "../../shared/tunnel";
import { setSmsWebhook, sendSms } from "../../services/twilio/client";
import { parseInboundSms, messageTwiml } from "../../services/twilio/messaging";
import { replyTo } from "../../services/openai/text-agent";
import { getHistory, append } from "./memory";

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

async function main() {
  requireEnv("TWILIO_ACCOUNT_SID");
  requireEnv("TWILIO_AUTH_TOKEN");
  requireEnv("TWILIO_PHONE_NUMBER");

  // Outbound mode: `npm run sms -- <number> <message...>` sends a literal text and exits.
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

  // Inbound mode: run the webhook server and reply with the LLM.
  requireEnv("OPENAI_API_KEY");
  const port = parseInt(process.env.SMS_PORT || "8082", 10);

  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.startsWith("/sms")) {
      res.writeHead(404);
      res.end();
      return;
    }
    const { from, text } = parseInboundSms(await readBody(req));
    console.log(`\n✉️  ${from}: ${text}`);
    let reply = "Sorry, something went wrong.";
    try {
      append(from, { role: "user", content: text });
      reply = await replyTo(getHistory(from));
      append(from, { role: "assistant", content: reply });
      console.log(`🤖 → ${from}: ${reply}`);
    } catch (err) {
      console.error("SMS reply failed:", err);
    }
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(messageTwiml(reply));
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));
  const { url } = await startTunnel(port);
  const smsUrl = `${url}/sms`;
  await setSmsWebhook(smsUrl);
  console.log(`SMS webhook set to ${smsUrl}`);
  console.log(`✉️  Ready. Text ${process.env.TWILIO_PHONE_NUMBER} to chat. (Ctrl+C to stop)`);

  const shutdown = () => {
    console.log("\nShutting down...");
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
