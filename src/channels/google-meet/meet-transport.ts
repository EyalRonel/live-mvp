import { EventEmitter } from "events";
import { VoiceTransport, AudioFormat } from "../../core/voice-transport";
import { MeetingAudioServer } from "../../services/meetingbaas/audio-socket";
import { SAMPLE_RATE } from "../../services/meetingbaas/client";

/**
 * Adapts the MeetingBaaS audio socket to the generic VoiceTransport interface.
 * MeetingBaaS already sends/receives raw PCM16 Buffers, so this is a thin rename
 * of events (connected/audio/disconnected -> connected/audio/closed) plus the
 * declared `format`. Extra Meet-only events (handshake/speakers) are re-emitted
 * for the entry point to log.
 */
export class MeetTransport extends EventEmitter implements VoiceTransport {
  readonly format: AudioFormat = { kind: "pcm16", rate: SAMPLE_RATE as 24000 };
  private server: MeetingAudioServer;

  constructor(port: number) {
    super();
    this.server = new MeetingAudioServer(port);
    this.server.on("connected", () => this.emit("connected"));
    this.server.on("audio", (b: Buffer) => this.emit("audio", b));
    this.server.on("disconnected", () => this.emit("closed"));
    this.server.on("error", (e) => this.emit("error", e));
    // Meet-specific extras, surfaced for logging.
    this.server.on("handshake", (m) => this.emit("handshake", m));
    this.server.on("speakers", (a) => this.emit("speakers", a));
  }

  sendAudio(buf: Buffer): void {
    this.server.sendAudio(buf);
  }

  close(): void {
    this.server.close();
  }
}
