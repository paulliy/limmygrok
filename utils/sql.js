'use strict';

// Prepared-statement cache.
//
// `db.prepare()` compiles SQL every time it is called. The corpus and media
// modules run their statements on the hottest paths in the bot — one insert
// per message seen, several selects per reply — and were recompiling on each
// one. utils/stats.js already cached its insert this way; this generalises it
// so the rest can stop paying for it too.
//
// Keyed by database handle in a WeakMap so a closed or discarded database
// (every test opens its own) does not keep its statements alive.

const cachesByDb = new WeakMap();

function prepareCached(db, sql) {
    let cache = cachesByDb.get(db);
    if (!cache) {
        cache = new Map();
        cachesByDb.set(db, cache);
    }

    let statement = cache.get(sql);
    if (!statement) {
        statement = db.prepare(sql);
        cache.set(sql, statement);
    }
    return statement;
}

module.exports = { prepareCached };
