import { describe, expect, it } from "vitest";
import { buildCallAnnouncement } from "../src/ai/dispatcher-prompt.js";

describe("professional 911 announcement prompt", () => {
  it("requires a concise summary with fixed priority and response mode", () => {
    const prompt = buildCallAnnouncement({
      incident: "there are a lot of gun shots!",
      radioCode: null,
      location: "county jail",
      description: "there are just a bunch of gun shots coming from all around the place!",
      suspectInfo: null,
      vehicleInfo: null,
      weaponInfo: "it sounds like automatic rifles",
      injuryInfo: null,
      requestedResources: [],
      notes: [],
      priority: 1,
      responseMode: "CODE_3",
    });

    expect(prompt).toContain('Begin exactly: "All available units, standby for a Priority One."');
    expect(prompt).toContain('End exactly: "Units respond Code 3."');
    expect(prompt).toContain("Summarize and professionally rephrase the caller report");
    expect(prompt).toContain("Never quote it or read it word-for-word");
    expect(prompt).toContain("weapons, injuries, active hazards");
    expect(prompt).toContain("Do not invent facts");
    expect(prompt).toContain("Target 25-55 words");
  });
});
