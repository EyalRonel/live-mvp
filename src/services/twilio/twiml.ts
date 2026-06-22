/**
 * TwiML that connects a call's audio to our Media Streams WebSocket,
 * bidirectionally (<Connect> blocks and allows sending audio back).
 */
export function connectStreamTwiml(mediaWsUrl: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response><Connect><Stream url="${mediaWsUrl}"/></Connect></Response>`
  );
}
