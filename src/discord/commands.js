import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { CALL_STATUSES, RESOURCE_TYPES, RESPONSE_MODES, SCENE_STATUSES, UNIT_STATUSES } from "../types.js";
const statusChoices = UNIT_STATUSES.map((status) => ({ name: status.replaceAll("_", " "), value: status }));
const responseModeChoices = RESPONSE_MODES.map((status) => ({ name: status.replaceAll("_", " "), value: status }));
const callStatusChoices = CALL_STATUSES.filter((status) => status !== "CLOSED").map((status) => ({
  name: status.replaceAll("_", " "),
  value: status,
}));
const sceneStatusChoices = SCENE_STATUSES.map((status) => ({ name: status.replaceAll("_", " "), value: status }));
const resourceChoices = RESOURCE_TYPES.map((resource) => ({ name: resource.replaceAll("_", " "), value: resource }));
export const commandBuilders = [
  new SlashCommandBuilder()
    .setName("guide")
    .setDescription("Show the Echo Dispatch operating guide")
    .addStringOption((option) =>
      option
        .setName("topic")
        .setDescription("Guide topic")
        .addChoices(
          { name: "Quick Start", value: "quick-start" },
          { name: "Radio Procedure", value: "radio" },
          { name: "Calls and Priorities", value: "calls" },
          { name: "Officer Panic", value: "panic" },
          { name: "Radio Codes", value: "codes" },
          { name: "Commands", value: "commands" },
          { name: "CAD Intelligence", value: "cad" },
          { name: "Troubleshooting", value: "troubleshooting" },
        ),
    ),
  new SlashCommandBuilder()
    .setName("dispatch")
    .setDescription("Control Echo Dispatch")
    .addSubcommand((command) =>
      command.setName("start").setDescription("Join the configured radio channel and start dispatch"),
    )
    .addSubcommand((command) => command.setName("stop").setDescription("Stop dispatch and leave the radio channel"))
    .addSubcommand((command) => command.setName("status").setDescription("Show bot, voice, and ER:LC status")),
  new SlashCommandBuilder()
    .setName("unit")
    .setDescription("Register and manage units")
    .addSubcommand((command) =>
      command
        .setName("register")
        .setDescription("Register your active unit")
        .addStringOption((option) =>
          option
            .setName("callsign")
            .setDescription("Compact callsign, such as 1L-18")
            .setRequired(true)
            .setMaxLength(20),
        )
        .addStringOption((option) => option.setName("rank").setDescription("Rank").setRequired(true).setMaxLength(80))
        .addStringOption((option) =>
          option.setName("division").setDescription("Division").setRequired(true).setMaxLength(80),
        )
        .addStringOption((option) =>
          option.setName("roblox_username").setDescription("Optional Roblox username").setMaxLength(30),
        ),
    )
    .addSubcommand((command) => command.setName("unregister").setDescription("Deactivate your unit"))
    .addSubcommand((command) => command.setName("list").setDescription("List active units"))
    .addSubcommand((command) =>
      command
        .setName("info")
        .setDescription("Show unit information")
        .addStringOption((option) =>
          option.setName("callsign").setDescription("Callsign; defaults to your unit").setMaxLength(20),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName("status")
        .setDescription("Set your general unit status")
        .addStringOption((option) =>
          option
            .setName("status")
            .setDescription("Unit status")
            .setRequired(true)
            .addChoices(...statusChoices),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName("response")
        .setDescription("Set your response mode")
        .addStringOption((option) =>
          option
            .setName("mode")
            .setDescription("Code 1, Code 2, or Code 3")
            .setRequired(true)
            .addChoices(...responseModeChoices),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName("location")
        .setDescription("Set your current location")
        .addStringOption((option) =>
          option.setName("location").setDescription("Current location").setRequired(true).setMaxLength(200),
        ),
    ),
  new SlashCommandBuilder()
    .setName("911")
    .setDescription("Submit a 911 call")
    .addStringOption((option) =>
      option.setName("location").setDescription("Incident location").setRequired(true).setMaxLength(250),
    )
    .addStringOption((option) =>
      option.setName("incident").setDescription("Incident type").setRequired(true).setMaxLength(150),
    )
    .addStringOption((option) =>
      option.setName("description").setDescription("What is happening").setRequired(true).setMaxLength(1000),
    )
    .addStringOption((option) => option.setName("suspect").setDescription("Suspect information").setMaxLength(500))
    .addStringOption((option) => option.setName("vehicle").setDescription("Vehicle information").setMaxLength(500))
    .addStringOption((option) => option.setName("weapon").setDescription("Weapon information").setMaxLength(500))
    .addStringOption((option) => option.setName("injuries").setDescription("Injury information").setMaxLength(500)),
  new SlashCommandBuilder()
    .setName("playback")
    .setDescription("Replay recent radio traffic")
    .addIntegerOption((option) =>
      option.setName("seconds").setDescription("Seconds to replay, from 1 to 30").setMinValue(1).setMaxValue(30),
    ),
  new SlashCommandBuilder()
    .setName("cad")
    .setDescription("View CAD intelligence and shift reporting")
    .addSubcommand((command) => command.setName("heatmap").setDescription("Show the busiest incident locations"))
    .addSubcommand((command) => command.setName("shift").setDescription("Show current shift statistics"))
    .addSubcommand((command) => command.setName("reset-shift").setDescription("Start a new statistics period"))
    .addSubcommand((command) =>
      command
        .setName("timeline")
        .setDescription("Show an incident timeline")
        .addStringOption((option) => option.setName("call_id").setDescription("Call ID").setRequired(true)),
    )
    .addSubcommand((command) =>
      command
        .setName("replay")
        .setDescription("Replay an incident as a chronological after-action record")
        .addStringOption((option) => option.setName("call_id").setDescription("Call ID").setRequired(true)),
    )
    .addSubcommand((command) =>
      command
        .setName("recommend")
        .setDescription("Refresh recommended available units and ETAs")
        .addStringOption((option) => option.setName("call_id").setDescription("Call ID").setRequired(true)),
    ),
  new SlashCommandBuilder()
    .setName("call")
    .setDescription("View and manage dispatch calls")
    .addSubcommand((command) => command.setName("list").setDescription("List active calls"))
    .addSubcommand((command) =>
      command
        .setName("info")
        .setDescription("Show call information")
        .addStringOption((option) =>
          option.setName("call_id").setDescription("Call ID, such as 26-000143").setRequired(true),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName("status")
        .setDescription("Update an active call's operational status")
        .addStringOption((option) => option.setName("call_id").setDescription("Call ID").setRequired(true))
        .addStringOption((option) =>
          option
            .setName("status")
            .setDescription("Call status")
            .setRequired(true)
            .addChoices(...callStatusChoices),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName("scene")
        .setDescription("Update an active call's scene status")
        .addStringOption((option) => option.setName("call_id").setDescription("Call ID").setRequired(true))
        .addStringOption((option) =>
          option
            .setName("status")
            .setDescription("Scene status")
            .setRequired(true)
            .addChoices(...sceneStatusChoices),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName("response")
        .setDescription("Update an active call's response mode")
        .addStringOption((option) => option.setName("call_id").setDescription("Call ID").setRequired(true))
        .addStringOption((option) =>
          option
            .setName("mode")
            .setDescription("Code 1, Code 2, or Code 3")
            .setRequired(true)
            .addChoices(...responseModeChoices),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName("resource")
        .setDescription("Record a requested resource")
        .addStringOption((option) => option.setName("call_id").setDescription("Call ID").setRequired(true))
        .addStringOption((option) =>
          option
            .setName("resource")
            .setDescription("Requested resource")
            .setRequired(true)
            .addChoices(...resourceChoices),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName("note")
        .setDescription("Add an operational note to a call")
        .addStringOption((option) => option.setName("call_id").setDescription("Call ID").setRequired(true))
        .addStringOption((option) =>
          option.setName("note").setDescription("Factual call update").setRequired(true).setMaxLength(500),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName("close")
        .setDescription("Close an active call")
        .addStringOption((option) =>
          option.setName("call_id").setDescription("Call ID, such as 26-000143").setRequired(true),
        ),
    ),
  new SlashCommandBuilder()
    .setName("radiocode")
    .setDescription("Manage the active agency radio codebook")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((command) => command.setName("list").setDescription("List configured radio codes"))
    .addSubcommand((command) =>
      command
        .setName("view")
        .setDescription("View one radio-code definition")
        .addStringOption((option) => option.setName("code").setDescription("Code, such as 10-71").setRequired(true)),
    )
    .addSubcommand((command) =>
      command
        .setName("add")
        .setDescription("Add a radio code")
        .addStringOption((option) => option.setName("code").setDescription("Canonical code").setRequired(true))
        .addStringOption((option) =>
          option.setName("meaning").setDescription("Agency meaning").setRequired(true).setMaxLength(200),
        )
        .addStringOption((option) =>
          option
            .setName("category")
            .setDescription("Code category")
            .setRequired(true)
            .addChoices(
              ...[
                "UNIT_STATUS",
                "INCIDENT",
                "REQUEST",
                "OFFICER_SAFETY",
                "INFORMATION",
                "RESPONSE",
                "SCENE_STATUS",
              ].map((value) => ({ name: value.replaceAll("_", " "), value })),
            ),
        )
        .addStringOption((option) => option.setName("action").setDescription("Validated action name"))
        .addStringOption((option) => option.setName("action_value").setDescription("Status, resource, or action value"))
        .addStringOption((option) => option.setName("aliases").setDescription("Comma-separated aliases"))
        .addIntegerOption((option) =>
          option.setName("priority").setDescription("Incident fallback priority").setMinValue(1).setMaxValue(3),
        )
        .addIntegerOption((option) =>
          option.setName("response_code").setDescription("Fallback response code").setMinValue(1).setMaxValue(3),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName("edit")
        .setDescription("Edit a radio code")
        .addStringOption((option) => option.setName("code").setDescription("Existing code").setRequired(true))
        .addStringOption((option) => option.setName("meaning").setDescription("New meaning").setMaxLength(200))
        .addStringOption((option) =>
          option
            .setName("category")
            .setDescription("New category")
            .addChoices(
              ...[
                "UNIT_STATUS",
                "INCIDENT",
                "REQUEST",
                "OFFICER_SAFETY",
                "INFORMATION",
                "RESPONSE",
                "SCENE_STATUS",
              ].map((value) => ({ name: value.replaceAll("_", " "), value })),
            ),
        )
        .addStringOption((option) => option.setName("action").setDescription("Validated action name"))
        .addStringOption((option) => option.setName("action_value").setDescription("Status, resource, or action value"))
        .addStringOption((option) => option.setName("aliases").setDescription("Comma-separated aliases"))
        .addIntegerOption((option) =>
          option.setName("priority").setDescription("Incident fallback priority").setMinValue(1).setMaxValue(3),
        )
        .addIntegerOption((option) =>
          option.setName("response_code").setDescription("Fallback response code").setMinValue(1).setMaxValue(3),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName("remove")
        .setDescription("Remove a radio code")
        .addStringOption((option) => option.setName("code").setDescription("Code").setRequired(true)),
    )
    .addSubcommand((command) => command.setName("reset").setDescription("Reset codebook changes made since startup"))
    .addSubcommand((command) =>
      command
        .setName("import")
        .setDescription("Import and validate a JSON codebook")
        .addAttachmentOption((option) => option.setName("file").setDescription("JSON codebook").setRequired(true)),
    )
    .addSubcommand((command) => command.setName("export").setDescription("Export the active codebook"))
    .addSubcommand((command) =>
      command.setName("validate").setDescription("Validate codes, aliases, actions, and mappings"),
    ),
  new SlashCommandBuilder()
    .setName("debug")
    .setDescription("Inspect Echo Dispatch decisions and state")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((command) =>
      command
        .setName("transmission")
        .setDescription("Inspect a transmission; defaults to latest")
        .addStringOption((option) => option.setName("id").setDescription("Transmission ID")),
    )
    .addSubcommand((command) =>
      command
        .setName("unit")
        .setDescription("Inspect a registered unit")
        .addStringOption((option) => option.setName("callsign").setDescription("Callsign").setRequired(true)),
    )
    .addSubcommand((command) =>
      command
        .setName("call")
        .setDescription("Inspect a call")
        .addStringOption((option) => option.setName("call_id").setDescription("Call ID").setRequired(true)),
    )
    .addSubcommand((command) =>
      command
        .setName("code")
        .setDescription("Inspect code detection")
        .addStringOption((option) =>
          option.setName("traffic").setDescription("Code or spoken traffic").setRequired(true),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName("bolo-match")
        .setDescription("Score an observed vehicle against active BOLOs")
        .addStringOption((option) =>
          option.setName("observation").setDescription("Spoken plate or vehicle description").setRequired(true),
        ),
    )
    .addSubcommand((command) =>
      command.setName("radio-state").setDescription("Inspect queue, channel, and playback state"),
    ),
];
export const commandData = commandBuilders.map((command) => command.toJSON());
