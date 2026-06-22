import WebSocket from "ws";
import { EventEmitter } from "events";
import { DEBUG } from "../../shared/config";
import { matchesWakeWord } from "../../shared/persona";
import { AudioFormat } from "../../core/voice-transport";

const MODEL = "gpt-realtime"; // GA model (beta + gpt-4o-realtime-preview retired)

export interface RealtimeAgentConfig {
  instructions: string; // system prompt (from shared/persona)
  audioFormat: AudioFormat; // pcm16/24k (meet) | pcmu/8k (phone)
  voice?: string; // default "alloy"
  /** If set, only respond when the speaker says one of these terms (Meet). Omit = reply to every turn (phone). */
  wakeWord?: { terms: string[] };
  /** Speak first when the session is ready (phone). string = greeting instruction; true = generic greeting. */
  greetOnReady?: boolean | string;
}

/** Map our AudioFormat to the OpenAI GA session format object. */
function toSessionFormat(f: AudioFormat) {
  return f.kind === "pcm16"
    ? { type: "audio/pcm", rate: f.rate }
    : { type: "audio/pcmu" }; // G.711 μ-law is inherently 8kHz
}

/**
 * Wraps the OpenAI Realtime API (GA) WebSocket. Shared by the voice channels
 * (Meet, Phone); behavior is driven by RealtimeAgentConfig.
 *
 * Events: "ready" | "audio"(Buffer) | "interrupted" | "close" | "error".
 */
export class RealtimeAgent extends EventEmitter {
  private ws: WebSocket;
  private sessionReady = false;

  constructor(private cfg: RealtimeAgentConfig) {
    super();
    this.ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${MODEL}`, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY || ""}` },
    });
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
        this.configureSession();
        this.sessionReady = true;
        this.emit("ready");
        break;

      case "session.updated":
        console.log("✅ OpenAI session configured");
        this.maybeGreet();
        break;

      // GA: output audio bytes arrive as response.output_audio.delta (base64).
      case "response.output_audio.delta":
        if (event.delta) this.emit("audio", Buffer.from(event.delta, "base64"));
        break;

      // What the human said (input transcription).
      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) this.onUserTranscript(event.transcript.trim());
        break;

      // What the agent said.
      case "response.output_audio_transcript.done":
        if (event.transcript) console.log(`🤖 Agent: ${event.transcript.trim()}`);
        break;

      case "input_audio_buffer.speech_started":
        // User started talking — used for barge-in (phone clears playback).
        if (DEBUG) console.log("🔊 (speech detected)");
        this.emit("interrupted");
        break;

      case "conversation.item.input_audio_transcription.failed":
        console.error("⚠️  input transcription failed:", JSON.stringify(event.error || event));
        break;

      case "error":
        console.error("❌ OpenAI error:", JSON.stringify(event.error || event));
        this.emit("error", new Error(JSON.stringify(event.error || event)));
        break;

      default:
        if (DEBUG && event.type !== "response.output_audio.delta") {
          console.log(`· ${event.type}`);
        }
        break;
    }
  }

  private onUserTranscript(text: string): void {
    console.log(`\n🗣️  Human: ${text}`);
    if (!this.cfg.wakeWord) return; // no gating: server VAD auto-creates the response
    // Wake-word mode: VAD detects the turn but doesn't auto-reply; we trigger
    // a response only when addressed.
    if (matchesWakeWord(text, this.cfg.wakeWord.terms)) {
      console.log("   ↳ addressed — responding");
      this.send({ type: "response.create" });
    } else {
      console.log("   ↳ not addressed — ignoring");
    }
  }

  private maybeGreet(): void {
    if (!this.cfg.greetOnReady) return;
    const instructions =
      typeof this.cfg.greetOnReady === "string"
        ? this.cfg.greetOnReady
        : "Greet the caller warmly in one short sentence, then ask how you can help.";
    this.send({ type: "response.create", response: { instructions } });
  }

  private configureSession(): void {
    const fmt = toSessionFormat(this.cfg.audioFormat);
    this.send({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: this.cfg.instructions,
        output_modalities: ["audio"],
        audio: {
          input: {
            format: fmt,
            // Wake-word mode gates replies (create_response:false); otherwise
            // server VAD replies to every turn.
            turn_detection: {
              type: "server_vad",
              create_response: !this.cfg.wakeWord,
            },
            transcription: { model: "whisper-1" },
          },
          output: {
            format: fmt,
            voice: this.cfg.voice || "alloy",
          },
        },
      },
    });
  }

  /** Append an audio chunk (raw bytes in the configured format) to OpenAI. */
  appendAudio(buf: Buffer): void {
    if (!this.sessionReady) return;
    this.send({ type: "input_audio_buffer.append", audio: buf.toString("base64") });
  }

  private send(obj: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}
