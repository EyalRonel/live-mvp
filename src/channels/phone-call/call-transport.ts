import { EventEmitter } from "events";
import WebSocket from "ws";
import { VoiceTransport, AudioFormat } from "../../core/voice-transport";

/**
 * Adapts a Twilio Media Streams WebSocket to the generic VoiceTransport.
 *
 * Twilio frames are JSON: `start` (gives streamSid), `media` (base64 μ-law in
 * media.payload), `stop`. We send audio back as `media` frames and flush playback
 * with a `clear` frame (barge-in). Audio is G.711 μ-law @ 8kHz mono — the same
 * format we configure OpenAI with, so it passes through untouched.
 *
 * Emits "connected" once Twilio's `start` arrives (we have a streamSid and can
 * send audio), then "audio"/"closed"/"error".
 */
export class CallTransport extends EventEmitter implements VoiceTransport {
  readonly format: AudioFormat = { kind: "pcmu", rate: 8000 };
  private streamSid?: string;
  /** Caller number, from the TwiML <Parameter>/callSid (set on "start"). */
  caller = "caller";

  constructor(private ws: WebSocket) {
    super();
    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      switch (msg.event) {
        case "start":
          this.streamSid = msg.start?.streamSid || msg.streamSid;
          this.caller =
            msg.start?.customParameters?.caller || msg.start?.callSid || "caller";
          this.emit("connected");
          break;
        case "media":
          if (msg.media?.payload) {
            this.emit("audio", Buffer.from(msg.media.payload, "base64"));
          }
          break;
        case "stop":
          this.emit("closed");
          break;
      }
    });
    ws.on("close", () => this.emit("closed"));
    ws.on("error", (err) => this.emit("error", err));
  }

  sendAudio(buf: Buffer): void {
    if (this.streamSid && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          event: "media",
          streamSid: this.streamSid,
          media: { payload: buf.toString("base64") },
        })
      );
    }
  }

  clear(): void {
    if (this.streamSid && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ event: "clear", streamSid: this.streamSid }));
    }
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}
