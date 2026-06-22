# live-mvp — multi-channel voice/text AI agent

One AI persona, reachable over three channels — each with its own entry point:

- **Google Meet** — a bot ([MeetingBaaS](https://meetingbaas.com)) joins the meeting
  and talks via the [OpenAI Realtime API](https://platform.openai.com/docs/guides/realtime).
- **Phone** ([Twilio](https://twilio.com) Voice) — call the agent's number (or have
  it call you) and talk, also via the Realtime API. Inbound **and** outbound.
- **SMS** (Twilio Messaging) — text the number and get LLM replies; can also send a
  one-off outbound text.

Voice channels stream audio with **no transcoding** (each side's format matches
OpenAI's: PCM16/24 kHz for Meet, G.711 μ-law/8 kHz for phone).

## Project structure

```
src/
  agent/             # YOUR AGENT — one function every channel routes through
    brain.ts         respond(userText, ctx) -> reply text
  channels/          # one folder per channel — the entry points you run
    google-meet/     index.ts + meet-transport.ts
    phone-call/      index.ts + call-transport.ts
    sms/             index.ts + memory.ts
  services/          # reusable provider integrations
    twilio/          client (REST), media-stream framing, messaging, twiml   (phone + sms)
    meetingbaas/     client (REST) + audio-socket (WS server)                (meet)
    openai/          realtime-agent (voice STT+TTS)                          (meet + phone)
  core/              voice-transport (interface) + bridge (wires audio)
  shared/            persona, config, tunnel
```

To understand a channel, open `channels/<x>/index.ts`; the provider mechanics it
calls live under `services/`. Adding a channel = a new `channels/<name>/` folder.

## Writing your own agent

All channels are just **rails** that feed one function:

```ts
// src/agent/brain.ts
export async function respond(userText: string, ctx: ConversationContext): Promise<string>
```

`ctx` is `{ channel: "meet" | "phone" | "sms", from, history }`. Whatever you return
is **spoken** on voice calls and **texted** on SMS. Replace the default body (a plain
OpenAI chat completion) with your own logic — tools, RAG, another model — and every
channel uses it, no plumbing changes.

For voice, OpenAI Realtime is used purely as **ears (speech-to-text) + mouth
(text-to-speech)**: it transcribes the caller, your `respond()` decides the reply,
and Realtime speaks it back (verbatim). Meet still gates on the wake word; phone
greets and converses naturally. Barge-in cancels the in-flight reply.

## Setup

```bash
npm install
cp .env.example .env   # then fill it in
```

| Variable | Needed for | Notes |
| --- | --- | --- |
| `OPENAI_API_KEY` | all | Billing enabled; access to `gpt-realtime` + a text model. |
| `BAAS_API_KEY` | meet | MeetingBaaS dashboard. |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | phone, sms | Twilio console. |
| `TWILIO_PHONE_NUMBER` | phone, sms | E.164, voice+SMS capable (e.g. `+19787658615`). |
| `NGROK_AUTHTOKEN` | all | Free at ngrok.com — opens the public tunnel. (Or set `PUBLIC_WS_URL`.) |
| `AGENT_NAME` / `AGENT_ALIASES` | optional | Name + wake-word variants (default `Rally`). |
| `SMS_MODEL`, `PORT`, `PHONE_PORT`, `SMS_PORT` | optional | Sensible defaults. |

> **ngrok free tier allows one tunnel at a time**, so run one channel per machine.
> Each run auto-points the relevant Twilio/MeetingBaaS webhook at the current
> tunnel URL, so you never reconfigure webhooks by hand.

## Running

### Google Meet
```bash
npm run meet -- https://meet.google.com/xxx-yyyy-zzz
```
Join the Meet yourself, then **admit the bot from the waiting room** (it appears as
your `AGENT_NAME`). It only replies when **addressed by name** (e.g. "Rally, …").

### Phone
```bash
npm run phone                  # inbound: wait for calls to your number
npm run phone -- +15551234567  # outbound: the agent calls that number
```
Natural conversation — it greets on connect and supports barge-in (interrupt it
and it stops talking). Console shows `🗣️ Human` / `🤖 Agent` transcripts.

### SMS
```bash
npm run sms                              # inbound: reply to texts sent to your number
npm run sms -- +15551234567 "hi there"  # outbound: send that literal text, then exit
```
Inbound mode keeps short per-sender memory so follow-ups have context.

> **Twilio trial accounts** can only call/text **verified** numbers and add a trial
> notice — upgrade to remove both. Outbound is a manual trigger (the agent doesn't
> autonomously decide to reach out — that'd be a tool/MCP feature).

## How a voice channel works

```
caller ─audio─▶ transport ─▶ Realtime (STT) ─▶ respond() ─▶ Realtime (TTS) ─▶ transport ─▶ caller
```

A `VoiceTransport` (Meet or Twilio) carries audio frames; `bridge(transport, agent)`
wires both directions plus barge-in and teardown. The same `RealtimeAgent` powers
Meet and phone — it transcribes the caller, calls the shared `respond()` brain, and
speaks the reply. Only its config differs (audio format, wake-word vs. natural,
greeting). See `src/core/` and `src/agent/brain.ts`.
