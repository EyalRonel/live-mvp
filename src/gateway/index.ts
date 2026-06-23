import { requireEnv } from "../shared/config";
import { setVoiceWebhook, setSmsWebhook } from "../services/twilio/client";
import { createGateway } from "./server";
import { mountSms } from "../channels/sms";
import { mountPhone } from "../channels/phone-call";
import { mountMeet } from "../channels/google-meet";

// One process, one tunnel, all channels: phone + SMS (Twilio) + Google Meet (MeetingBaaS).
async function main() {
  requireEnv("OPENAI_API_KEY");
  requireEnv("TWILIO_ACCOUNT_SID");
  requireEnv("TWILIO_AUTH_TOKEN");
  requireEnv("TWILIO_PHONE_NUMBER");
  requireEnv("BAAS_API_KEY");

  const port = parseInt(process.env.GATEWAY_PORT || "8080", 10);
  const gw = createGateway(port);

  mountSms(gw);
  mountPhone(gw);
  mountMeet(gw);

  await gw.start();

  // Point both Twilio webhooks at this single tunnel.
  await setVoiceWebhook(`${gw.urls.https}/voice`);
  await setSmsWebhook(`${gw.urls.https}/sms`);

  const number = process.env.TWILIO_PHONE_NUMBER;
  console.log(`\n✅ Gateway live at ${gw.urls.https}`);
  console.log(`📞 Call or text ${number} to reach the agent.`);
  console.log(
    `🎥 Join a meeting:\n   curl -XPOST ${gw.urls.https}/meet/join ` +
      `-H 'content-type: application/json' ` +
      `-d '{"meetingUrl":"https://meet.google.com/xxx-yyyy-zzz"}'`
  );
  console.log("(Ctrl+C to stop)");

  const shutdown = () => {
    console.log("\nShutting down...");
    gw.server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
