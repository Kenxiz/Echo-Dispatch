import { Readable } from "node:stream";
import { AudioPlayerStatus, NoSubscriberBehavior, StreamType, createAudioPlayer, createAudioResource, } from "@discordjs/voice";
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
export class RadioPlayback {
    player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    queue = [];
    playing = false;
    setConnection(connection) {
        connection.subscribe(this.player);
    }
    play(pcm24kMono, priority = false) {
        return new Promise((resolve, reject) => {
            const item = { audio: pcm24kMono, resolve, reject };
            if (priority) {
                this.queue.unshift(item);
                if (this.playing)
                    this.player.stop(true);
            }
            else {
                this.queue.push(item);
            }
            this.pump();
        });
    }
    stop() {
        this.player.stop(true);
        for (const item of this.queue.splice(0))
            item.resolve();
    }
    pump() {
        if (this.playing)
            return;
        const item = this.queue.shift();
        if (!item)
            return;
        this.playing = true;
        void this.playNow(item.audio).then(item.resolve, item.reject).finally(() => {
            this.playing = false;
            this.pump();
        });
    }
    playNow(pcm24kMono) {
        if (pcm24kMono.length === 0)
            return Promise.resolve();
        const raw = pcm24kMonoTo48kStereo(pcm24kMono);
        const resource = createAudioResource(Readable.from(raw), { inputType: StreamType.Raw });
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                this.player.off(AudioPlayerStatus.Idle, onIdle);
                this.player.off("error", onError);
            };
            const onIdle = () => { cleanup(); resolve(); };
            const onError = (error) => { cleanup(); reject(error); };
            this.player.once(AudioPlayerStatus.Idle, onIdle);
            this.player.once("error", onError);
            this.player.play(resource);
        });
    }
}
