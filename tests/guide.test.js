import { describe, expect, it } from "vitest";
import { commandData } from "../src/discord/commands.js";
import { buildGuideEmbed } from "../src/discord/guide.js";

describe("guide command", () => {
  it("registers focused operating-guide topics", () => {
    const guide = commandData.find((command) => command.name === "guide");
    expect(guide).toBeDefined();
    const choices = guide.options.find((option) => option.name === "topic").choices.map((choice) => choice.value);
    expect(choices).toEqual(
      expect.arrayContaining(["quick-start", "radio", "calls", "panic", "codes", "commands", "troubleshooting"]),
    );
  });

  it("documents panic location lookup and Code 4 behavior", () => {
    const panic = buildGuideEmbed("panic").toJSON();
    const calls = buildGuideEmbed("calls").toJSON();
    expect(JSON.stringify(panic)).toContain("live ER:LC player location");
    expect(JSON.stringify(calls)).toContain("every attached unit returns to 10-8");
  });
});
