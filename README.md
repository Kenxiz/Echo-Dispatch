# Echo Dispatch

Echo Dispatch is a voice-first Discord police dispatcher for an Emergency Response: Liberty County roleplay server. It listens to each officer's Discord audio separately, identifies the speaker by Discord user ID, sends completed radio transmissions to Gemini Live, validates Gemini's requested actions in JavaScript, persists confirmed state, and plays the dispatcher response back in the configured voice channel.

This initial version uses one Discord voice channel, one Discord text channel, and JSON files. It does not require roles, a database server, a dashboard, Docker, or a web framework.

## Included features

- Per-user Discord voice receiving with silence-based transmission boundaries
- Gemini Live native-audio understanding, function calling, input/output transcripts, and speech
- Code-owned validation for unit status, location, call attachment, response status, assistance requests, and call closure
- Callsign-only responses and law-enforcement phonetics
- Unit registration, general status, location, call assignment, and separate response status
- Discord `/911` submissions and ER:LC in-game emergency-call ingestion
- ER:LC v2 server/player/join-log polling
- Optional signed ER:LC event webhook endpoint at `POST /erlc/webhook`
- Active-call embeds that are edited in place
- One controlled dispatcher playback queue, channel ownership, and server-mute interruption control
- Explicit emergency-traffic bypass for interrupted units
- Noise gating that ignores short, silent, and low-level microphone activations
- Text-only delayed reminders for unassigned calls
- Automatic 911 voice announcements that queue behind ongoing unit/dispatcher traffic
- Validated, serialized, atomic JSON writes with three rotating backups and recovery
- Restart restoration for units, calls, settings, and recent transcripts

## Requirements

- Node.js 22.12 or newer
- A Discord application/bot in the target server
- A Google Gemini API key with access to the configured Live model
- An ER:LC private-server key

The project installs `opusscript`, so a native compiler is not required. For a busy production server on a supported Node version, `@discordjs/opus` can be installed as a faster optional replacement.

## Install

```powershell
npm install
Copy-Item .env.example .env
```

The local `.env` is ignored by Git. This workspace already contains the supplied channel IDs. The supplied ER:LC value was rejected by the live API as a malformed server key, so it was removed to prevent repeated invalid-key requests; provide a newly generated key along with the Discord and Gemini values.

Fill these values:

| Variable | Purpose |
|---|---|
| `DISCORD_TOKEN` | Discord bot token |
| `DISCORD_CLIENT_ID` | Discord application ID |
| `DISCORD_GUILD_ID` | Discord server ID |
| `DISCORD_VOICE_CHANNEL_ID` | The one radio voice channel |
| `DISCORD_TEXT_CHANNEL_ID` | The one commands/calls/logs channel |
| `GEMINI_API_KEY` | Google AI Studio Gemini key |
| `GEMINI_LIVE_MODEL` | Live native-audio model; default is `gemini-3.1-flash-live-preview` |
| `GEMINI_TRIAGE_MODEL` | Fast structured-output model for 911 priority assignment; default is `gemini-3.1-flash-lite` |
| `GEMINI_VOICE_NAME` | Gemini prebuilt voice; default is `Kore` |
| `ERLC_SERVER_KEY` | ER:LC private-server key sent as the `server-key` header |
| `ERLC_API_BASE_URL` | Default `https://api.erlc.gg` |
| `HTTP_PORT` | Local webhook listener port; default `3000` |
| `ERLC_POLL_INTERVAL_MS` | Snapshot polling interval; minimum 5000 ms |
| `CALL_REANNOUNCE_DELAY_MS` | One-time unassigned-call reminder delay |
| `VOICE_END_SILENCE_MS` | Silence that ends a transmission; default 225 ms |
| `VOICE_MIN_TRANSMISSION_MS` | Minimum audio duration accepted as speech; default 300 ms |
| `VOICE_RMS_THRESHOLD` | PCM noise-gate threshold; raise it if background noise triggers the bot |
| `RADIO_INTERRUPT_GRACE_MS` | Time allowed to recognize an emergency cut-in before server muting |
| `PANIC_COOLDOWN_MS` | Per-unit mass-panic deduplication window; default 15000 ms |

## Discord setup

Invite the bot with the `bot` and `applications.commands` scopes. In the configured channels it needs:

- View Channels
- Connect and Speak
- Send Messages
- Embed Links
- Read Message History
- Use Application Commands
- Mute Members

Place the bot's Discord role above every unit role so it can apply and release server mutes. No privileged gateway intents are required.

Register the guild slash commands after filling the Discord variables:

```powershell
npm run deploy-commands
```

Guild commands normally appear immediately. Run the registration command again after changing command definitions.

## Run

Development:

```powershell
npm run dev
```

Production start:

```powershell
npm run check
npm start
```

The application is native ESM JavaScript and runs directly in Node.js; there is no compilation or build step.

Then run `/dispatch start` in the configured text channel. The stopped/running setting persists across restarts; if the bot was running during a clean or unclean restart, it reconnects automatically.

## Commands

```text
/dispatch start
/dispatch stop
/dispatch status

/guide [topic]

/unit register callsign rank division [roblox_username]
/unit unregister
/unit list
/unit info [callsign]
/unit status status
/unit response mode
/unit location location

/911 location incident description [suspect] [vehicle] [weapon] [injuries]

/call list
/call info call_id
/call status call_id status
/call scene call_id status
/call response call_id mode
/call resource call_id resource
/call note call_id note
/call close call_id
```

Commands are accepted only in the configured guild and text channel. There are intentionally no role checks in this initial version.

## Radio operation

Echo Dispatch responds to registered, directed radio traffic and automatically announces accepted 911 calls. Automatic announcements never interrupt a unit or the dispatcher's response: they wait in a priority-aware queue until the channel is clear. If emergency traffic interrupts an announcement, the announcement is requeued and read afterward. The one-time unassigned-call reminder follows the same rule.

911 announcements are generated from the call's structured priority, incident, location, safety, suspect, vehicle, injury, and response-mode fields. Echo Dispatch professionally summarizes caller language rather than reading the report verbatim, preserves uncertainty, omits filler, and targets a 10-20 second callout ending with the assigned response code. Caller text is treated as untrusted data and cannot override the announcement rules.

Before creating either a Discord or ER:LC call, Echo Dispatch uses structured AI triage to assign Priority 1 (immediate threat to life/officer safety), Priority 2 (urgent or time-sensitive), or Priority 3 (routine/delayed). Callers cannot select their own priority. The call embed records the classification source and a short operational reason. If AI triage is unavailable or invalid, conservative local safety rules assign a fallback priority so the call is still accepted.

The first unit to transmit owns the channel until their transmission has been understood and Echo Dispatch finishes its reply. If another unit cuts in, Echo Dispatch waits briefly for an explicit emergency declaration, then server-mutes that unit until the channel clears. A recognized phrase such as “emergency traffic,” “officer needs help,” or “shots fired” interrupts routine traffic and receives priority. Mutes applied by Echo Dispatch are tracked, so it does not remove a mute that was originally applied by a moderator.

Every speech-gated transmission that is directed to dispatch receives a spoken reply. If the transmission is unintelligible, the requested action is unclear, or Gemini cannot complete the radio turn, Echo Dispatch uses the unit's callsign and requests a 10-9 instead of guessing. Clearly unrelated background speech remains ignored.

Officer panic phrases—including 10-33, panic button, officer down/needs help, taking fire, and shots fired—start a mass-panic workflow. Echo Dispatch marks the unit emergency with a Code 3 response, queries the ER:LC v2 player list, matches the linked Roblox username or callsign, records the returned street/building/postal location, posts a red text alert, and broadcasts all available units Code 3. If live lookup fails, it uses the last known location or asks the unit to advise when able. Cleared, disregarded, or Code 4 references to an earlier shots-fired call do not reactivate a panic.

`/guide` provides an in-Discord operating manual. Its topics cover quick start, radio procedure, calls and AI priorities, officer panic, common radio codes, all commands, permissions, and troubleshooting.

If background audio still triggers the bot, increase `VOICE_RMS_THRESHOLD` in `.env` in increments of 100. If quiet microphones are ignored, lower it gradually. `VOICE_END_SILENCE_MS` controls reply responsiveness; values below 200 ms may cut off natural pauses.

## Codes and operational statuses

`config/radio-codes.json` contains the department code set supplied for this server: 10-1 through 10-99, 10-105 through 10-108, Signal 11, and Code 1 through Code 4. Meanings and aliases are editable. Unknown codes are not guessed.

- Code 1: routine response
- Code 2: urgent response
- Code 3: emergency response
- Code 4: when called by a unit attached to a scene, marks the scene secure, closes the call, and returns every attached unit to 10-8

Unit records separately track general activity, assigned call, call-response status, response mode, and location. Calls separately track operational status, scene status, priority, response mode, assigned units, requested resources, factual unit updates, and closure. Voice traffic can update these fields through validated actions; the `/unit` and `/call` commands provide manual controls. EMS, fire, wrecker, supervisor, and additional-unit requests are recorded without falsely claiming that an external resource has responded.

## ER:LC integration

The implementation uses the official v2 endpoint:

```text
GET https://api.erlc.gg/v2/server?Players=true&JoinLogs=true&EmergencyCalls=true
server-key: <ERLC_SERVER_KEY>
```

The documented `EmergencyCalls` snapshot is polled and deduplicated using `CallNumber` plus `StartedAt`. The same adapter accepts official event webhooks. To use webhooks, expose the local listener as a public HTTPS URL and put this URL in the ER:LC private-server Event Webhook setting:

```text
https://your-public-host.example/erlc/webhook
```

Echo Dispatch verifies the exact raw request with the official Ed25519 public key, rejects missing/invalid/stale signatures, and then finds the documented emergency-call object in the signed payload. A TLS reverse proxy or hosting platform must provide HTTPS; the bot's intentionally small HTTP server listens on `HTTP_PORT` only. Polling remains enabled because the official documentation says webhooks are not a polling replacement.

If ER:LC returns `403` with error code `2001` (malformed key) or `2002` (invalid/expired key), open the private server's in-game Settings, find **ER:LC API**, press **Generate**, copy the entire replacement value into `ERLC_SERVER_KEY` in `.env`, and restart the bot. Echo Dispatch disables further ER:LC requests after the first `403` so an invalid credential cannot create a retry loop or trigger an API IP ban.

Official references:

- [Fetch server information](https://apidocs.erlc.gg/api-reference/fetch-server-information)
- [API error codes](https://apidocs.erlc.gg/error-codes)
- [Rate limits and invalid-key safety](https://apidocs.erlc.gg/rate-limits)
- [Event webhooks](https://apidocs.erlc.gg/event-webhooks)

## Data and recovery

The bot creates these files automatically:

```text
data/units.json
data/calls.json
data/settings.json
data/transmissions.json
```

Writes are serialized per file, validated with Zod, written to a unique temporary file, and atomically renamed. Before replacement, the current valid file is copied to a timestamped backup. Three backups per file are retained. If a primary file is missing or invalid at startup, the newest valid backup is loaded.

The transcript log retains the newest 500 transmissions. Tokens and keys are never written into these data files or Discord messages.

## Tests

```powershell
npm test
```

The initial tests cover callsign/phonetic formatting, duplicate unit prevention, call ambiguity, separate general/response statuses, call closure, and assigned-unit cleanup.

## Verified limitations

- Discord does not document audio receiving as a public stable voice feature. `@discordjs/voice` supports it, but its maintainers explicitly warn that stable receive support is not guaranteed.
- Gemini Live native-audio models return raw 16-bit PCM at 24 kHz and accept raw little-endian PCM input. Echo Dispatch converts Discord's decoded mono PCM into that flow, then converts Gemini output to Discord's 48 kHz stereo raw format.
- Native-audio Live models support audio response modality; text logs come from the Live input/output transcription features and can differ slightly from the exact spoken audio.
- Each completed officer transmission opens a short-lived Live session. This prevents context or identity from leaking between Discord users, but connection setup still contributes some latency. Low thinking mode and a 275 ms end-of-speech window reduce the response delay.
- Emergency bypass requires enough of the first phrase to be captured during `RADIO_INTERRUPT_GRACE_MS`. The unit is prompted to repeat emergency traffic after routine audio is interrupted.
- Discord server muting requires the Mute Members permission and correct role hierarchy. Without them, the bot posts one warning and continues processing the first unit safely.
- The webhook listener does not terminate TLS. A public HTTPS reverse proxy/tunnel is required before ER:LC can validate and save the URL.
- Join/leave notices come from the documented snapshot logs and therefore arrive at polling cadence rather than as real-time presence events.

## Project structure

```text
config/radio-codes.json
src/
  ai/
    actions.js
    dispatcher-prompt.js
    gemini.js
  database/
    json-database.js
    store.js
  discord/
    client.js
    commands.js
    interactions.js
    text-channel.js
  dispatch/
    call-service.js
    dispatch-service.js
    unit-service.js
  erlc/
    client.js
    emergency-call-adapter.js
    webhook-server.js
  utils/
    radio.js
  voice/
    audio-gate.js
    playback.js
    voice-manager.js
  app.js
  config.js
  deploy-commands.js
  index.js
  types.js
scripts/
  check.js
tests/
  audio-gate.test.js
  database.test.js
  dispatch.test.js
  erlc-adapter.test.js
  radio-codes.test.js
  radio.test.js
  voice-behavior.test.js
.env.example
.gitignore
package-lock.json
package.json
vitest.config.js
```
