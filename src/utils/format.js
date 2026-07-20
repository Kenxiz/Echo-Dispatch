export function joinWords(values) {
  if (values.length < 2) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

export function describeActionResult(value) {
  if (!value) return "Completed.";
  if (value.id) return `${value.id}${value.status ? ` ${value.status}` : ""}`;
  return value.callsign ?? "Completed.";
}

export function formatResource(value) {
  return (
    { EMS: "EMS", FIRE: "Fire", DOT: "DOT", K9: "K-9", SWAT: "SWAT" }[value] ??
    value
      .replaceAll("_", " ")
      .toLowerCase()
      .replace(/\b\w/g, (letter) => letter.toUpperCase())
  );
}

export function numberWord(value) {
  return { 1: "One", 2: "Two", 3: "Three", 4: "Four", 5: "Five" }[value] ?? String(value);
}

export function withIndefiniteArticle(value) {
  return `${/^[aeiou]/i.test(value) ? "an" : "a"} ${value}`;
}
