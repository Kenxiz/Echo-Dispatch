import { createPublicKey, verify } from "node:crypto";
import { createServer } from "node:http";
const ERLC_PUBLIC_KEY = createPublicKey({
    key: Buffer.from("MCowBQYDK2VwAyEAjSICb9pp0kHizGQtdG8ySWsDChfGqi+gyFCttigBNOA=", "base64"),
    format: "der",
    type: "spki",
});
export class ErlcWebhookServer {
    port;
    adapter;
    onError;
    server = null;
    constructor(port, adapter, onError) {
        this.port = port;
        this.adapter = adapter;
        this.onError = onError;
    }
    start() {
        if (this.server)
            return;
        this.server = createServer((request, response) => { void this.handle(request, response); });
        this.server.on("error", (error) => { void this.onError(error); });
        this.server.listen(this.port);
    }
    stop() {
        this.server?.close();
        this.server = null;
    }
    async handle(request, response) {
        try {
            if (request.method !== "POST" || request.url?.split("?")[0] !== "/erlc/webhook")
                return this.reply(response, 404, "not found");
            const timestamp = request.headers["x-signature-timestamp"];
            const signatureHex = request.headers["x-signature-ed25519"];
            if (typeof timestamp !== "string" || !/^\d+$/.test(timestamp) || typeof signatureHex !== "string" || !/^[0-9a-f]+$/i.test(signatureHex))
                return this.reply(response, 401, "invalid signature headers");
            if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300)
                return this.reply(response, 401, "stale signature");
            const raw = await this.readBody(request);
            const message = Buffer.concat([Buffer.from(timestamp, "utf8"), raw]);
            if (!verify(null, message, ERLC_PUBLIC_KEY, Buffer.from(signatureHex, "hex")))
                return this.reply(response, 401, "invalid signature");
            const payload = JSON.parse(raw.toString("utf8"));
            const emergency = findEmergencyCall(payload);
            if (emergency)
                await this.adapter.ingest(emergency);
            return this.reply(response, 204, "");
        }
        catch (error) {
            await this.onError(error instanceof Error ? error : new Error("Webhook processing failed."));
            return this.reply(response, 400, "bad request");
        }
    }
    async readBody(request) {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
            const buffer = Buffer.from(chunk);
            size += buffer.length;
            if (size > 1_000_000)
                throw new Error("Webhook body exceeds 1 MB.");
            chunks.push(buffer);
        }
        return Buffer.concat(chunks);
    }
    reply(response, status, body) {
        response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
        response.end(body);
    }
}
function findEmergencyCall(payload) {
    const queue = [payload];
    while (queue.length) {
        const value = queue.shift();
        if (!value || typeof value !== "object")
            continue;
        if (Array.isArray(value)) {
            queue.push(...value);
            continue;
        }
        const record = value;
        if (typeof record.CallNumber === "number" && typeof record.StartedAt === "number" && typeof record.Description === "string" && typeof record.PositionDescriptor === "string") {
            return record;
        }
        queue.push(...Object.values(record));
    }
    return null;
}
