export class ErlcApiError extends Error {
    status;
    retryAfterMs;
    code;
    constructor(status, message, retryAfterMs, code) {
        super(`ER:LC API ${status}: ${message}`);
        this.status = status;
        this.retryAfterMs = retryAfterMs;
        this.code = code;
        this.name = "ErlcApiError";
    }
}
export class ErlcClient {
    config;
    blockedError = null;
    latestPlayers = null;
    constructor(config) {
        this.config = config;
    }
    async fetchServerInfo(options = {}) {
        if (this.blockedError)
            throw this.blockedError;
        const url = new URL("/v2/server", this.config.ERLC_API_BASE_URL);
        if (options.players)
            url.searchParams.set("Players", "true");
        if (options.joinLogs)
            url.searchParams.set("JoinLogs", "true");
        if (options.emergencyCalls)
            url.searchParams.set("EmergencyCalls", "true");
        const response = await fetch(url, {
            headers: { "server-key": this.config.ERLC_SERVER_KEY },
            signal: AbortSignal.timeout(10_000),
        });
        const body = await response.text();
        if (!response.ok) {
            let detail = body;
            let code;
            try {
                const parsed = JSON.parse(body);
                detail = parsed.message ?? parsed.error ?? body;
                code = Number.isInteger(parsed.code) ? parsed.code : undefined;
            }
            catch { /* use body */ }
            if (code === 2001 || code === 2002) {
                detail = `${detail}. Generate a new key in ER:LC Settings > ER:LC API, replace ERLC_SERVER_KEY in .env, and restart Echo Dispatch.`;
            }
            const retryAfter = Number(response.headers.get("retry-after"));
            const error = new ErlcApiError(response.status, detail.slice(0, 500), Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined, code);
            // ER:LC warns that repeatedly sending an invalid key can IP-ban the host.
            if (response.status === 403)
                this.blockedError = error;
            throw error;
        }
        const parsed = JSON.parse(body);
        if (Array.isArray(parsed.Players))
            this.latestPlayers = parsed.Players;
        return parsed;
    }
    async locateUnit(unit) {
        let players;
        let stale = false;
        try {
            players = (await this.fetchServerInfo({ players: true })).Players ?? [];
        }
        catch (error) {
            if (!this.latestPlayers)
                throw error;
            players = this.latestPlayers;
            stale = true;
        }
        const player = findErlcPlayer(players, unit);
        if (!player)
            return { found: false, location: null, stale };
        return { found: true, location: formatErlcLocation(player.Location), player, stale };
    }
}

export function findErlcPlayer(players, unit) {
    const username = unit.robloxUsername?.trim().toLowerCase();
    const callsign = compact(unit.callsign);
    return players.find((player) => username && erlcPlayerName(player.Player).toLowerCase() === username)
        ?? players.find((player) => callsign && compact(player.Callsign) === callsign);
}

export function erlcPlayerName(value = "") {
    return value.replace(/:\d+$/, "").trim();
}

export function formatErlcLocation(location) {
    if (!location)
        return null;
    const street = [location.BuildingNumber, location.StreetName].filter(Boolean).join(" ").trim();
    const postal = location.PostalCode ? `postal ${location.PostalCode}` : "";
    if (street && postal)
        return `${street}, ${postal}`;
    if (street || postal)
        return street || postal;
    if (Number.isFinite(location.LocationX) && Number.isFinite(location.LocationZ))
        return `coordinates ${Math.round(location.LocationX)}, ${Math.round(location.LocationZ)}`;
    return null;
}

function compact(value = "") {
    return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}
