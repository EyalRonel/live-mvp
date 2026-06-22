import WebSocket from "ws";
import { EventEmitter } from "events";
import { DEBUG } from "../../shared/config";
import { AGENT_NAME, AGENT_VOICE, AGENT_TONE, matchesWakeWord, Channel } from "../../shared/persona";
import { AudioFormat } from "../../core/voice-transport";
import { BrainFn, Msg } from "../../agent/brain";

const MODEL = "gpt-realtime"; // GA model

// Realtime is used as ears (STT) + mouth (TTS) only; the brain is respond().
// The session prompt frames it as a faithful voice with the configured tone
// (tone steers delivery/prosody; the words still come verbatim from the brain).
const TTS_FRAMING =
  `You are the voice of an assistant named ${AGENT_NAME}. Speak in a ${AGENT_TONE} ` +
  "tone. When given text to read, speak it exactly as written, word for word, " +
  "without adding, removing, or changing anything.";

export interface RealtimeAgentConfig {
  respond: BrainFn; // the single brain every channel shares
  channel: Channel;
  from: string;
  audioFormat: AudioFormat; // pcm16/24k (meet) | pcmu/8k (phone)
  voice?: string; // override; defaults to AGENT_VOICE from persona
  /** Meet: only respond when addressed by one of these terms. Omit = reply to every turn (phone). */
  wakeWord?: { terms: string[] };
  /** Speak first when ready (phone). string = exact greeting; true = default greeting. */
  greetOnReady?: boolean | string;
}

function toSessionFormat(f: AudioFormat) {
  return f.kind === "pcm16" ? { type: "audio/pcm", rate: f.rate } : { type: "audio/pcmu" };
}

/**
 * Realtime voice layer in "bring-your-own-brain" mode. It transcribes the caller,
 * hands the text to the shared respond() brain, and speaks the brain's reply back.
 *
 * Events: "ready" | "audio"(Buffer) | "interrupted" | "close" | "error".
 */
export class RealtimeAgent extends EventEmitter {
  private ws: WebSocket;
  private sessionReady = false;
  private history: Msg[] = [];
  private responseActive = false; // is a spoken reply currently being generated?

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
        console.log("✅ OpenAI voice layer configured");
        this.maybeGreet();
        break;

      // Spoken audio (the brain's reply being read aloud) — base64 in our format.
      case "response.output_audio.delta":
        if (event.delta) this.emit("audio", Buffer.from(event.delta, "base64"));
        break;

      // The caller's speech, transcribed → hand to the brain.
      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) void this.onUserTranscript(event.transcript.trim());
        break;

      // What we actually spoke (for console visibility).
      case "response.output_audio_transcript.done":
        if (event.transcript) console.log(`🤖 ${this.cfg.channel}: ${event.transcript.trim()}`);
        break;

      // Track whether a spoken reply is in flight (so we only cancel real ones).
      case "response.created":
        this.responseActive = true;
        break;
      case "response.done":
        this.responseActive = false;
        break;

      case "input_audio_buffer.speech_started":
        // Caller barged in: flush playback, and cancel the reply only if one is
        // actually being generated (avoids "no active response" errors).
        if (DEBUG) console.log("🔊 (speech detected — barge-in)");
        this.emit("interrupted");
        if (this.responseActive) {
          this.responseActive = false;
          this.send({ type: "response.cancel" });
        }
        break;

      case "conversation.item.input_audio_transcription.failed":
        console.error("⚠️  transcription failed:", JSON.stringify(event.error || event));
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

  private async onUserTranscript(text: string): Promise<void> {
    console.log(`\n🗣️  ${this.cfg.from}: ${text}`);
    // Meet: only engage when addressed by name.
    if (this.cfg.wakeWord && !matchesWakeWord(text, this.cfg.wakeWord.terms)) {
      console.log("   ↳ not addressed — ignoring");
      return;
    }
    try {
      const reply = await this.cfg.respond(text, {
        channel: this.cfg.channel,
        from: this.cfg.from,
        history: this.history,
      });
      this.history.push({ role: "user", content: text }, { role: "assistant", content: reply });
      this.speak(reply);
    } catch (err) {
      console.error("Brain error:", err);
    }
  }

  /** Render `text` as speech via an out-of-band TTS response (verbatim). */
  private speak(text: string): void {
    if (!text) return;
    this.send({
      type: "response.create",
      response: {
        conversation: "none",
        input: [],
        instructions: `Read the following aloud verbatim, exactly as written:\n\n${text}`,
      },
    });
  }

  private maybeGreet(): void {
    if (!this.cfg.greetOnReady) return;
    const greeting =
      typeof this.cfg.greetOnReady === "string"
        ? this.cfg.greetOnReady
        : `Hi, this is ${AGENT_NAME}. How can I help you?`;
    this.history.push({ role: "assistant", content: greeting });
    this.speak(greeting);
  }

  private configureSession(): void {
    const fmt = toSessionFormat(this.cfg.audioFormat);
    this.send({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: TTS_FRAMING,
        output_modalities: ["audio"],
        audio: {
          input: {
            format: fmt,
            // We always drive replies ourselves (speak the brain's output), so
            // never let the model auto-respond.
            turn_detection: { type: "server_vad", create_response: false },
            transcription: { model: "whisper-1" },
          },
          output: { format: fmt, voice: this.cfg.voice || AGENT_VOICE },
        },
      },
    });
  }

  /** Append a caller audio chunk (raw bytes in the configured format). */
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
