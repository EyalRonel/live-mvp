/** Parse Twilio's inbound-SMS webhook body (application/x-www-form-urlencoded). */
export function parseInboundSms(body: string): { from: string; text: string } {
  const params = new URLSearchParams(body);
  return { from: params.get("From") || "", text: (params.get("Body") || "").trim() };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** TwiML that replies to the inbound SMS with `text`. */
export function messageTwiml(text: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response><Message>${escapeXml(text)}</Message></Response>`
  );
}
