const DEFAULT_AUTO_RESPONSE_RATE = 20;

function ensureRateStore(client) {
    if (!client.autoResponseRates) {
        client.autoResponseRates = new Map();
    }

    return client.autoResponseRates;
}

function getAutoResponseRate(client, channelId) {
    const rateOverrides = ensureRateStore(client);
    if (channelId && rateOverrides.has(channelId)) {
        return rateOverrides.get(channelId);
    }

    return DEFAULT_AUTO_RESPONSE_RATE;
}

function setAutoResponseRate(client, channelId, rate) {
    if (!channelId) {
        throw new Error('A channel ID is required to set an auto-response rate.');
    }

    const normalizedRate = Number.parseInt(rate, 10);
    if (!Number.isInteger(normalizedRate) || normalizedRate < 1 || normalizedRate > 100) {
        throw new Error('Auto-response rate must be an integer between 1 and 100.');
    }

    const rateOverrides = ensureRateStore(client);
    rateOverrides.set(channelId, normalizedRate);
    return normalizedRate;
}

function getMessagesUntilNextAutoResponse(client, channelId) {
    const rate = getAutoResponseRate(client, channelId);
    const count = client.messageCounts?.get(channelId) || 0;
    const remainder = count % rate;

    return remainder === 0 ? rate : rate - remainder;
}

function resetAutoResponseCount(client, channelId) {
    if (!client.messageCounts) {
        client.messageCounts = new Map();
    }

    if (channelId) {
        client.messageCounts.set(channelId, 0);
    }

    return client.messageCounts.get(channelId) || 0;
}

module.exports = {
    DEFAULT_AUTO_RESPONSE_RATE,
    getAutoResponseRate,
    setAutoResponseRate,
    getMessagesUntilNextAutoResponse,
    resetAutoResponseCount,
};
