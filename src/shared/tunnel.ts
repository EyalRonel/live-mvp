export interface Tunnel {
  /** Public HTTPS base, e.g. https://abc.ngrok-free.dev (for webhooks). */
  url: string;
  /** Same host as wss://, for WebSocket endpoints. */
  wsUrl: string;
}

/**
 * Expose a local `port` publicly so external providers (MeetingBaaS, Twilio) can
 * reach us. Uses an ngrok tunnel (NGROK_AUTHTOKEN) or a URL you supply yourself
 * (PUBLIC_WS_URL). Returns both the https and wss forms of the same host.
 */
export async function startTunnel(port: number): Promise<Tunnel> {
  const explicit = process.env.PUBLIC_WS_URL;
  if (explicit) {
    return {
      url: explicit.replace(/^wss:/, "https:").replace(/^ws:/, "http:"),
      wsUrl: explicit.replace(/^https:/, "wss:").replace(/^http:/, "ws:"),
    };
  }

  const token = process.env.NGROK_AUTHTOKEN;
  if (!token) {
    console.error(
      "Need a public URL for the provider to reach you. Set either:\n" +
        "  NGROK_AUTHTOKEN  — auto-open an ngrok tunnel (free at ngrok.com), or\n" +
        "  PUBLIC_WS_URL    — a wss:// URL from your own tunnel"
    );
    process.exit(1);
  }

  const ngrok = await import("@ngrok/ngrok");
  const listener = await ngrok.forward({ addr: port, authtoken: token });
  const httpsUrl = listener.url();
  if (!httpsUrl) throw new Error("ngrok did not return a public URL");
  return { url: httpsUrl, wsUrl: httpsUrl.replace(/^https:/, "wss:") };
}
