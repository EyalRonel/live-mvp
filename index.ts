import * as dotenv from "dotenv";
dotenv.config();

import { createBot, leaveBot, MeetingAudioServer, SAMPLE_RATE } from "./meeting-bot";
import { RealtimeAgent } from "./agent";

const DEBUG = !!process.env.DEBUG;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return v;
}

/**
 * MeetingBaaS connects TO us, so we need a public wss:// URL pointing at our
 * local WebSocket server. Either use a tunnel we open via ngrok (NGROK_AUTHTOKEN)
 * or a public URL the user provides (PUBLIC_WS_URL, e.g. their own tunnel).
 */
async function startTunnel(port: number): Promise<string> {
  const explicit = process.env.PUBLIC_WS_URL;
  if (explicit) return explicit;

  const token = process.env.NGROK_AUTHTOKEN;
  if (!token) {
    console.error(
      "Need a public WebSocket URL for MeetingBaaS to reach you. Set either:\n" +
        "  NGROK_AUTHTOKEN  — auto-open an ngrok tunnel (free at ngrok.com), or\n" +
        "  PUBLIC_WS_URL    — a wss:// URL from your own tunnel"
    );
    process.exit(1);
  }

  const ngrok = await import("@ngrok/ngrok");
  const listener = await ngrok.forward({ addr: port, authtoken: token });
  const httpsUrl = listener.url();
  if (!httpsUrl) throw new Error("ngrok did not return a public URL");
  return httpsUrl.replace(/^https:/, "wss:");
}

async function main() {
  // 1. Validate inputs.
  const meetingUrl = process.argv[2];
  if (!meetingUrl || !/^https:\/\/meet\.google\.com\//.test(meetingUrl)) {
    console.error(
      "Usage: npx ts-node index.ts https://meet.google.com/xxx-yyyy-zzz"
    );
    process.exit(1);
  }
  requireEnv("OPENAI_API_KEY");
  requireEnv("BAAS_API_KEY");

  const port = parseInt(process.env.PORT || "8080", 10);

  let botId: string | undefined;
  const server = new MeetingAudioServer(port);
  let agent: RealtimeAgent | undefined;
  let shuttingDown = false;

  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nShutting down (${reason})...`);
    agent?.close();
    server.close();
    if (botId) await leaveBot(botId);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("Ctrl+C"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // 2. Open the public tunnel to our local WS server.
  const publicWsUrl = await startTunnel(port);
  console.log(`Listening for meeting audio on ${publicWsUrl}`);

  // 3. Create the MeetingBaaS bot pointed at our tunnel.
  botId = await createBot(meetingUrl, publicWsUrl);
  console.log("Bot created, waiting to be admitted to the meeting");

  server.on("error", (err) => console.error("Meeting socket error:", err));
  server.on("speakers", (arr: any[]) => {
    const talking = arr.filter((s) => s.isSpeaking).map((s) => s.name);
    if (talking.length) console.log(`🎙️  Speaking: ${talking.join(", ")}`);
  });
  server.on("handshake", (msg: any) => {
    if (DEBUG) console.log("MeetingBaaS handshake:", JSON.stringify(msg));
    if (msg?.sample_rate && msg.sample_rate !== SAMPLE_RATE) {
      console.warn(
        `⚠️  Bot sample_rate ${msg.sample_rate} != expected ${SAMPLE_RATE}; audio may sound off.`
      );
    }
  });

  if (DEBUG) {
    let rxFrames = 0;
    let rxBytes = 0;
    server.on("audio", (pcm: Buffer) => {
      rxFrames++;
      rxBytes += pcm.length;
      if (rxFrames === 1) {
        console.log(`📥 first audio frame from MeetingBaaS (${pcm.length} bytes)`);
      } else if (rxFrames % 100 === 0) {
        console.log(`📥 ${rxFrames} audio frames received (${rxBytes} bytes total)`);
      }
    });
  }

  // 4. The bot connecting = it was admitted and is streaming. Start the agent.
  server.once("connected", async () => {
    console.log("Bot admitted, starting conversation");

    agent = new RealtimeAgent();
    try {
      await new Promise<void>((resolve, reject) => {
        agent!.once("ready", resolve);
        agent!.once("error", reject);
      });
    } catch (err) {
      console.error("Failed to start OpenAI session:", err);
      return void shutdown("OpenAI session failed");
    }

    // 5. Bridge audio both directions (both sides are PCM16 mono @ 24kHz).
    server.on("audio", (pcm: Buffer) => agent!.appendAudio(pcm)); // meeting -> OpenAI
    agent.on("audio", (pcm: Buffer) => server.sendAudio(pcm)); //    OpenAI -> meeting

    agent.on("close", () => void shutdown("OpenAI socket closed"));
    agent.on("error", (err) => console.error("OpenAI error:", err));

    console.log("Audio bridge live. Talk to the bot in the meeting. (Ctrl+C to stop)");
  });

  // 6. Meeting ended / bot removed.
  server.on("disconnected", () => void shutdown("Meeting ended / bot left"));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
