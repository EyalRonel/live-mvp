import { buildSystemPrompt, Channel } from "../shared/persona";

export interface Msg {
  role: "user" | "assistant";
  content: string;
}

export interface ConversationContext {
  channel: Channel; // "meet" | "phone" | "sms"
  from: string; // who we're talking to (caller number, participant, ...)
  history: Msg[]; // prior turns, NOT including the current userText
}

export type BrainFn = (userText: string, ctx: ConversationContext) => Promise<string>;

const MODEL = process.env.AGENT_MODEL || process.env.SMS_MODEL || "gpt-4o-mini";

/**
 * THE agent. Every channel (Meet, phone, SMS) routes here: it receives what the
 * user said plus context, and returns the reply text. The rails handle delivery
 * (speaking it on voice, texting it on SMS).
 *
 * The default implementation is a plain OpenAI chat completion using the shared
 * persona. Replace the body with your own logic (tools, RAG, another model, ...)
 * and every channel uses it — no plumbing changes.
 */
export async function respond(userText: string, ctx: ConversationContext): Promise<string> {
  const messages = [
    { role: "system", content: buildSystemPrompt(ctx.channel) },
    ...ctx.history,
    { role: "user", content: userText },
  ];

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY || ""}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, messages }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Brain (chat completion) failed (${res.status}): ${text}`);
  }
  const json: any = await res.json();
  return json.choices?.[0]?.message?.content?.trim() || "";
}
