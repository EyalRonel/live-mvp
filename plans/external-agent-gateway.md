# Plan: Pluggable rails — let an external agent be a "real-world citizen"

> Status: designed, not yet implemented. Parked to revisit later.

## Context

Today this repo **is** the agent: the `respond()` brain (`src/agent/brain.ts`)
runs in-process, fed by the channel rails (Meet/phone/SMS). We want to invert that:
expose the channels as **pluggable rails** so an **external agent** (hosted
elsewhere, controlled by the user) can join meetings, make + accept calls, and
send + receive SMS — becoming a real-world citizen.

Scope (user-confirmed): **POC with ONE external agent the user controls**, but
architected so multi-tenancy is a clean later step. The agent participates in live
calls/meetings via **text turns** — the platform keeps doing STT/TTS (reusing the
bring-your-own-brain `RealtimeAgent`) and exchanges text with the remote agent. The
agent must both **respond** to inbound turns/events AND **initiate** actions
(call/SMS/join) proactively, possibly mid-conversation.

**Load-bearing constraint that shapes the design:** channels are currently separate
processes, each with its own ngrok tunnel. An agent in a meeting that wants to place
a call can't reach the phone channel across processes/tunnels. So the POC must run
as **one process, one tunnel, one HTTP+WS server** mounting all three channels plus
the agent socket. That consolidation is the main structural change; the `respond()`
seam makes the rest small.

**Protocol recommendation: a single bidirectional WebSocket "agent session"** (the
external agent connects as a client to `/agent`). Rationale: the live conversation
loop is *platform-drives* (push "user said X", await reply) and latency-critical,
while actions are *agent-drives* — only a persistent duplex socket does both with
low latency and one ingress; the platform is already all-WS (Twilio/MeetingBaaS/
OpenAI). REST+webhooks would force the agent to host a callback and make correlating
a reply to a live call awkward; MCP fits the *actions* but not unsolicited live
turns. So: WS now, with action verbs named MCP-shaped so an MCP facade drops in later.

## Design

### 1. The connector seam — `src/agent/connector.ts` (new)
Generalize the single `respond()` seam to a remote agent without changing how
channels call it.
```ts
export interface PlatformActions {
  say(sessionId, text): Promise<void>;        // speak/text into a live session
  placeCall(to): Promise<{ sessionId }>;
  sendSms(to, body): Promise<{ sessionId }>;
  joinMeeting(meetingUrl): Promise<{ sessionId }>;
  hangup(sessionId): Promise<void>;
  leaveMeeting(sessionId): Promise<void>;
}
export interface AgentConnector {
  start(actions: PlatformActions): Promise<void>;
  stop(): Promise<void>;
  turn(ev: TurnEvent): Promise<string>;   // platform->agent live turn -> reply text
  notify(ev: PlatformEvent): void;         // fire-and-forget (ringing/ended/joined)
}
// Adapter so RealtimeAgent/SMS keep taking a BrainFn unchanged:
export function brainFor(c: AgentConnector, sessionId): BrainFn
```
- `LocalConnector` (`src/agent/local-connector.ts`) wraps today's `respond()`; also
  the **fallback** when the remote is down. `brain.ts` is **unchanged**.
- `RemoteConnector` (`src/agent/remote-connector.ts`) speaks the WS protocol; `turn()`
  sends a `turn` with a `correlationId` and resolves on the matching `say` (or timeout);
  routes agent commands onto the injected `PlatformActions`.

### 2. WS protocol (`/agent`) — envelope `{v:1,type,id,ts,...}`, replies carry `correlationId`
- **platform → agent:** `hello{sessions[]}`, `turn{id,sessionId,channel,from,text,history}`,
  `incoming_call{sessionId,from,to}`, `incoming_sms{sessionId,from,to,text}`,
  `meeting_event{sessionId,event,who?}`, `session_ended{sessionId,reason}`,
  `action_result{correlationId,ok,sessionId?,error?}`, `error{...}`.
- **agent → platform:** `say{correlationId?,sessionId,text}`, `place_call{id,to}`,
  `send_sms{id,to,body}`, `join_meeting{id,meetingUrl}`, `hangup{id,sessionId}`,
  `leave_meeting{id,sessionId}`.
- Correlation: live turns round-trip by `id`↔`correlationId` (a `Map` in RemoteConnector);
  all proactive routing keys on `sessionId` via the registry; a `say` with no
  `correlationId` is delivered immediately to that session's live handle.

### 3. Session registry — `src/gateway/session-registry.ts` (in-memory singleton)
`LiveSession { id, kind, from, voice?: RealtimeAgent, transport?, botId?, smsTo?, teardown? }`
with `create/get(id)/byPeer(kind,from)/remove/all`. The bridge between "a live
channel session" and the connector: inbound turns look up the session to build a
`TurnEvent`; agent actions look it up to act on it. Multi-tenant later = add
`tenantId` + swap Map for Redis behind the same interface.

### 4. Platform actions — `src/gateway/actions.ts` (reuses existing services verbatim)
- `sendSms` → `twilio.sendSms`; thread via `byPeer("sms",to)` + `memory`.
- `placeCall` → reuse the shared `/voice` TwiML + `twilio.placeCall`; pre-register a
  phone session; when the media WS connects (correlate by callSid, already read in
  `call-transport.ts`) wire `RealtimeAgent` with `brainFor(connector,sessionId)` +
  `bridge()`. Outbound call becomes a normal live session that streams turns.
- `joinMeeting` → `meetingbaas.createBot`; same wiring on MeetingBaaS WS connect.
- `say` → phone/meet: `session.voice.say(text)`; sms: `twilio.sendSms` + history.
- `hangup/leaveMeeting` → `teardown()` / `leaveBot(botId)` + `remove`.

### 5. The gateway process — `src/gateway/server.ts` + `index.ts` (new; `npm run gateway`)
One HTTP+WS server, one `startTunnel`, sets both Twilio webhooks once: routes
`POST /voice`, `POST /sms`; WS `/media` (phone), `/meet` (MeetingBaaS), `/agent`
(external agent, static-token auth). Refactor each channel's `main()` into a
`mount(server, { connector, sessions })` module so all three load in one process;
keep thin per-channel runners (`npm run meet/phone/sms`) that mount one channel with
`LocalConnector` for backward-compatible single-channel runs.

### 6. Small change to `realtime-agent.ts`
Add a public `say(text)` that calls the existing private `speak()` and appends to
`this.history`, for agent-initiated utterances. The turn-reply path is unchanged.

### 7. Reference external agent — `examples/agent-client.ts`
A minimal WS client (the "external agent") so the POC is testable end to end: connects
to `/agent` with the token, on `turn` calls OpenAI (or echoes) and replies `say`, and
can issue `place_call`/`send_sms`/`join_meeting` on command. This is the artifact that
proves "any agent can plug in."

## Critical files
- **new:** `src/gateway/{server,index,session-registry,actions,agent-socket}.ts`,
  `src/agent/{connector,local-connector,remote-connector}.ts`, `examples/agent-client.ts`.
- **changed:** `src/services/openai/realtime-agent.ts` (public `say` + history append);
  `src/channels/*/index.ts` (extract `mount()`, register/deregister sessions, emit
  `incoming_*`/`meeting_event`); `package.json` (`gateway` script); `.env.example`.
- **unchanged (reused):** `src/agent/brain.ts` (wrapped by LocalConnector),
  `src/core/bridge.ts`, `src/core/voice-transport.ts`, all of `services/`.

## Edge cases (build now)
- **Turn timeout + fallback** (`AGENT_TURN_TIMEOUT_MS`): on voice timeout, speak filler
  or fall back to `LocalConnector` so the caller isn't in silence; if `/agent` is down,
  gateway runs `local` so inbound still works (proactive actions unavailable); on
  reconnect send `hello{sessions[]}`.
- **Barge-in vs pending turn:** per-session "active turn" counter; if the caller
  interrupts while a turn is in flight, mark it stale and DROP its late `say`.
- **Ordering:** serialize turns per session (voice is half-duplex); drop a `say` whose
  `correlationId` already settled.
- **Lifecycle:** every session has `teardown`; transport `closed`/agent `close`/`leaveBot`
  → `remove` + `session_ended`. Meet `botId` left on shutdown.
- **SMS:** remote path returns empty TwiML and replies out-of-band via `twilio.sendSms`
  (a slow agent must not hang the webhook); local path keeps synchronous `messageTwiml`.
- **Auth (POC):** static `AGENT_WS_TOKEN` checked on `/agent` upgrade.

## Config (`.env`)
`AGENT_MODE=local|remote` (default `local` = today's behavior), `AGENT_WS_TOKEN`,
`AGENT_TURN_TIMEOUT_MS` (~6000 voice / ~15000 sms), `GATEWAY_PORT`.

## Build now vs defer
**Now (POC, one agent, in-memory):** items 1–7 above + the edge cases.
**Defer (keep hooks, don't build):** multi-tenancy (`tenantId` dimension), API-key
issuance + Twilio signature validation, per-tenant numbers/subaccounts, persistence
(Redis/Postgres) + reconnect resync, billing/rate-limits, an MCP facade over the
action verbs, REST+webhooks for non-latency-critical async, real ingress (replace
free ngrok / multi-tunnel).

## Verification
1. `tsc --noEmit` passes; `npm run meet/phone/sms` still work unchanged in `local` mode (regression).
2. `npm run gateway` in `remote` mode + `examples/agent-client.ts` connected:
   - **Inbound voice:** call the number → `incoming_call` + `turn`s reach the client → its `say` is spoken back (barge-in still works).
   - **Inbound SMS:** text the number → `incoming_sms`/`turn` → client `say` returns as an SMS.
   - **Agent-initiated:** tell the client to `place_call`/`send_sms`/`join_meeting` → the platform performs it and the resulting call/meeting streams `turn`s back (an outbound call becomes a live session).
3. **Resilience:** kill the agent client mid-call → gateway falls back to local/filler, no crash; reconnect → `hello` resync.
