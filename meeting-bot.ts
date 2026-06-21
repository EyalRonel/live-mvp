import WebSocket, { WebSocketServer } from "ws";
import { EventEmitter } from "events";

const BAAS_API_KEY = process.env.BAAS_API_KEY || "";
const BAAS_BASE = "https://api.meetingbaas.com/v2";

// MeetingBaaS streams raw PCM s16le mono. We use 24kHz so it matches the OpenAI
// Realtime API exactly — no resampling needed in either direction.
export const SAMPLE_RATE = 24000;

function authHeaders() {
  return {
    "x-meeting-baas-api-key": BAAS_API_KEY,
    "Content-Type": "application/json",
  };
}

/**
 * Create a MeetingBaaS bot and send it into the meeting, configured to stream
 * bidirectional audio to/from `publicWsUrl` (a single bidirectional socket).
 * Returns the bot_id.
 */
export async function createBot(
  meetingUrl: string,
  publicWsUrl: string
): Promise<string> {
  const res = await fetch(`${BAAS_BASE}/bots`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      meeting_url: meetingUrl,
      bot_name: process.env.AGENT_NAME?.trim() || "Rall",
      streaming_enabled: true,
      streaming_config: {
        // Same URL for both => one bidirectional WebSocket connection.
        // output_url: bot SENDS meeting audio here (we receive).
        // input_url:  bot RECEIVES audio here to speak (we send).
        output_url: publicWsUrl,
        input_url: publicWsUrl,
        audio_frequency: SAMPLE_RATE,
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MeetingBaaS createBot failed (${res.status}): ${text}`);
  }
  const json: any = await res.json();
  const botId = json?.data?.bot_id || json?.bot_id;
  if (!botId) {
    throw new Error(`MeetingBaaS createBot: no bot_id in response: ${JSON.stringify(json)}`);
  }
  return botId;
}

/** Instruct the bot to leave the meeting (best-effort, for shutdown). */
export async function leaveBot(botId: string): Promise<void> {
  try {
    await fetch(`${BAAS_BASE}/bots/${botId}/leave`, {
      method: "POST",
      headers: authHeaders(),
    });
  } catch {
    // best-effort
  }
}

/**
 * WebSocket SERVER that MeetingBaaS connects to. (Unlike Recall, the provider
 * dials us, so we listen.) One bidirectional connection carries everything.
 *
 * Emits:
 *   "connected"             — bot joined & started streaming (i.e. admitted)
 *   "handshake" (msg)       — initial JSON handshake {bot_id, sample_rate, ...}
 *   "speakers" (arr)        — speaker-state JSON updates
 *   "audio" (pcm: Buffer)   — PCM16 mono @ SAMPLE_RATE from the meeting
 *   "disconnected"          — connection closed (meeting ended / bot left)
 *   "error" (err)
 */
export class MeetingAudioServer extends EventEmitter {
  private wss: WebSocketServer;
  private conn?: WebSocket;
  private gotHandshake = false;

  constructor(port: number) {
    super();
    this.wss = new WebSocketServer({ port });
    this.wss.on("connection", (ws) => {
      // If a second connection arrives, keep the first.
      if (this.conn && this.conn.readyState === WebSocket.OPEN) {
        ws.close();
        return;
      }
      this.conn = ws;
      this.gotHandshake = false;
      this.emit("connected");

      ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
        if (isBinary) {
          this.emit("audio", data as Buffer);
          return;
        }
        // Text frame: either the one-time handshake or speaker-state array.
        let msg: any;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (Array.isArray(msg)) {
          this.emit("speakers", msg);
        } else if (!this.gotHandshake) {
          this.gotHandshake = true;
          this.emit("handshake", msg);
        }
      });

      ws.on("close", () => this.emit("disconnected"));
      ws.on("error", (err) => this.emit("error", err));
    });
    this.wss.on("error", (err) => this.emit("error", err));
  }

  /** Send PCM16 mono @ SAMPLE_RATE into the meeting (binary frame). */
  sendAudio(pcm: Buffer): void {
    if (this.conn && this.conn.readyState === WebSocket.OPEN) {
      this.conn.send(pcm, { binary: true });
    }
  }

  close(): void {
    try {
      this.conn?.close();
    } catch {
      // ignore
    }
    try {
      this.wss.close();
    } catch {
      // ignore
    }
  }
}
