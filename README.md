# live-mvp — Google Meet voice agent

A minimal Node.js + TypeScript voice agent that sends a bot into a Google Meet
via [MeetingBaaS](https://meetingbaas.com) and holds a real-time voice
conversation using the [OpenAI Realtime API](https://platform.openai.com/docs/guides/realtime).

Voice in, voice out. No video, no chat, no tools, no UI.

## How it works

MeetingBaaS streams the meeting's mixed audio to a WebSocket **server that this
app hosts**, and plays back any audio we send to that same socket. Both sides use
PCM16 mono @ 24 kHz — identical to the OpenAI Realtime API — so no resampling.

```
Google Meet ─▶ MeetingBaaS ─(binary PCM16)─▶ our WS server ─(base64)─▶ OpenAI Realtime
Google Meet ◀─ MeetingBaaS ◀─(binary PCM16)─ our WS server ◀─(base64)─ OpenAI Realtime
```

Because MeetingBaaS (cloud) must reach your machine, the local WS server is
exposed through a public tunnel (ngrok).

- `index.ts` — entry point: opens the tunnel, creates the bot, bridges audio.
- `meeting-bot.ts` — MeetingBaaS REST (create/leave) + the audio WebSocket server.
- `agent.ts` — OpenAI Realtime WebSocket connection, session config, transcripts.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create your `.env` from the template and fill in keys:

   ```bash
   cp .env.example .env
   # edit .env
   ```

   | Variable          | Required | Notes                                                        |
   | ----------------- | -------- | ------------------------------------------------------------ |
   | `OPENAI_API_KEY`  | yes      | Needs billing enabled + access to the `gpt-realtime` (GA) model. |
   | `BAAS_API_KEY`    | yes      | From your MeetingBaaS dashboard.                             |
   | `NGROK_AUTHTOKEN` | yes\*    | Free at dashboard.ngrok.com — opens the tunnel automatically.|
   | `PUBLIC_WS_URL`   | no       | Use instead of ngrok if you run your own tunnel.            |
   | `PORT`            | no       | Local WS server port, default `8080`.                        |
   | `AGENT_NAME`      | no       | Agent's name + wake word, default `Rall`.                    |
   | `AGENT_ALIASES`   | no       | Comma-separated wake-word variants for STT mishears.        |

   \* Either `NGROK_AUTHTOKEN` **or** `PUBLIC_WS_URL` is required.

## Run

```bash
npx ts-node index.ts https://meet.google.com/xxx-yyyy-zzz
```

Then:

1. Start (or join) the Google Meet yourself in a browser.
2. The app opens a tunnel, then prints **"Bot created, waiting to be admitted to the meeting"**.
3. **Admit the bot from the waiting room** — it appears as "Rall".
   When it joins and starts streaming, the app prints **"Bot admitted, starting conversation"**.
4. Talk. The bot is named **Rall** and only replies when you address it by name
   (e.g. "Rall, what's on the agenda?"). Transcripts of both sides print to the
   console, with a note on whether each turn was addressed to Rall.
5. `Ctrl+C` to stop — the WebSocket closes, the OpenAI session ends, and the bot
   leaves the call.

> ⚠️ **Someone must admit the bot from the waiting room.** Until a human in the
> Meet lets it in, MeetingBaaS won't connect and you'll stay on "waiting".

## Audio format

PCM16, mono, 24 kHz on both sides (MeetingBaaS `audio_frequency: 24000` and the
OpenAI Realtime API native rate). Binary frames, no headers. If you change the
MeetingBaaS frequency you must resample before forwarding to OpenAI.

## Protocol notes

- MeetingBaaS v2: `POST https://api.meetingbaas.com/v2/bots` with
  `streaming_enabled` + `streaming_config { output_url, input_url, audio_frequency }`,
  auth header `x-meeting-baas-api-key`. Using the **same URL** for input and
  output gives one bidirectional socket.
- On connect, the bot sends a JSON handshake, then binary PCM audio chunks every
  100 ms, plus JSON speaker-state arrays. We treat binary as audio and text as
  metadata.
- Server-side VAD (`server_vad`) handles turn-taking and barge-in.
