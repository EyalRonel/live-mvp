import { requireEnv } from "../../shared/config";
import { bridge } from "../../core/bridge";
import { respond } from "../../agent/brain";
import { RealtimeAgent } from "../../services/openai/realtime-agent";
import { setVoiceWebhook, placeCall } from "../../services/twilio/client";
import { connectStreamTwiml } from "../../services/twilio/twiml";
import { CallTransport } from "./call-transport";
import { Gateway, createGateway } from "../../gateway/server";

export function mountPhone(gw: Gateway): void {
  // Twilio voice webhook (inbound + outbound both fetch this) -> media stream TwiML.
  gw.app.post("/voice", (req, res) => {
    const from = (req.body?.From as string) || undefined;
    res.type("text/xml").send(connectStreamTwiml(`${gw.urls.wss}/media`, from));
  });

  // One Twilio media connection = one call = one agent.
  gw.onWs("/media", (ws) => {
    const transport = new CallTransport(ws);
    transport.on("error", (e) => console.error("Call socket error:", e));
    transport.once("connected", async () => {
      console.log(`Call connected (${transport.caller}), starting conversation`);
      const agent = new RealtimeAgent({
        respond, // shared brain
        channel: "phone",
        from: transport.caller,
        audioFormat: { kind: "pcmu", rate: 8000 },
        greetOnReady: true, // greet the caller first
      });
      try {
        await new Promise<void>((resolve, reject) => {
          agent.once("ready", resolve);
          agent.once("error", reject);
        });
      } catch (err) {
        console.error("Failed to start OpenAI session:", err);
        transport.close();
        return;
      }
      bridge(transport, agent);
      agent.on("error", (e) => console.error("OpenAI error:", e));
      console.log("Audio bridge live for this call.");
    });
  });
}

// Standalone: `npm run phone` (inbound) or `npm run phone -- +1555...` (outbound).
async function main() {
  requireEnv("OPENAI_API_KEY");
  requireEnv("TWILIO_ACCOUNT_SID");
  requireEnv("TWILIO_AUTH_TOKEN");
  requireEnv("TWILIO_PHONE_NUMBER");
  const callTo = process.argv[2];
  const gw = createGateway(parseInt(process.env.PHONE_PORT || "8081", 10));
  mountPhone(gw);
  await gw.start();
  const voiceUrl = `${gw.urls.https}/voice`;
  await setVoiceWebhook(voiceUrl);
  console.log(`Voice webhook set to ${voiceUrl}`);
  const number = process.env.TWILIO_PHONE_NUMBER;
  if (callTo) {
    const sid = await placeCall(callTo, voiceUrl);
    console.log(`📞 Calling ${callTo} from ${number}... (call ${sid})`);
  } else {
    console.log(`📞 Ready. Call ${number} to talk to the agent. (Ctrl+C to stop)`);
  }
  process.on("SIGINT", () => process.exit(0));
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
