'use strict';

// Short-term conversation memory: the rolling window of turns sent to the
// model as context, per channel.
//
// Distinct from the corpus (utils/corpus.js), which is permanent and is what
// the dialect and precedent are learned from. This is just "what was said in
// the last few minutes", and it is capped so a busy channel cannot grow one
// key without bound.
//
// The cap lived inline in three places — both reply paths and the ambient
// store — each with its own copy of the number. It lives here now.

const MEMORY_LIMIT = 20;

function readTurns(client, channelId) {
    return client.memory?.get(channelId) || [];
}

// Writes the window back, trimmed to the cap.
//
// `client.memory` is a PersistentMap (utils/db.js): it write-throughs to
// SQLite on `.set()` and *only* on `.set()`. Mutating the array in place does
// not persist, which is why every caller goes through this.
function writeTurns(client, channelId, turns) {
    const capped = turns.length > MEMORY_LIMIT ? turns.slice(-MEMORY_LIMIT) : turns;
    client.memory.set(channelId, capped);
    return capped;
}

function appendTurn(client, channelId, turn) {
    return writeTurns(client, channelId, [...readTurns(client, channelId), turn]);
}

module.exports = { MEMORY_LIMIT, readTurns, writeTurns, appendTurn };
