export function downsample48kMono(input) {
  const sampleCount = Math.floor(input.length / 2);
  const output = Buffer.alloc(Math.floor(sampleCount / 2) * 2);
  for (let source = 0, target = 0; source + 1 < sampleCount; source += 2, target += 1) {
    const average = Math.round((input.readInt16LE(source * 2) + input.readInt16LE((source + 1) * 2)) / 2);
    output.writeInt16LE(average, target * 2);
  }
  return output;
}

export function createBusyTone(sampleRate = 24_000) {
  const segments = [120, 90, 120, 120];
  const samples = segments.reduce((sum, milliseconds) => sum + Math.floor((sampleRate * milliseconds) / 1000), 0);
  const output = Buffer.alloc(samples * 2);
  let offset = 0;
  segments.forEach((milliseconds, index) => {
    const count = Math.floor((sampleRate * milliseconds) / 1000);
    const audible = index % 2 === 0;
    for (let sample = 0; sample < count; sample += 1) {
      const value = audible ? Math.round(Math.sin((2 * Math.PI * 900 * sample) / sampleRate) * 6500) : 0;
      output.writeInt16LE(value, offset);
      offset += 2;
    }
  });
  return output;
}
