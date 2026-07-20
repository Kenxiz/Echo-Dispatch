import { EmbedBuilder } from "discord.js";

const topics = {
  overview: {
    title: "Echo Dispatch Guide",
    description:
      "Voice-first police dispatch for the configured radio channel. Use `/guide topic:<topic>` for focused instructions.",
    fields: [
      [
        "1. Register",
        "Join the radio channel and run `/unit register`. Linking the exact Roblox username enables live panic-location lookup.",
      ],
      ["2. Start dispatch", "Run `/dispatch start`, then verify voice and ER:LC with `/dispatch status`."],
      [
        "3. Use the radio",
        "Address dispatch with your callsign and concise traffic. Wait for the acknowledgement before transmitting again.",
      ],
      [
        "4. Handle calls",
        "Use `/911` to submit calls. AI assigns Priority 1–3, merges matching callers, and creates a professional voice callout.",
      ],
      ["Topics", "`quick-start`, `radio`, `calls`, `panic`, `codes`, `commands`, `cad`, `troubleshooting`"],
    ],
  },
  "quick-start": {
    title: "Guide • Quick Start",
    fields: [
      [
        "Unit setup",
        "1. Join voice.\n2. `/unit register callsign:1L-18 rank:Officer division:Patrol roblox_username:ExactName`\n3. `/dispatch start`\n4. `/dispatch status`",
      ],
      [
        "First traffic",
        "Transmit: “1 Lincoln 18, radio check.” Echo Dispatch will acknowledge or request only the unclear detail.",
      ],
      [
        "Permissions",
        "The bot needs View Channel, Connect, Speak, Send Messages, Embed Links, Read Message History, and Mute Members. Its role must be above unit roles.",
      ],
    ],
  },
  radio: {
    title: "Guide • Radio Procedure",
    fields: [
      [
        "Calling dispatch",
        "Lead with your callsign or “Dispatch,” then give one concise request. Follow-up traffic uses the unit's current call, stop, pursuit, and scene context.",
      ],
      [
        "Confidence",
        "Clear traffic executes immediately. Partial uncertainty receives a targeted confirmation. Low-confidence traffic receives a 10-9.",
      ],
      [
        "Channel control",
        "Brief mic taps are ignored. Routine overlaps are separated by user and queued in key-up order. Emergency traffic is repeatedly checked during the cut-in and immediately takes priority.",
      ],
      [
        "Hot mics",
        "Only prolonged, high-confidence unrelated audio is enforced. Confirmed hot mics receive two warnings within 15 minutes; a third is server-muted for about two minutes, then automatically restored. Valid traffic reduces prior warnings.",
      ],
      ["Playback", "Use `/playback seconds:15` to replay up to the last 30 seconds of captured radio traffic."],
    ],
  },
  calls: {
    title: "Guide • Calls and Priorities",
    fields: [
      [
        "Intake",
        "`/911` and ER:LC calls are AI-triaged. Matching incidents at the same location merge into one `YY-######` CAD incident with a caller count.",
      ],
      [
        "Priorities",
        "Priority 1: immediate life/officer-safety threat, Code 3. Priority 2: urgent/time-sensitive, Code 2. Priority 3: routine/delayed, Code 1.",
      ],
      [
        "Scene tracking",
        "Calls track primary, backup, traffic, and supervisor roles; requested and staged resources; unit recommendations; response ETAs; and a complete timestamped timeline.",
      ],
      [
        "Officer-created calls",
        "Natural reports such as show me on scene, out with, traffic stops, crashes, and investigations automatically create or strongly match a call. The reporting unit becomes primary and follow-up traffic remains linked by context.",
      ],
      [
        "BOLOs and warrants",
        "Radio traffic can create, update, or cancel person and vehicle BOLOs with uncertainty-safe plates. Traffic-stop plates and vehicle descriptions automatically check active BOLOs; matches raise officer safety and recommend backup without dispatching it unless policy enables that action. Formal warrants require an explicit instruction and an authorized registered rank.",
      ],
      [
        "Resource intent",
        "Backup is requested only from clear affirmative traffic. No additional units, disregard backup, I'm good, cancel additional units, and similar negatives override other unit keywords.",
      ],
      ["Code 4", "When an attached unit calls Code 4, the call closes and every attached unit returns to 10-8."],
    ],
  },
  panic: {
    title: "Guide • Officer Panic",
    fields: [
      [
        "Recognized traffic",
        "10-33, panic activation, officer down/needs help, taking fire, active gunfire, shots fired, and equivalent natural language.",
      ],
      [
        "Response",
        "Dispatch takes the air, marks the unit emergency/Code 3, queries the live ER:LC player location, posts a mass-panic alert, and broadcasts all available units Code 3.",
      ],
      [
        "Location fallback",
        "Exact Roblox username is matched first, then callsign. If live lookup fails, dispatch uses the last known location or asks the unit to advise.",
      ],
    ],
  },
  codes: {
    title: "Guide • Radio Codes",
    fields: [
      [
        "Core status",
        "10-4 affirmative • 10-6 busy • 10-7 out of service • 10-8 in service • 10-9 repeat • 10-17 en route • 10-20 location • 10-23 on scene • 10-33 help quick",
      ],
      [
        "Common incidents",
        "10-43 chase • 10-50 collision • 10-51 wrecker • 10-52 ambulance • 10-61 traffic stop • 10-65 armed robbery • 10-80 domestic • 10-82 person with gun",
      ],
      ["Response codes", "Code 1 routine • Code 2 urgent • Code 3 emergency • Code 4 secure/close assigned scene"],
      ["Full set", "Configured codes cover 10-1 through 10-99, 10-105 through 10-108, Signal 11, and Codes 1–4."],
    ],
  },
  commands: {
    title: "Guide • Commands",
    fields: [
      [
        "Dispatch and units",
        "`/dispatch start|stop|status` • `/unit register|unregister|list|info|status|response|location`",
      ],
      ["Calls", "`/911` • `/call list|info|status|scene|response|resource|note|close`"],
      ["CAD", "`/cad heatmap|shift|reset-shift|timeline|replay|recommend` • `/playback [seconds]`"],
      ["Help", "`/guide` or `/guide topic:<topic>`"],
    ],
  },
  cad: {
    title: "Guide • CAD Intelligence",
    fields: [
      [
        "Recommendations",
        "`/cad recommend call_id:<id>` refreshes the three closest available units and estimated response times without auto-assigning them.",
      ],
      [
        "Timeline",
        "`/cad timeline call_id:<id>` shows creation, assignments, response/scene changes, safety upgrades, resources, status checks, and closure.",
      ],
      [
        "Incident replay",
        "`/cad replay call_id:<id>` presents the configured number of incident events as a chronological after-action record.",
      ],
      [
        "Watchdog",
        "Attached calls with no update for 15 minutes receive a status check, a second check two minutes later, then a supervisor notification.",
      ],
      [
        "Reporting",
        "`/cad heatmap` shows incident concentrations. `/cad shift` reports calls, Priority 1 volume, response time, busiest unit, and longest call.",
      ],
    ],
  },
  troubleshooting: {
    title: "Guide • Troubleshooting",
    fields: [
      [
        "No voice reply",
        "Confirm the unit is registered, dispatch is connected, and the unit is not server-muted. Check `/dispatch status`.",
      ],
      ["False activations", "Raise `VOICE_RMS_THRESHOLD` gradually and use push-to-talk where possible."],
      [
        "Panic location unavailable",
        "Register the exact Roblox username and confirm ER:LC connectivity. Registered unit locations refresh from the game approximately every ten seconds.",
      ],
      ["Commands outdated", "Run `npm run deploy-commands`, then restart `npm run dev`."],
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
