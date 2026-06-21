import WebSocket from "ws";
import { EventEmitter } from "events";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const DEBUG = !!process.env.DEBUG;
// GA Realtime model (the beta API + gpt-4o-realtime-preview shape is retired).
const MODEL = "gpt-realtime";

// Agent name and wake word are configurable via .env.
const AGENT_NAME = process.env.AGENT_NAME?.trim() || "Rall";

const SYSTEM_PROMPT =
  `Your name is ${AGENT_NAME}. You are a helpful assistant in a Google Meet ` +
  "meeting. You only speak when someone addresses you directly by name. Keep " +
  "responses concise since this is a voice conversation, and do not announce " +
  "that you were addressed.";

// Only respond when the speaker refers to the bot by name. Whisper often mishears
// short names, so AGENT_ALIASES (comma-separated) lets you add close variants.
// Tune that set if the wake word over- or under-fires.
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const WAKE_TERMS = [
  AGENT_NAME,
  ...(process.env.AGENT_ALIASES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
];
const WAKE_WORD = new RegExp(
  `\\b(${WAKE_TERMS.map(escapeRegex).join("|")})\\b`,
  "i"
);

/**
 * Wraps the OpenAI Realtime API (GA) WebSocket.
 *
 * Emits:
 *   "ready"                 — session.created received; safe to forward audio
 *   "audio" (pcm: Buffer)   — PCM16 mono @ 24kHz audio from the model
 *   "close"
 *   "error" (err)
 */
export class RealtimeAgent extends EventEmitter {
  private ws: WebSocket;
  private sessionReady = false;

  constructor() {
    super();
    // GA: connect to /v1/realtime, no OpenAI-Beta header.
    this.ws = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${MODEL}`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
      }
    );

    this.ws.on("open", () => this.emit("open"));
    this.ws.on("message", (raw) => this.handleMessage(raw));
    this.ws.on("close", () => this.emit("close"));
    this.ws.on("error", (err) => this.emit("error", err));
  }

  private handleMessage(raw: WebSocket.RawData): void {
    let event: any;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (event.type) {
      case "session.created":
        // Configure the session, then announce readiness.
        this.configureSession();
        this.sessionReady = true;
        this.emit("ready");
        break;

      case "session.updated":
        console.log("✅ OpenAI session configured (transcription + wake word active)");
        break;

      // GA: output audio bytes arrive as response.output_audio.delta (base64).
      case "response.output_audio.delta":
        if (event.delta) {
          this.emit("audio", Buffer.from(event.delta, "base64"));
        }
        break;

      // What the human said (input transcription). Server VAD detects the turn
      // but does NOT auto-respond (create_response: false); we only ask for a
      // response when the speaker addressed the bot by name.
      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) {
          const text = event.transcript.trim();
          console.log(`\n🗣️  Human: ${text}`);
          if (WAKE_WORD.test(text)) {
            console.log(`   ↳ addressed ${AGENT_NAME} — responding`);
            this.send({ type: "response.create" });
          } else {
            console.log("   ↳ not addressed — ignoring");
          }
        }
        break;

      // What the agent said (GA output transcript).
      case "response.output_audio_transcript.done":
        if (event.transcript) {
          console.log(`🤖 Agent: ${event.transcript.trim()}`);
        }
        break;

      case "input_audio_buffer.speech_started":
        if (DEBUG) console.log("🔊 (speech detected — audio is reaching OpenAI)");
        break;
      case "conversation.item.input_audio_transcription.failed":
        console.error("⚠️  input transcription failed:", JSON.stringify(event.error || event));
        break;

      case "error":
        // Make config-rejection failures loud — a rejected session.update
        // silently disables transcription + wake-word gating otherwise.
        console.error("❌ OpenAI error:", JSON.stringify(event.error || event));
        this.emit("error", new Error(JSON.stringify(event.error || event)));
        break;

      default:
        // Surface unexpected events in DEBUG (skip the high-frequency audio stream).
        if (DEBUG && event.type !== "response.output_audio.delta") {
          console.log(`· ${event.type}`);
        }
        break;
    }
  }

  private configureSession(): void {
    // GA session shape: audio config nested under session.audio.{input,output}.
    this.send({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: SYSTEM_PROMPT,
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            // Detect turns + transcribe, but DON'T auto-reply. We trigger a
            // response only when the wake word is heard (see handleMessage).
            turn_detection: { type: "server_vad", create_response: false },
            transcription: { model: "whisper-1" },
          },
          output: {
            format: { type: "audio/pcm", rate: 24000 },
            voice: "alloy",
          },
        },
      },
    });
  }

  /** Append a PCM16 mono @ 24kHz chunk to OpenAI's input buffer. */
  appendAudio(pcm: Buffer): void {
    if (!this.sessionReady) return;
    this.send({
      type: "input_audio_buffer.append",
      audio: pcm.toString("base64"),
    });
  }

  private send(obj: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
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
