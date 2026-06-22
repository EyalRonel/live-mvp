import { EventEmitter } from "events";

/**
 * Wire format of the audio frames a transport carries. This drives the OpenAI
 * Realtime session config, and lets the bridge stay transcode-free: each channel
 * matches its format end to end.
 */
export type AudioFormat =
  | { kind: "pcm16"; rate: 24000 } // Meet / MeetingBaaS
  | { kind: "pcmu"; rate: 8000 }; // Phone / Twilio G.711 μ-law

/**
 * A duplex audio channel between an external voice source and us.
 * Implementations: MeetTransport (MeetingBaaS), CallTransport (Twilio).
 *
 * Events:
 *   "connected"             — remote attached & streaming; safe to start the agent
 *   "audio" (buf: Buffer)   — inbound media frame, RAW in this transport's `format`
 *   "closed"                — connection ended (call hung up / meeting ended)
 *   "error" (err)
 */
export interface VoiceTransport extends EventEmitter {
  /** Format of frames emitted by "audio" and expected by sendAudio(). */
  readonly format: AudioFormat;
  /** Send agent audio back to the caller/meeting (same `format`). */
  sendAudio(buf: Buffer): void;
  /** Optional barge-in: drop already-buffered playback (Twilio "clear"; no-op for Meet). */
  clear?(): void;
  close(): void;
}
