import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";

export const RADIO_CODE_CATEGORIES = [
  "UNIT_STATUS",
  "INCIDENT",
  "REQUEST",
  "OFFICER_SAFETY",
  "INFORMATION",
  "RESPONSE",
  "SCENE_STATUS",
];
export const RADIO_CODE_ACTIONS = [
  "SET_UNIT_STATUS",
  "CREATE_OR_UPDATE_CALL",
  "REQUEST_RESOURCE",
  "ACTIVATE_EMERGENCY",
  "REQUEST_INFORMATION",
  "SET_RESPONSE_MODE",
  "RESOLVE_SCENE",
  "SET_UNIT_ACTIVITY",
  "UPGRADE_FELONY_STOP",
];

const codeDefinitionSchema = z.object({
  code: z.string().min(1).max(30),
  aliases: z.array(z.string().min(1).max(100)).default([]),
  spokenForms: z.array(z.string().min(1).max(100)).default([]),
  meaning: z.string().min(1).max(200),
  category: z.enum(RADIO_CODE_CATEGORIES),
  action: z.enum(RADIO_CODE_ACTIONS).nullable().default(null),
  actionValue: z.string().max(100).nullable().default(null),
  priority: z.number().int().min(1).max(3).nullable().default(null),
  responseCode: z.number().int().min(1).max(3).nullable().default(null),
  requiresCall: z.boolean().default(false),
  createsCall: z.boolean().default(false),
  acknowledgementTemplates: z.array(z.string().max(250)).default([]),
});

const STATUS_ACTIONS = {
  "10-6": "BUSY",
  "10-7": "OUT_OF_SERVICE",
  "10-8": "AVAILABLE",
  "10-11": "ON_DUTY",
  "10-12": "STANDBY",
  "10-17": "EN_ROUTE",
  "10-23": "ON_SCENE",
  "10-24": "ASSIGNMENT_COMPLETE",
  "10-41": "ON_DUTY",
  "10-42": "OFF_DUTY",
  "10-43": "PURSUIT",
  "10-48": "DETAINING",
  "10-58": "DIRECTING_TRAFFIC",
  "10-59": "ESCORT",
  "10-72": "PRISONER_IN_CUSTODY",
  "10-81": "AT_STATION",
  "10-92": "RADAR",
  "10-96": "MEAL_BREAK",
  "10-97": "AT_HOSPITAL",
  "10-106": "COURT",
  "10-107": "VEHICLE_MAINTENANCE",
  "10-108": "BUILDING_CHECK",
};
const RESOURCE_ACTIONS = {
  "10-32": "LAW_ENFORCEMENT",
  "10-51": "WRECKER",
  "10-52": "EMS",
  "10-66": "CORONER",
  "10-77": "FIRE",
};
const INFORMATION_ACTIONS = {
  "10-20": "LOCATION",
  "10-26": "ETA",
  "10-27": "LICENSE",
  "10-28": "REGISTRATION",
  "10-29": "WARRANT_RECORD",
};
const INCIDENT_CODES = new Set([
  "10-35",
  "10-36",
  "10-37",
  "10-38",
  "10-39",
  "10-40",
  "10-43",
  "10-44",
  "10-45",
  "10-46",
  "10-49",
  "10-50",
  "10-53",
  "10-54",
  "10-55",
  "10-56",
  "10-60",
  "10-61",
  "10-62",
  "10-64",
  "10-65",
  "10-67",
  "10-68",
  "10-70",
  "10-73",
  "10-74",
  "10-75",
  "10-76",
  "10-79",
  "10-80",
  "10-82",
  "10-85",
  "10-88",
  "10-89",
  "10-90",
  "10-91",
  "10-93",
  "10-94",
]);
const PRIORITY_ONE_CODES = new Set([
  "10-33",
  "10-43",
  "10-44",
  "10-45",
  "10-64",
  "10-65",
  "10-74",
  "10-82",
  "10-93",
  "10-94",
]);

export class RadioCodebook {
  constructor(filePath, source) {
    this.filePath = filePath;
    this.initialSource = structuredClone(source);
    this.replace(source);
  }

  static async load(filePath) {
    return new RadioCodebook(filePath, JSON.parse(await readFile(filePath, "utf8")));
  }

  replace(source) {
    this.sourceShape = Array.isArray(source) ? "ARRAY" : "OBJECT";
    const entries = Array.isArray(source)
      ? source
      : Object.entries(source).map(([code, value]) => ({ code, ...value }));
    this.definitions = entries.map(enrichDefinition).map((entry) => codeDefinitionSchema.parse(entry));
    this.byCode = new Map(this.definitions.map((entry) => [canonicalCode(entry.code), entry]));
    return this.definitions;
  }

  list() {
    return structuredClone(this.definitions);
  }
  get(code) {
    return structuredClone(this.byCode.get(canonicalCode(code)) ?? null);
  }

  detect(text) {
    const source = normalizeSearchText(text);
    const matches = [];
    const occupied = [];
    const definitions = this.definitions
      .flatMap((definition) => codeForms(definition).map((form) => ({ definition, form: normalizeSearchText(form) })))
      .sort((a, b) => b.form.length - a.form.length);
    for (const candidate of definitions) {
      if (!candidate.form) continue;
      const pattern = new RegExp(`(?:^|\\b)${escapeRegex(candidate.form).replaceAll("\\ ", "[\\s-]*")}(?=$|\\b)`, "gi");
      for (const found of source.matchAll(pattern)) {
        const start = found.index + found[0].length - found[0].trimStart().length;
        const end = start + found[0].trim().length;
        if (occupied.some(([left, right]) => start < right && end > left)) continue;
        occupied.push([start, end]);
        matches.push({
          code: candidate.definition.code,
          definition: structuredClone(candidate.definition),
          spokenForm: found[0].trim(),
          start,
          end,
          confidence: explicitCodeForm(candidate.form, candidate.definition.code) ? 1 : 0.9,
        });
      }
    }
    return matches.sort((a, b) => a.start - b.start);
  }

  validate() {
    const issues = [];
    const codes = new Map();
    const forms = new Map();
    for (const definition of this.definitions) {
      const key = canonicalCode(definition.code);
      if (codes.has(key))
        issues.push({
          severity: "ERROR",
          type: "DUPLICATE_CODE",
          detail: `${definition.code} duplicates ${codes.get(key)}.`,
        });
      codes.set(key, definition.code);
      if (!definition.meaning.trim())
        issues.push({ severity: "ERROR", type: "MISSING_MEANING", detail: `${definition.code} has no meaning.` });
      if (definition.action && !RADIO_CODE_ACTIONS.includes(definition.action))
        issues.push({
          severity: "ERROR",
          type: "INVALID_ACTION",
          detail: `${definition.code} uses invalid action ${definition.action}.`,
        });
      if (definition.category === "INCIDENT" && !definition.priority)
        issues.push({
          severity: "ERROR",
          type: "MISSING_PRIORITY",
          detail: `${definition.code} is an incident without a priority fallback.`,
        });
      if (definition.category === "UNIT_STATUS" && (!definition.actionValue || definition.action !== "SET_UNIT_STATUS"))
        issues.push({
          severity: "ERROR",
          type: "INVALID_STATUS",
          detail: `${definition.code} has no valid unit-status mapping.`,
        });
      for (const form of [...definition.aliases, ...definition.spokenForms]) {
        const normalized = normalizeSearchText(form);
        const existing = forms.get(normalized);
        if (existing && existing !== definition.code)
          issues.push({
            severity: "ERROR",
            type: "CONFLICTING_FORM",
            detail: `“${form}” is shared by ${existing} and ${definition.code}.`,
          });
        else forms.set(normalized, definition.code);
      }
    }
    return issues;
  }

  async add(input) {
    const definition = codeDefinitionSchema.parse(enrichDefinition(input));
    if (this.byCode.has(canonicalCode(definition.code))) throw new Error(`${definition.code} already exists.`);
    this.definitions.push(definition);
    await this.persist();
    return definition;
  }

  async edit(code, changes) {
    const index = this.definitions.findIndex((item) => canonicalCode(item.code) === canonicalCode(code));
    if (index < 0) throw new Error(`${code} was not found.`);
    const updated = codeDefinitionSchema.parse(
      enrichDefinition({ ...this.definitions[index], ...changes, code: changes.code ?? this.definitions[index].code }),
    );
    this.definitions[index] = updated;
    await this.persist();
    return updated;
  }

  async remove(code) {
    const index = this.definitions.findIndex((item) => canonicalCode(item.code) === canonicalCode(code));
    if (index < 0) throw new Error(`${code} was not found.`);
    const [removed] = this.definitions.splice(index, 1);
    await this.persist();
    return removed;
  }

  async reset() {
    this.replace(this.initialSource);
    await this.persist();
    return this.list();
  }
  async import(source) {
    this.replace(source);
    const issues = this.validate();
    if (issues.some((issue) => issue.severity === "ERROR")) {
      this.replace(this.initialSource);
      throw new Error(`Codebook import rejected: ${issues[0].detail}`);
    }
    await this.persist();
    return this.list();
  }
  export() {
    return Object.fromEntries(this.definitions.map((definition) => [definition.code, withoutCode(definition)]));
  }

  async persist() {
    this.replace(this.definitions);
    await writeFile(this.filePath, `${JSON.stringify(this.export(), null, 2)}\n`, "utf8");
  }
}

export function enrichDefinition(input) {
  const code = canonicalCode(input.code);
  const inferred = inferSemantics(code, input.meaning ?? "");
  return {
    code,
    aliases: input.aliases ?? [],
    spokenForms: [...new Set([...(input.spokenForms ?? []), ...generatedSpokenForms(code)])],
    meaning: input.meaning,
    category: input.category ?? inferred.category,
    action: input.action ?? inferred.action,
    actionValue: input.actionValue ?? inferred.actionValue,
    priority: input.priority ?? inferred.priority,
    responseCode: input.responseCode ?? inferred.responseCode,
    requiresCall: input.requiresCall ?? inferred.requiresCall,
    createsCall: input.createsCall ?? inferred.createsCall,
    acknowledgementTemplates: input.acknowledgementTemplates ?? [],
  };
}

function inferSemantics(code) {
  if (STATUS_ACTIONS[code]) return semantics("UNIT_STATUS", "SET_UNIT_STATUS", STATUS_ACTIONS[code]);
  if (RESOURCE_ACTIONS[code])
    return semantics("REQUEST", "REQUEST_RESOURCE", RESOURCE_ACTIONS[code], 2, 2, true, false);
  if (INFORMATION_ACTIONS[code]) return semantics("INFORMATION", "REQUEST_INFORMATION", INFORMATION_ACTIONS[code]);
  if (code === "10-33") return semantics("OFFICER_SAFETY", "ACTIVATE_EMERGENCY", "OFFICER_ASSIST", 1, 3, false, true);
  if (code === "10-71") return semantics("INFORMATION", "SET_UNIT_ACTIVITY", "IMPROPER_RADIO_USE");
  if (code === "Code 1" || code === "Code 2" || code === "Code 3")
    return semantics("RESPONSE", "SET_RESPONSE_MODE", code.toUpperCase().replace(" ", "_"));
  if (code === "Code 4") return semantics("SCENE_STATUS", "RESOLVE_SCENE", "CODE_4", null, null, true);
  if (code === "Code 5") return semantics("OFFICER_SAFETY", "UPGRADE_FELONY_STOP", "FELONY_STOP", 1, 3, true, true);
  if (INCIDENT_CODES.has(code))
    return semantics(
      PRIORITY_ONE_CODES.has(code) ? "OFFICER_SAFETY" : "INCIDENT",
      "CREATE_OR_UPDATE_CALL",
      null,
      PRIORITY_ONE_CODES.has(code) ? 1 : 2,
      PRIORITY_ONE_CODES.has(code) ? 3 : 2,
      false,
      true,
    );
  return semantics("INFORMATION", null, null);
}

function semantics(
  category,
  action,
  actionValue,
  priority = null,
  responseCode = null,
  requiresCall = false,
  createsCall = false,
) {
  return { category, action, actionValue, priority, responseCode, requiresCall, createsCall };
}
function canonicalCode(value) {
  const text = String(value ?? "").trim();
  const ten = text.match(/^10[\s-]?(\d{1,3})$/i);
  if (ten) return `10-${Number(ten[1])}`;
  const code = text.match(/^code[\s-]?(\d+)$/i);
  if (code) return `Code ${Number(code[1])}`;
  const signal = text.match(/^signal[\s-]?(\d+)$/i);
  if (signal) return `Signal ${Number(signal[1])}`;
  return text;
}
function generatedSpokenForms(code) {
  const ten = code.match(/^10-(\d+)$/);
  if (ten) {
    const suffix = ten[1];
    return [
      `10-${suffix}`,
      `10 ${suffix}`,
      `10${suffix}`,
      `ten ${numberWords(Number(suffix))}`,
      `ten ${suffix.split("").map(digitWord).join(" ")}`,
      `one zero ${suffix.split("").map(digitWord).join(" ")}`,
    ];
  }
  return [code, code.toLowerCase()];
}
function codeForms(definition) {
  return [...new Set([definition.code, ...definition.spokenForms, ...definition.aliases])];
}
function explicitCodeForm(form, code) {
  return generatedSpokenForms(code).map(normalizeSearchText).includes(form);
}
function normalizeSearchText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[‐‑‒–—-]/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function numberWords(number) {
  const small = [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
  ];
  const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  if (number < 20) return small[number];
  if (number < 100) return `${tens[Math.floor(number / 10)]}${number % 10 ? ` ${small[number % 10]}` : ""}`;
  return `${small[Math.floor(number / 100)]} hundred${number % 100 ? ` ${numberWords(number % 100)}` : ""}`;
}
function digitWord(value) {
  return ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"][Number(value)];
}
function withoutCode(definition) {
  const { code: _code, ...value } = definition;
  return value;
}
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
