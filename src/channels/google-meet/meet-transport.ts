import { EventEmitter } from "events";
import WebSocket from "ws";
import { VoiceTransport, AudioFormat } from "../../core/voice-transport";

/**
 * Adapts a MeetingBaaS audio WebSocket (already upgraded by the gateway) to the
 * generic VoiceTransport. MeetingBaaS sends raw PCM16 binary frames + JSON text
 * frames (one-time handshake, then speaker-state arrays). Mirrors CallTransport.
 *
 * Emits: "audio"(Buffer) | "handshake"(msg) | "speakers"(arr) | "closed" | "error".
 */
export class MeetTransport extends EventEmitter implements VoiceTransport {
  readonly format: AudioFormat = { kind: "pcm16", rate: 24000 };
  private gotHandshake = false;

  constructor(private ws: WebSocket) {
    super();
    ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        this.emit("audio", data as Buffer);
        return;
      }
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
    ws.on("close", () => this.emit("closed"));
    ws.on("error", (err) => this.emit("error", err));
  }

  /** Send PCM16 mono @ 24kHz into the meeting (binary frame). */
  sendAudio(buf: Buffer): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(buf, { binary: true });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}
