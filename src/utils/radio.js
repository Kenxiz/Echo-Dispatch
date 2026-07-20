const phonetics = {
    A: "Adam", B: "Boy", C: "Charles", D: "David", E: "Edward", F: "Frank",
    G: "George", H: "Henry", I: "Ida", J: "John", K: "King", L: "Lincoln",
    M: "Mary", N: "Nora", O: "Ocean", P: "Paul", Q: "Queen", R: "Robert",
    S: "Sam", T: "Tom", U: "Union", V: "Victor", W: "William", X: "X-ray",
    Y: "Young", Z: "Zebra",
};
export function normalizeCallsign(value) {
    return value.toUpperCase().replace(/\s+/g, "").replace(/[–—]/g, "-");
}
export function speakCallsign(value) {
    return (normalizeCallsign(value).match(/[A-Z]|\d+/g) ?? [])
        .map((token) => phonetics[token] ?? token).join("-");
}
export function speakPlate(value) {
    return value.toUpperCase().split("").filter((char) => /[A-Z0-9]/.test(char))
        .map((char) => phonetics[char] ?? char).join("-");
}
export function detectRadioCode(incident) {
    const text = incident.toLowerCase();
    const mappings = [
        ["10-50", ["mva", "motor vehicle accident", "collision", "crash", "wreck"]],
        ["10-65", ["armed robbery"]], ["10-62", ["breaking and entering", "burglary"]],
        ["10-80", ["domestic disturbance", "domestic"]], ["10-60", ["suspicious"]],
        ["10-40", ["fight"]], ["10-38", ["assault"]], ["10-54", ["hit and run"]],
        ["10-55", ["intoxicated driver", "dui"]], ["10-82", ["person with a gun", "subject with gun"]],
        ["10-94", ["gunshot wound", "gsw"]], ["10-45", ["bomb threat"]],
        ["10-46", ["bank alarm"]], ["10-44", ["riot"]], ["10-35", ["vandalism"]],
        ["10-36", ["larceny", "theft"]], ["10-53", ["roadway blocked", "road blocked"]],
        ["10-93", ["aircraft crash"]], ["10-88", ["structure fire", "building fire"]],
        ["10-90", ["alarm"]],
    ];
    for (const [code, aliases] of mappings) {
        if (text.includes(code.toLowerCase()) || aliases.some((alias) => text.includes(alias))) return code;
    }
    return null;
}
