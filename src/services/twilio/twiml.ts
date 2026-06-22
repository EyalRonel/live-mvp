/**
 * TwiML that connects a call's audio to our Media Streams WebSocket,
 * bidirectionally (<Connect> blocks and allows sending audio back).
 */
export function connectStreamTwiml(mediaWsUrl: string, caller?: string): string {
  // Pass the caller's number through to the media stream as a custom parameter,
  // so the agent knows who it's talking to (surfaces in start.customParameters).
  const param = caller
    ? `<Parameter name="caller" value="${caller.replace(/"/g, "")}"/>`
    : "";
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response><Connect><Stream url="${mediaWsUrl}">${param}</Stream></Connect></Response>`
  );
}
