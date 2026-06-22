import { Msg } from "../../services/openai/text-agent";

// Per-sender conversation history, in-process only (lost on restart — fine for MVP).
const MAX_TURNS = 6; // keep the last N messages per sender
const store = new Map<string, Msg[]>();

export function getHistory(from: string): Msg[] {
  return store.get(from) || [];
}

export function append(from: string, msg: Msg): void {
  const history = store.get(from) || [];
  history.push(msg);
  // Trim to the last MAX_TURNS messages.
  store.set(from, history.slice(-MAX_TURNS));
}
