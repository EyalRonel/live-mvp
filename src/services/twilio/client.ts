import twilio from "twilio";
import { requireEnv } from "../../shared/config";

let _client: ReturnType<typeof twilio> | undefined;

function client() {
  if (!_client) {
    _client = twilio(requireEnv("TWILIO_ACCOUNT_SID"), requireEnv("TWILIO_AUTH_TOKEN"));
  }
  return _client;
}

function agentNumber(): string {
  return requireEnv("TWILIO_PHONE_NUMBER");
}

/** Resolve the SID of our configured TWILIO_PHONE_NUMBER. */
async function numberSid(): Promise<string> {
  const number = agentNumber();
  const matches = await client().incomingPhoneNumbers.list({ phoneNumber: number, limit: 1 });
  if (!matches.length) {
    throw new Error(`TWILIO_PHONE_NUMBER ${number} not found on this Twilio account`);
  }
  return matches[0].sid;
}

/** Point the number's Voice webhook at our current public URL (inbound calls). */
export async function setVoiceWebhook(voiceUrl: string): Promise<void> {
  const sid = await numberSid();
  await client().incomingPhoneNumbers(sid).update({ voiceUrl, voiceMethod: "POST" });
}

/** Point the number's Messaging webhook at our current public URL (inbound SMS). */
export async function setSmsWebhook(smsUrl: string): Promise<void> {
  const sid = await numberSid();
  await client().incomingPhoneNumbers(sid).update({ smsUrl, smsMethod: "POST" });
}

/** Place an outbound call; on answer Twilio fetches `voiceUrl` for TwiML. */
export async function placeCall(to: string, voiceUrl: string): Promise<string> {
  const call = await client().calls.create({ to, from: agentNumber(), url: voiceUrl });
  return call.sid;
}

/** Send a literal outbound SMS (no LLM). */
export async function sendSms(to: string, body: string): Promise<string> {
  const msg = await client().messages.create({ to, from: agentNumber(), body });
  return msg.sid;
}
