import WebSocket, { WebSocketServer } from "ws";
import { EventEmitter } from "events";

/**
 * WebSocket SERVER that MeetingBaaS connects to. (The provider dials us, so we
 * listen.) One bidirectional connection carries everything.
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
