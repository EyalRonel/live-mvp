import { DEBUG, requireEnv } from "../../shared/config";
import { WAKE_TERMS } from "../../shared/persona";
import { bridge } from "../../core/bridge";
import { respond } from "../../agent/brain";
import { RealtimeAgent } from "../../services/openai/realtime-agent";
import { createBot, leaveBot, SAMPLE_RATE } from "../../services/meetingbaas/client";
import { MeetTransport } from "./meet-transport";
import { Gateway, createGateway } from "../../gateway/server";

// Bots created via /meet/join (or standalone), correlated FIFO to the next /meet
// WebSocket connection. Fine for the POC (typically one meeting at a time).
const pendingBots: string[] = [];

/** Create a MeetingBaaS bot pointed at this gateway's /meet WS. */
export async function joinMeeting(gw: Gateway, meetingUrl: string): Promise<string> {
  const botId = await createBot(meetingUrl, `${gw.urls.wss}/meet`);
  pendingBots.push(botId);
  console.log(`Bot created for ${meetingUrl}, waiting to be admitted`);
  return botId;
}

export function mountMeet(gw: Gateway): void {
  // On-demand join (Meet needs a URL, so it's an action, not always-on).
  gw.app.post("/meet/join", async (req, res) => {
    const meetingUrl = req.body?.meetingUrl;
    if (!meetingUrl || !/^https:\/\/meet\.google\.com\//.test(meetingUrl)) {
      res.status(400).json({ error: "meetingUrl (https://meet.google.com/...) required" });
      return;
    }
    try {
      const botId = await joinMeeting(gw, meetingUrl);
      res.json({ ok: true, botId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // The bot connecting = admitted and streaming.
  gw.onWs("/meet", (ws) => {
    const botId = pendingBots.shift();
    const transport = new MeetTransport(ws);
    console.log("Bot admitted, starting conversation");
    transport.on("error", (e) => console.error("Meeting socket error:", e));
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
    void startMeetAgent(transport, botId);
  });
}

async function startMeetAgent(transport: MeetTransport, botId?: string): Promise<void> {
  const agent = new RealtimeAgent({
    respond, // shared brain
    channel: "meet",
    from: "meeting",
    audioFormat: { kind: "pcm16", rate: 24000 },
    wakeWord: { terms: WAKE_TERMS }, // Meet: only respond when addressed by name
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
  transport.on("closed", async () => {
    if (botId) await leaveBot(botId);
  });
  console.log("Audio bridge live (meet). Address the bot by name.");
}

// Standalone: npm run meet -- https://meet.google.com/xxx-yyyy-zzz
async function main() {
  const meetingUrl = process.argv[2];
  if (!meetingUrl || !/^https:\/\/meet\.google\.com\//.test(meetingUrl)) {
    console.error("Usage: npm run meet -- https://meet.google.com/xxx-yyyy-zzz");
    process.exit(1);
  }
  requireEnv("OPENAI_API_KEY");
  requireEnv("BAAS_API_KEY");
  const gw = createGateway(parseInt(process.env.PORT || "8080", 10));
  mountMeet(gw);
  await gw.start();
  console.log(`Listening for meeting audio on ${gw.urls.wss}/meet`);
  await joinMeeting(gw, meetingUrl);
  console.log("Bot created, waiting to be admitted to the meeting");
  process.on("SIGINT", () => process.exit(0));
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
