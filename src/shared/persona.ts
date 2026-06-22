import "./config"; // ensure .env is loaded before we read AGENT_NAME

export type Channel = "meet" | "phone" | "sms";

/** The agent's name — used as the meeting display name and the wake word. */
export const AGENT_NAME = process.env.AGENT_NAME?.trim() || "Rally";

// ── Voice & tone (edit here, or override via .env) ─────────────────────────
// VOICE = which OpenAI voice is heard on calls/meetings. Options include:
//   alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar
// (marin / cedar are the newest, most natural for phone). Hear them at openai.fm.
export const AGENT_VOICE = process.env.AGENT_VOICE?.trim() || "marin";

// TONE = the personality/delivery style. Woven into the brain's word choice AND
// the spoken delivery on voice channels. Make it as specific as you like.
export const AGENT_TONE =
  process.env.AGENT_TONE?.trim() || "warm, upbeat, and concise";

// Wake-word terms = the name plus any AGENT_ALIASES (for speech-to-text mishears).
export const WAKE_TERMS: string[] = [
  AGENT_NAME,
  ...(process.env.AGENT_ALIASES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True if `text` addresses the agent by one of `terms` (word-boundary, case-insensitive). */
export function matchesWakeWord(text: string, terms: string[] = WAKE_TERMS): boolean {
  if (!terms.length) return false;
  const re = new RegExp(`\\b(${terms.map(escapeRegex).join("|")})\\b`, "i");
  return re.test(text);
}

/** One persona, phrased per channel. */
export function buildSystemPrompt(channel: Channel): string {
  const base = `Your name is ${AGENT_NAME}. Your tone is ${AGENT_TONE}.`;
  switch (channel) {
    case "meet":
      return (
        `${base} You are a helpful assistant in a Google Meet meeting. You only ` +
        "speak when someone addresses you directly by name. Keep responses concise " +
        "since this is a voice conversation, and do not announce that you were addressed."
      );
    case "phone":
      return (
        `${base} You are a helpful assistant on a phone call. Greet the caller ` +
        "warmly when the call connects, then have a natural back-and-forth. Keep " +
        "responses concise and conversational."
      );
    case "sms":
      return (
        `${base} You are a helpful assistant replying over SMS. Keep replies short ` +
        "and to the point — a sentence or two, no markdown."
      );
  }
}
