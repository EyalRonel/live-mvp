import * as dotenv from "dotenv";

// Load .env once, as a side effect of importing this module. Entry points should
// import this first so process.env is populated before anything reads it.
dotenv.config();

export const DEBUG = !!process.env.DEBUG;

/** Read a required env var or exit with a clear message. */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return v;
}
