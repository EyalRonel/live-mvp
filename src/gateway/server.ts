import express, { Express } from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { startTunnel } from "../shared/tunnel";

export interface GatewayUrls {
  https: string; // public https base, e.g. https://abc.ngrok-free.dev
  wss: string; // same host as wss://
}

/**
 * A single Express + ws server behind one tunnel. Channels mount HTTP routes on
 * `app` and WebSocket paths via `onWs(path, handler)`. `start()` listens + opens
 * the tunnel and fills `urls` (handlers read them per request, after start()).
 */
export interface Gateway {
  app: Express;
  server: http.Server;
  onWs(path: string, handler: (ws: WebSocket, req: http.IncomingMessage) => void): void;
  urls: GatewayUrls;
  start(): Promise<void>;
}

export function createGateway(port: number): Gateway {
  const app = express();
  app.use(express.urlencoded({ extended: false })); // Twilio webhooks
  app.use(express.json()); // /meet/join

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  const routes = new Map<string, (ws: WebSocket, req: http.IncomingMessage) => void>();

  // Route WebSocket upgrades by path (e.g. /media, /meet).
  server.on("upgrade", (req, socket, head) => {
    const path = (req.url || "").split("?")[0];
    const handler = routes.get(path);
    if (!handler) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handler(ws, req));
  });

  const urls: GatewayUrls = { https: "", wss: "" };

  return {
    app,
    server,
    onWs: (path, handler) => routes.set(path, handler),
    urls,
    async start() {
      await new Promise<void>((resolve) => server.listen(port, resolve));
      const t = await startTunnel(port);
      urls.https = t.url;
      urls.wss = t.wsUrl;
    },
  };
}
