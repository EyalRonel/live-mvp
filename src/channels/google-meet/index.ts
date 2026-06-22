import { DEBUG, requireEnv } from "../../shared/config";
import { startTunnel } from "../../shared/tunnel";
import { WAKE_TERMS } from "../../shared/persona";
import { bridge } from "../../core/bridge";
import { respond } from "../../agent/brain";
import { RealtimeAgent } from "../../services/openai/realtime-agent";
import { createBot, leaveBot, SAMPLE_RATE } from "../../services/meetingbaas/client";
import { MeetTransport } from "./meet-transport";

async function main() {
  // 1. Validate inputs.
  const meetingUrl = process.argv[2];
  if (!meetingUrl || !/^https:\/\/meet\.google\.com\//.test(meetingUrl)) {
    console.error("Usage: npm run meet -- https://meet.google.com/xxx-yyyy-zzz");
    process.exit(1);
  }
  requireEnv("OPENAI_API_KEY");
  requireEnv("BAAS_API_KEY");

  const port = parseInt(process.env.PORT || "8080", 10);

  let botId: string | undefined;
  const transport = new MeetTransport(port);
  let agent: RealtimeAgent | undefined;
  let shuttingDown = false;

  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nShutting down (${reason})...`);
    agent?.close();
    transport.close();
    if (botId) await leaveBot(botId);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("Ctrl+C"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // 2. Open the public tunnel to our local WS server.
  const { wsUrl } = await startTunnel(port);
  console.log(`Listening for meeting audio on ${wsUrl}`);

  // 3. Create the MeetingBaaS bot pointed at our tunnel.
  botId = await createBot(meetingUrl, wsUrl);
  console.log("Bot created, waiting to be admitted to the meeting");

  transport.on("error", (err) => console.error("Meeting socket error:", err));
  transport.on("speakers", (arr: any[]) => {
    const talking = arr.filter((s) => s.isSpeaking).map((s) => s.name);
    if (talking.length) console.log(`🎙️  Speaking: ${talking.join(", ")}`);
  });
  transport.on("handshake", (msg: any) => {
    if (DEBUG) console.log("MeetingBaaS handshake:", JSON.stringify(msg));
    if (msg?.sample_rate && msg.sample_rate !== SAMPLE_RATE) {
      console.warn(`⚠️  Bot sample_rate ${msg.sample_rate} != expected ${SAMPLE_RATE}.`);
    }
  });

  // 4. The bot connecting = it was admitted and is streaming. Start the agent.
  transport.once("connected", async () => {
    console.log("Bot admitted, starting conversation");
    agent = new RealtimeAgent({
      respond, // the shared brain
      channel: "meet",
      from: "meeting",
      audioFormat: { kind: "pcm16", rate: 24000 },
      wakeWord: { terms: WAKE_TERMS }, // Meet: only respond when addressed by name
    });
    try {
      await new Promise<void>((resolve, reject) => {
        agent!.once("ready", resolve);
        agent!.once("error", reject);
      });
    } catch (err) {
      console.error("Failed to start OpenAI session:", err);
      return void shutdown("OpenAI session failed");
    }

    // 5. Bridge audio both directions (both sides PCM16 mono @ 24kHz).
    bridge(transport, agent);
    agent.on("close", () => void shutdown("OpenAI socket closed"));
    agent.on("error", (err) => console.error("OpenAI error:", err));
    console.log("Audio bridge live. Talk to the bot in the meeting. (Ctrl+C to stop)");
  });

  // 6. Meeting ended / bot removed.
  transport.on("closed", () => void shutdown("Meeting ended / bot left"));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
