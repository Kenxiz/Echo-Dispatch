import { EmbedBuilder } from "discord.js";

const topics = {
  overview: {
    title: "Echo Dispatch Guide",
    description: "Voice-first police dispatch for the configured radio channel. Use `/guide topic:<topic>` for focused instructions.",
    fields: [
      ["1. Register", "Join the radio voice channel, then run `/unit register`. Include the callsign you use in ER:LC; linking your exact Roblox username enables live panic-location lookup."],
      ["2. Start dispatch", "Run `/dispatch start`. Verify connection and ER:LC status with `/dispatch status`."],
      ["3. Use the radio", "Address dispatch with your callsign and concise traffic: “1 Lincoln 18, show me 10-8.” Wait for the dispatcher acknowledgement before transmitting again."],
      ["4. Handle calls", "Use `/911` to submit a call. AI assigns Priority 1–3. Units can attach, respond, update the scene, request resources, and call Code 4 by voice."],
      ["Topics", "`quick-start`, `radio`, `calls`, `panic`, `codes`, `commands`, `troubleshooting`"],
    ],
  },
  "quick-start": {
    title: "Guide • Quick Start",
    fields: [
      ["Unit setup", "1. Join the configured voice channel.\n2. `/unit register callsign:1L-18 rank:Officer division:Patrol roblox_username:ExactName`\n3. `/dispatch start`\n4. `/dispatch status`"],
      ["First radio check", "Transmit: “1 Lincoln 18, radio check.” Echo Dispatch will acknowledge or request a 10-9 if the traffic is unclear."],
      ["Permissions", "Echo Dispatch needs View Channel, Connect, Speak, Use Voice Activity, Send Messages, Embed Links, Read Message History, and Mute Members. Its role must be above unit roles for radio interruption control."],
    ],
  },
  radio: {
    title: "Guide • Radio Procedure",
    fields: [
      ["Calling dispatch", "Lead with your callsign or “Dispatch,” then give one concise request. Examples: “1 Lincoln 18, show me 10-17 to CALL-0002,” or “Dispatch, 1 Lincoln 18, traffic stop postal 205.”"],
      ["Acknowledgements", "Every valid directed transmission receives a realistic reply. If the dispatcher cannot confidently understand the traffic, it responds with a 10-9 instead of guessing."],
      ["Channel control", "One unit owns the air through the dispatcher reply. Units cutting in are temporarily server-muted unless they explicitly declare emergency traffic."],
      ["Automatic calls", "911 callouts wait until unit traffic and the dispatcher reply are finished. Priority calls move ahead of routine queued announcements."],
    ],
  },
  calls: {
    title: "Guide • Calls and Priorities",
    fields: [
      ["Submit a call", "Use `/911` with location, incident, description, and any known suspect, vehicle, weapon, or injury information. Caller wording is summarized into a professional callout."],
      ["AI priority", "Priority 1: immediate life/officer-safety threat (Code 3).\nPriority 2: urgent/time-sensitive incident (Code 2).\nPriority 3: routine/delayed report (Code 1)."],
      ["Unit traffic", "Units may attach to a call, advise 10-17/en route, 10-23/on scene, request resources, provide suspect/vehicle/hazard updates, or clear."],
      ["Code 4", "When an attached unit calls Code 4, the scene is secured, the call closes, and every attached unit returns to 10-8."],
    ],
  },
  panic: {
    title: "Guide • Officer Panic",
    fields: [
      ["Recognized traffic", "10-33, mass panic, panic button/alarm, emergency traffic, officer needs help/down, taking fire, shots fired, assist officer, or an immediate-unit request."],
      ["What Echo Dispatch does", "Takes priority over routine traffic, marks the unit emergency/Code 3, requests the unit's live ER:LC player location, updates the unit record, posts a red mass-panic alert, and broadcasts all available units Code 3."],
      ["Location matching", "The bot matches the exact linked Roblox username first and ER:LC callsign second. If live lookup fails, it announces the last known location or asks the unit to advise when able."],
      ["Important", "Use panic language only for real roleplay emergencies. Repeated panic traffic is acknowledged but mass alerts are briefly deduplicated to prevent radio flooding."],
    ],
  },
  codes: {
    title: "Guide • Common Radio Codes",
    fields: [
      ["Core status", "10-4 affirmative • 10-6 busy • 10-7 out of service • 10-8 in service • 10-9 repeat • 10-17 en route • 10-20 location • 10-23 on scene • 10-33 help quick"],
      ["Common incidents", "10-43 chase • 10-50 collision • 10-51 wrecker • 10-52 ambulance • 10-53 roadway blocked • 10-61 traffic stop • 10-65 armed robbery • 10-80 domestic • 10-82 person with gun • 10-94 gunshot wound"],
      ["Response codes", "Code 1 routine • Code 2 urgent • Code 3 emergency • Code 4 secure and close assigned scene"],
      ["Full list", "The dispatcher recognizes the configured department list from 10-1 through 10-99, 10-105 through 10-108, Signal 11, and Codes 1–4. Unknown codes receive a 10-9 request."],
    ],
  },
  commands: {
    title: "Guide • Commands",
    fields: [
      ["Dispatch", "`/dispatch start` • `/dispatch stop` • `/dispatch status`"],
      ["Units", "`/unit register` • `/unit unregister` • `/unit list` • `/unit info` • `/unit status` • `/unit response` • `/unit location`"],
      ["Calls", "`/911` • `/call list` • `/call info` • `/call status` • `/call scene` • `/call response` • `/call resource` • `/call note` • `/call close`"],
      ["Help", "`/guide` or `/guide topic:<topic>`"],
    ],
  },
  troubleshooting: {
    title: "Guide • Troubleshooting",
    fields: [
      ["No voice reply", "Confirm the unit is registered, the bot is in the same voice channel, the unit is not server-muted, and `/dispatch status` shows Voice Connected. Speak clearly for at least a brief radio transmission."],
      ["False activations", "Increase `VOICE_RMS_THRESHOLD` gradually. Keep microphones away from speakers and use push-to-talk where possible."],
      ["Panic location unavailable", "Register the exact Roblox username, ensure that player is in the ER:LC server, and confirm `/dispatch status` reports a working ER:LC connection."],
      ["Cannot control interruptions", "Grant Mute Members and move the Echo Dispatch role above unit roles. The bot tracks and releases only its own temporary mutes."],
      ["Commands look outdated", "Run `npm run deploy-commands`, then restart `npm run dev`."],
    ],
  },
};

export function buildGuideEmbed(topic = "overview") {
  const guide = topics[topic] ?? topics.overview;
  const embed = new EmbedBuilder().setTitle(guide.title).setColor(0x2563eb);
  if (guide.description) embed.setDescription(guide.description);
  embed.addFields(...guide.fields.map(([name, value]) => ({ name, value })));
  return embed.setFooter({ text: "Echo Dispatch • Professional radio traffic" });
}
