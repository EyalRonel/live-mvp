import { buildSystemPrompt } from "../../shared/persona";

export interface Msg {
  role: "user" | "assistant";
  content: string;
}

const MODEL = process.env.SMS_MODEL || "gpt-4o-mini";

/**
 * Generate the agent's SMS reply given the conversation history for one sender.
 * Plain Chat Completions over `fetch` (no SDK). Returns the assistant text.
 */
export async function replyTo(history: Msg[]): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY || ""}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: buildSystemPrompt("sms") }, ...history],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI chat completion failed (${res.status}): ${text}`);
  }
  const json: any = await res.json();
  return json.choices?.[0]?.message?.content?.trim() || "";
}
