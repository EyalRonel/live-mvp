import { AGENT_NAME } from "../../shared/persona";

const BAAS_BASE = "https://api.meetingbaas.com/v2";

// MeetingBaaS streams raw PCM s16le mono. We use 24kHz so it matches the OpenAI
// Realtime API exactly — no resampling needed in either direction.
export const SAMPLE_RATE = 24000;

function authHeaders() {
  return {
    "x-meeting-baas-api-key": process.env.BAAS_API_KEY || "",
    "Content-Type": "application/json",
  };
}

/**
 * Create a MeetingBaaS bot and send it into the meeting, configured to stream
 * bidirectional audio to/from `publicWsUrl` (a single bidirectional socket).
 * Returns the bot_id.
 */
export async function createBot(meetingUrl: string, publicWsUrl: string): Promise<string> {
  const res = await fetch(`${BAAS_BASE}/bots`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      meeting_url: meetingUrl,
      bot_name: AGENT_NAME,
      streaming_enabled: true,
      streaming_config: {
        // Same URL for both => one bidirectional WebSocket connection.
        // output_url: bot SENDS meeting audio here (we receive).
        // input_url:  bot RECEIVES audio here to speak (we send).
        output_url: publicWsUrl,
        input_url: publicWsUrl,
        audio_frequency: SAMPLE_RATE,
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MeetingBaaS createBot failed (${res.status}): ${text}`);
  }
  const json: any = await res.json();
  const botId = json?.data?.bot_id || json?.bot_id;
  if (!botId) {
    throw new Error(`MeetingBaaS createBot: no bot_id in response: ${JSON.stringify(json)}`);
  }
  return botId;
}

/** Instruct the bot to leave the meeting (best-effort, for shutdown). */
export async function leaveBot(botId: string): Promise<void> {
  try {
    await fetch(`${BAAS_BASE}/bots/${botId}/leave`, {
      method: "POST",
      headers: authHeaders(),
    });
  } catch {
    // best-effort
  }
}
