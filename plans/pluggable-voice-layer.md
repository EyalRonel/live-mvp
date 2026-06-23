# Plan: Pluggable voice layer (OpenAI ↔ ElevenLabs), minimal latency

> Status: designed/explored, not implemented. Parked to revisit later.

## Context

Voice channels (Meet, phone) get ears+mouth+turn-taking from `RealtimeAgent`
(`src/services/openai/realtime-agent.ts`) — OpenAI Realtime. The **brain is already
decoupled** (`respond()` in `src/agent/brain.ts` can be any model), but the **voice
layer is OpenAI-locked**. Goal: make the voice layer **pluggable** across providers
(OpenAI now, ElevenLabs next) while keeping latency minimal.

Why this is small: `bridge()` (`src/core/bridge.ts`) already depends only on an
`AudioAgent` (events `audio`/`interrupted`/`close`, methods `appendAudio`/`close`),
and `RealtimeAgent` already matches that + `say()`. So `RealtimeAgent` *is* the
de-facto voice-layer interface — we just name it and add a second implementation.

## Latency analysis (the important takeaway)

Per turn: **VAD silence wait → STT finalize → `respond()` round-trip → TTS first-audio.**
Rough shares:
- VAD silence: ~200–500 ms (tunable)
- STT finalize: ~100–200 ms (OpenAI ≈ ElevenLabs Scribe ~150 ms)
- **`respond()` brain: ~300–900 ms — usually dominant; full completion before TTS**
- TTS first-audio: ~150–300 ms (ElevenLabs Flash ~75 ms is notably fast)

**The brain round-trip dominates and is provider-independent.** So swapping the voice
layer alone is at best a *modest* win (mostly faster TTS first-audio). ElevenLabs is
therefore primarily a **voice-quality / flexibility** choice, not a speed one — UNLESS
paired with the real latency levers below.

**Real latency levers (mostly provider-independent):**
1. **Stream the brain into streaming TTS** — today `respond()` must fully finish before
   we speak. Token-stream the LLM straight into streaming TTS so the agent starts
   talking on the first words. Biggest perceived-latency win (can ~halve it).
   ElevenLabs streaming TTS (partial-text WS) is purpose-built for this.
2. **Tune VAD** (shorter silence threshold): ~100–300 ms.
3. **Faster brain** (Groq / smaller model): `respond()` is ours to swap.

## Design (pluggable VoiceLayer)

### 1. Extract interface — `src/core/voice-layer.ts` (new)
```ts
export interface VoiceLayerConfig {
  respond: BrainFn; channel: Channel; from: string;
  audioFormat: AudioFormat; voice?: string;
  wakeWord?: { terms: string[] }; greetOnReady?: boolean | string;
}
// EventEmitter: "ready" | "audio"(Buffer in audioFormat) | "interrupted" | "close" | "error"
export interface VoiceLayer extends EventEmitter {
  appendAudio(buf: Buffer): void;
  say(text: string): void;
  close(): void;
}
export function createVoiceLayer(cfg: VoiceLayerConfig): VoiceLayer; // by VOICE_PROVIDER
```
Equals today's `RealtimeAgent` surface, so `bridge(transport, layer)` is unchanged.

### 2. Implementations
- OpenAI: `RealtimeAgent implements VoiceLayer` (trivial/no change).
- ElevenLabs: `src/services/elevenlabs/voice-layer.ts` — composed from native streaming:
  - Ears: Scribe v2 realtime STT WS (VAD: interim → barge-in; committed → end-of-turn).
  - Brain: committed transcript → wake-word gate (Meet) → `cfg.respond()`.
  - Mouth: Flash streaming TTS, `output_format` = `ulaw_8000` (phone) / `pcm_24000`
    (Meet) from `cfg.audioFormat` → emit `"audio"` (no transcoding).
  - Barge-in: STT speech-start while speaking → `"interrupted"` + stop TTS stream.

### 3. Selection
`VOICE_PROVIDER=openai|elevenlabs` (env, default openai). Channels swap
`new RealtimeAgent({...})` → `createVoiceLayer({...})` (one line each in
`channels/google-meet/index.ts`, `channels/phone-call/index.ts`). `bridge`, transports,
`respond`, persona unchanged. (ElevenLabs voice id via `ELEVENLABS_VOICE_ID`.)

### 4. Pre-flight harness (verify, then delete)
ElevenLabs realtime-STT + streaming-TTS WS message schemas weren't fully confirmable
from docs — confirm with a throwaway harness (as we did for OpenAI formats/μ-law):
STT connect + interim/committed + VAD; TTS connect + `ulaw_8000`/`pcm_24000` chunks.

## Critical files
- new: `src/core/voice-layer.ts`, `src/services/elevenlabs/voice-layer.ts` (+ `client.ts`).
- changed: `src/services/openai/realtime-agent.ts` (`implements VoiceLayer`),
  `src/channels/{google-meet,phone-call}/index.ts` (use factory), `.env.example`.
- unchanged: `core/bridge.ts`, `core/voice-transport.ts`, transports, `agent/brain.ts`,
  `shared/persona.ts`.

## Config
`VOICE_PROVIDER`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, optional
`ELEVENLABS_STT_MODEL`/`ELEVENLABS_TTS_MODEL`.

## Build now vs defer
- Now (if pursued): interface + factory + OpenAI rename + ElevenLabs composed impl + harness.
- Defer: ElevenLabs **Agents** managed-loop variant (their turn-taking + BYO-LLM webhook);
  mix-and-match STT/TTS vendors (split VoiceLayer into STT+TTS sub-interfaces);
  **streaming brain → TTS** (the big latency cut).

## Verification
1. `tsc`; `VOICE_PROVIDER=openai` identical to today.
2. Harness confirms ElevenLabs STT/TTS shapes + audio formats.
3. `VOICE_PROVIDER=elevenlabs` + `npm run phone`: ElevenLabs voice heard; barge-in works.
4. `npm run meet` elevenlabs: wake-word + pcm_24000 clean.
5. Flip back to openai → unchanged.

## ElevenLabs reference (researched, 2026)
- Conversational AI = direct OpenAI-Realtime analog (STT+turn-taking+TTS over WS),
  **BYO-LLM via custom-LLM webhook**, **native Twilio**.
- Standalone: Scribe v2 realtime STT (~150 ms, WS, VAD auto-commit); streaming TTS
  (Flash ~75 ms) with `output_format` incl. `ulaw_8000`, `pcm_16000/24000/44100`, mp3, opus.
- Docs: https://elevenlabs.io/docs/llms-full.txt , /docs/eleven-agents/overview ,
  /docs/api-reference/{speech-to-text,text-to-speech}
