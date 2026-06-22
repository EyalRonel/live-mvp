import { EventEmitter } from "events";
import { VoiceTransport } from "./voice-transport";

/**
 * The minimal shape bridge() needs from a voice agent. RealtimeAgent satisfies
 * this; keeping it here means core/ doesn't depend on services/.
 *
 * Expected events: "audio" (Buffer, agent speech), "interrupted" (user barged in),
 * "close" (agent socket ended).
 */
export interface AudioAgent extends EventEmitter {
  appendAudio(buf: Buffer): void;
  close(): void;
}

/**
 * Wire a connected transport to a voice agent, both directions, with lifecycle.
 * Returns a teardown function. No transcoding — transport.format already matches
 * the agent's configured format, so frames pass through untouched.
 */
export function bridge(transport: VoiceTransport, agent: AudioAgent): () => void {
  // ── UPLINK: human → AI ──────────────────────────────────────────────
  // Caller/meeting speaks → transport emits an inbound audio frame →
  // we feed it into OpenAI's input buffer.
  //   caller/meeting  ──audio──▶  transport  ──appendAudio──▶  OpenAI
  const uplink = (b: Buffer) => agent.appendAudio(b);
  transport.on("audio", uplink);

  // ── DOWNLINK: AI → human ────────────────────────────────────────────
  // OpenAI generates speech → emits an output audio frame →
  // we push it back out through the transport to the caller/meeting.
  //   OpenAI  ──audio──▶  transport.sendAudio  ──▶  caller/meeting
  const downlink = (b: Buffer) => transport.sendAudio(b);
  agent.on("audio", downlink);

  // ── BARGE-IN: human interrupts AI (downlink flush) ──────────────────
  // OpenAI's VAD hears the human start talking mid-reply → "interrupted" →
  // tell the transport to drop audio it has already buffered for playback
  // (Twilio "clear"; Meet has no clear(), so this is skipped).
  if (transport.clear) agent.on("interrupted", () => transport.clear!());

  // ── TEARDOWN: either side ending closes the other ───────────────────
  let torn = false;
  const teardown = () => {
    if (torn) return;
    torn = true;
    agent.close();
    transport.close();
  };
  transport.on("closed", teardown); // call hung up / meeting ended
  agent.on("close", teardown); // OpenAI socket dropped
  return teardown;
}
