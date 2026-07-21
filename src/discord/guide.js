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
        "10-99, panic activation, officer down/needs help, taking fire, active gunfire, shots fired/10-13, and equivalent natural language.",
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
        "10-0 through 10-29",
        "10-0 disappeared • 10-1 frequency change • 10-2 negative • 10-3 stop transmitting • 10-4 acknowledged • 10-5 relay • 10-6 busy • 10-7 out of service • 10-8 in service • 10-9 repeat • 10-10 fight • 10-11 traffic stop • 10-12 standby • 10-13 shots fired • 10-15 custody transport • 10-16 stolen vehicle • 10-17 suspicious person • 10-18 disturbance • 10-19 ride along • 10-20 location • 10-21 Discord • 10-22 disregard • 10-23 on scene • 10-25 contact • 10-26 ETA • 10-27 license • 10-28 plate • 10-29 warrant",
      ],
      [
        "10-30 through 10-67",
        "10-30 wanted person • 10-31 armed person • 10-32 additional unit • 10-34 assignment complete/no report • 10-35 not wanted • 10-36 under control • 10-37 last assignment complete • 10-38 suspicious vehicle • 10-39 police officer • 10-41/42 begin/end tour • 10-43 information • 10-44 park/walk/talk • 10-45 street race • 10-46 EDP • 10-50 accident • 10-51 tow • 10-52 EMS • 10-53 Fire • 10-54 hit and run • 10-55 intoxicated driver • 10-56 intoxicated pedestrian • 10-60 animal attack • 10-61 larceny • 10-62 kidnapping • 10-63 radio check • 10-64 assault • 10-65 armed robbery • 10-66 reckless driver • 10-67 fire",
      ],
      [
        "10-70 through 11-44",
        "10-70 foot pursuit • 10-71 supervisor • 10-73 advise status • 10-76 in route • 10-80 vehicle pursuit • 10-85 delayed • 10-86 traffic for me • 10-88 district assistance • 10-89 major assistance • 10-90 bank alarm • 10-91 unnecessary radio use • 10-93 warning • 10-94 aircraft emergency • 10-97 prisoner transport • 10-99 officer distress • 11-44 person deceased",
      ],
      [
        "Signals and codes",
        "Signal 11 running radar • Signal 13 clear for crime broadcast • Signal 100 emergency traffic only • Code 4 scene handled • Code 5 felony/high-risk stop • Code 6 in the area. Code 1/2/3 remain the configured routine, urgent, and emergency response modes.",
      ],
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
