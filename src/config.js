import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
const envSchema = z.object({
    DISCORD_TOKEN: z.string().min(1),
    DISCORD_CLIENT_ID: z.string().min(1),
    DISCORD_GUILD_ID: z.string().min(1),
    DISCORD_VOICE_CHANNEL_ID: z.string().min(1),
    DISCORD_TEXT_CHANNEL_ID: z.string().min(1),
    GEMINI_API_KEY: z.string().min(1),
    GEMINI_LIVE_MODEL: z.string().default("gemini-3.1-flash-live-preview"),
    GEMINI_TRIAGE_MODEL: z.string().default("gemini-3.1-flash-lite"),
    GEMINI_VOICE_NAME: z.string().default("Kore"),
    ERLC_SERVER_KEY: z.string().trim().min(1),
    ERLC_API_BASE_URL: z.string().url().default("https://api.erlc.gg"),
    HTTP_PORT: z.coerce.number().int().positive().default(3000),
    ERLC_POLL_INTERVAL_MS: z.coerce.number().int().min(5000).default(15000),
    CALL_REANNOUNCE_DELAY_MS: z.coerce.number().int().min(30000).default(120000),
    VOICE_END_SILENCE_MS: z.coerce.number().int().min(150).max(1000).default(225),
    VOICE_MIN_TRANSMISSION_MS: z.coerce.number().int().min(100).max(2000).default(300),
    VOICE_RMS_THRESHOLD: z.coerce.number().int().min(50).max(10000).default(450),
    RADIO_INTERRUPT_GRACE_MS: z.coerce.number().int().min(400).max(2000).default(900),
    PANIC_COOLDOWN_MS: z.coerce.number().int().min(5000).max(120000).default(15000),
});
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function loadConfig() {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
        const missing = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
        throw new Error(`Invalid or missing environment variables: ${missing}`);
    }
    return {
        ...parsed.data,
        rootDir,
        dataDir: path.join(rootDir, "data"),
        radioCodesPath: path.join(rootDir, "config", "radio-codes.json"),
    };
}
