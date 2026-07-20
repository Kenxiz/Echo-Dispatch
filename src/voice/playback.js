import { Readable } from "node:stream";
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  createAudioPlayer,
  createAudioResource,
} from "@discordjs/voice";
function pcm24kMonoTo48kStereo(input) {
  const sampleCount = Math.floor(input.length / 2);
  const output = Buffer.allocUnsafe(sampleCount * 8);
  for (let index = 0; index < sampleCount; index++) {
    const sample = input.readInt16LE(index * 2);
    const offset = index * 8;
    output.writeInt16LE(sample, offset);
    output.writeInt16LE(sample, offset + 2);
    output.writeInt16LE(sample, offset + 4);
    output.writeInt16LE(sample, offset + 6);
  }
  return output;
}
export function addPlaybackPreroll(input, preRollMs = 180, sampleRate = 24_000) {
  const silence = Buffer.alloc(Math.floor((sampleRate * Math.max(0, preRollMs)) / 1000) * 2);
  return Buffer.concat([silence, input]);
}
export class RadioPlayback {
  player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  queue = [];
  playing = false;
  constructor(preRollMs = 180) {
    this.preRollMs = Math.max(0, Math.min(500, preRollMs));
  }
  setConnection(connection) {
    connection.subscribe(this.player);
  }
  play(pcm24kMono, priority = false) {
    return new Promise((resolve, reject) => {
      const level = typeof priority === "number" ? priority : priority ? 1 : 0;
      const item = { audio: pcm24kMono, resolve, reject, level };
      if (level > 0) {
        const index = this.queue.findIndex((queued) => queued.level < level);
        if (index === -1) this.queue.push(item);
        else this.queue.splice(index, 0, item);
        if (this.playing) this.player.stop(true);
      } else {
        this.queue.push(item);
      }
      this.pump();
    });
  }
  interrupt() {
    if (this.playing) this.player.stop(true);
  }
  stop() {
    this.player.stop(true);
    for (const item of this.queue.splice(0)) item.resolve();
  }
  pump() {
    if (this.playing) return;
    const item = this.queue.shift();
    if (!item) return;
    this.playing = true;
    void this.playNow(item.audio)
      .then(item.resolve, item.reject)
      .finally(() => {
        this.playing = false;
        this.pump();
      });
  }
  playNow(pcm24kMono) {
    if (pcm24kMono.length === 0) return Promise.resolve();
    const raw = pcm24kMonoTo48kStereo(addPlaybackPreroll(pcm24kMono, this.preRollMs));
    const resource = createAudioResource(Readable.from(raw), { inputType: StreamType.Raw });
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.player.off(AudioPlayerStatus.Idle, onIdle);
        this.player.off("error", onError);
      };
      const onIdle = () => {
        cleanup();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      this.player.once(AudioPlayerStatus.Idle, onIdle);
      this.player.once("error", onError);
      this.player.play(resource);
    });
  }
}
