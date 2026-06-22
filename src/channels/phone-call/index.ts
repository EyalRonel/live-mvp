import http from "http";
import { WebSocketServer } from "ws";
import { requireEnv } from "../../shared/config";
import { startTunnel } from "../../shared/tunnel";
import { buildSystemPrompt } from "../../shared/persona";
import { bridge } from "../../core/bridge";
import { RealtimeAgent } from "../../services/openai/realtime-agent";
import { setVoiceWebhook, placeCall } from "../../services/twilio/client";
import { connectStreamTwiml } from "../../services/twilio/twiml";
import { CallTransport } from "./call-transport";

async function main() {
  requireEnv("OPENAI_API_KEY");
  requireEnv("TWILIO_ACCOUNT_SID");
  requireEnv("TWILIO_AUTH_TOKEN");
  requireEnv("TWILIO_PHONE_NUMBER");

  const callTo = process.argv[2]; // optional outbound destination, E.164
  const port = parseInt(process.env.PHONE_PORT || "8081", 10);

  // Set once the tunnel is up; the /voice handler reads it per request.
  let mediaWsUrl = "";

  // HTTP server: serves the TwiML voice webhook; upgrades /media to a WebSocket.
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url?.startsWith("/voice")) {
      res.writeHead(200, { "Content-Type": "text/xml" });
      res.end(connectStreamTwiml(mediaWsUrl));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (req.url?.startsWith("/media")) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
    } else {
      socket.destroy();
    }
  });

  // Each Twilio media connection = one call = one agent.
  wss.on("connection", (ws) => {
    const transport = new CallTransport(ws);
    transport.on("error", (e) => console.error("Call socket error:", e));
    transport.once("connected", async () => {
      console.log("Call connected, starting conversation");
      const agent = new RealtimeAgent({
        instructions: buildSystemPrompt("phone"),
        audioFormat: { kind: "pcmu", rate: 8000 },
        voice: "alloy",
        greetOnReady: true, // natural conversation; agent greets the caller first
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

  await new Promise<void>((resolve) => server.listen(port, resolve));

  // Public URLs (Twilio reaches us through the tunnel).
  const { url, wsUrl } = await startTunnel(port);
  mediaWsUrl = `${wsUrl}/media`;
  const voiceUrl = `${url}/voice`;
  await setVoiceWebhook(voiceUrl);
  console.log(`Voice webhook set to ${voiceUrl}`);

  const number = process.env.TWILIO_PHONE_NUMBER;
  if (callTo) {
    const sid = await placeCall(callTo, voiceUrl);
    console.log(`📞 Calling ${callTo} from ${number}... (call ${sid})`);
  } else {
    console.log(`📞 Ready. Call ${number} to talk to the agent. (Ctrl+C to stop)`);
  }

  const shutdown = () => {
    console.log("\nShutting down...");
    wss.close();
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
