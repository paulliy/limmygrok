'use strict';

// The server's reaction GIFs, learned the same way its slang is.
//
// A server's reaction GIFs are in-jokes: the specific clip that gets posted
// every time someone whiffs is as much a part of how the place talks as any
// catchphrase. Searching Tenor would return a technically-correct GIF that
// nobody here has ever posted, which is the opposite of the point.
//
// So this learns from what the server actually posts. Every GIF or image link
// is stored once per URL with a use count and the text it tends to appear
// around, indexed by FTS5. When a reply lands on a matching topic, the bot can
// post the GIF this server already uses for exactly that.
//
// Posting the URL is enough — Discord unfurls Tenor/Giphy/image links into the
// embed itself — so nothing is ever re-uploaded or stored beyond the link.

const { safeError } = require('./log');
const { tokenize, normalizeForLearning, guildCount } = require('./corpus');
const { COMMON_WORDS } = require('./commonWords');

// Hosts whose links Discord renders as an image or looping GIF embed. A link
// that will not unfurl is useless as a reaction, so nothing else is stored.
const GIF_HOSTS = ['tenor.com', 'media.tenor.com', 'c.tenor.com', 'giphy.com', 'media.giphy.com', 'i.giphy.com'];
const IMAGE_HOSTS = ['cdn.discordapp.com', 'media.discordapp.net', 'i.imgur.com', 'imgur.com'];
const IMAGE_EXTENSIONS = ['.gif', '.gifv', '.png', '.jpg', '.jpeg', '.webp'];

const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;

// A GIF is only worth reusing if it has been posted enough to be a habit
// rather than a one-off, and a reply should only carry one if the topic
// genuinely matches.
const MIN_USES_TO_REUSE = 2;
const MAX_CONTEXT_CHARS = 600;

function initMediaSchema(db) {
    // One row per distinct URL per guild: a GIF posted twenty times is one
    // reaction the server uses a lot, not twenty separate reactions.
    db.exec(`
        CREATE TABLE IF NOT EXISTS corpus_media (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id  TEXT NOT NULL,
            url       TEXT NOT NULL,
            kind      TEXT NOT NULL,
            context   TEXT NOT NULL DEFAULT '',
            uses      INTEGER NOT NULL DEFAULT 1,
            last_used INTEGER NOT NULL,
            UNIQUE (guild_id, url)
        );
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_corpus_media_guild ON corpus_media (guild_id, uses);');

    db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS corpus_media_fts USING fts5(
            context,
            content='corpus_media',
            content_rowid='id',
            tokenize='unicode61'
        );
    `);
    db.exec(`
        CREATE TRIGGER IF NOT EXISTS corpus_media_ai AFTER INSERT ON corpus_media BEGIN
            INSERT INTO corpus_media_fts(rowid, context) VALUES (new.id, new.context);
        END;
    `);
    db.exec(`
        CREATE TRIGGER IF NOT EXISTS corpus_media_ad AFTER DELETE ON corpus_media BEGIN
            INSERT INTO corpus_media_fts(corpus_media_fts, rowid, context) VALUES ('delete', old.id, old.context);
        END;
    `);
    // Context accumulates as a GIF is reposted, so the index has to follow.
    db.exec(`
        CREATE TRIGGER IF NOT EXISTS corpus_media_au AFTER UPDATE ON corpus_media BEGIN
            INSERT INTO corpus_media_fts(corpus_media_fts, rowid, context) VALUES ('delete', old.id, old.context);
            INSERT INTO corpus_media_fts(rowid, context) VALUES (new.id, new.context);
        END;
    `);
}

function hostOf(url) {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch (e) {
        return null;
    }
}

function pathOf(url) {
    try {
        return new URL(url).pathname.toLowerCase();
    } catch (e) {
        return '';
    }
}

// Classifies a link as a reusable GIF, a reusable image, or nothing.
function classifyUrl(url) {
    const host = hostOf(url);
    if (!host) return null;

    const bare = host.replace(/^www\./, '');
    if (GIF_HOSTS.includes(bare)) return 'gif';

    if (IMAGE_HOSTS.includes(bare)) {
        const path = pathOf(url);
        if (path.endsWith('.gif') || path.endsWith('.gifv')) return 'gif';
        if (IMAGE_EXTENSIONS.some((extension) => path.endsWith(extension))) return 'image';
    }

    return null;
}

// Pulls reusable media out of a message's text and its attachments.
function extractMedia(content, attachments) {
    const found = new Map();

    for (const url of String(content || '').match(URL_PATTERN) || []) {
        // Discord CDN links carry expiring signature params; the bare path is
        // the stable identity, and re-posting is what refreshes them anyway.
        const kind = classifyUrl(url);
        if (kind) found.set(url, kind);
    }

    const list = attachments?.values ? Array.from(attachments.values())
        : (Array.isArray(attachments) ? attachments : []);
    for (const attachment of list) {
        if (!attachment?.url) continue;
        const type = attachment.contentType || '';
        if (type === 'image/gif') found.set(attachment.url, 'gif');
        else if (type.startsWith('image/')) found.set(attachment.url, 'image');
    }

    return [...found].map(([url, kind]) => ({ url, kind }));
}

// The searchable meaning of a reaction GIF is rarely in its own message —
// a GIF-only post has no text at all. What it is reacting *to* is the signal,
// so callers pass the preceding message as well.
function buildContext(ownText, precedingText) {
    return [normalizeForLearning(precedingText), normalizeForLearning(ownText)]
        .filter(Boolean)
        .join(' ')
        .slice(0, MAX_CONTEXT_CHARS);
}

// Records every reusable link in a message. Repeat posts bump the use count
// and widen the stored context rather than creating a second row.
function recordMedia(db, { guildId, content, attachments, ownText, precedingText, ts = Date.now() } = {}) {
    if (!db || !guildId) return 0;

    const media = extractMedia(content, attachments);
    if (media.length === 0) return 0;

    const context = buildContext(ownText ?? content, precedingText);
    let recorded = 0;

    for (const { url, kind } of media) {
        try {
            const existing = db.prepare('SELECT id, context FROM corpus_media WHERE guild_id = ? AND url = ?')
                .get(guildId, url);

            if (existing) {
                // Keep the most recent contexts, capped, so a GIF used in many
                // situations stays findable in all of them without the row
                // growing without bound.
                const merged = `${context} ${existing.context}`.trim().slice(0, MAX_CONTEXT_CHARS);
                db.prepare('UPDATE corpus_media SET uses = uses + 1, context = ?, last_used = ? WHERE id = ?')
                    .run(merged, ts, existing.id);
            } else {
                db.prepare(
                    'INSERT INTO corpus_media (guild_id, url, kind, context, uses, last_used) VALUES (?, ?, ?, ?, 1, ?)'
                ).run(guildId, url, kind, context, ts);
            }
            recorded += 1;
        } catch (e) {
            safeError('[MEDIA] Failed to record media:', e);
        }
    }

    return recorded;
}

function buildMatchQuery(text) {
    const tokens = tokenize(text).filter((token) => token.length >= 3 && !COMMON_WORDS.has(token));
    const unique = [...new Set(tokens)].slice(0, 8);
    if (unique.length === 0) return null;
    return unique.map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ');
}

// Finds GIFs this server posts in situations like the one at hand. Ranked by
// text match first, then by how established the GIF is.
//
// Same rank-inside-FTS-then-join shape as retrieveSimilar in utils/corpus.js,
// and for the same reason — joining before the sort makes cost scale with
// everything that matched rather than with what is returned. This table is
// far smaller (one row per distinct URL, not per post), so the effect is
// milder here, but the pathology is identical and there is no reason to keep
// the slow phrasing. The guild and uses filters move outside the ranked
// subquery, so the pool is widened to leave room for them.
function findMatchingMedia(db, guildId, queryText, { limit = 3, minUses = MIN_USES_TO_REUSE } = {}) {
    if (!db || !guildId) return [];
    const match = buildMatchQuery(queryText);
    if (!match) return [];

    try {
        const poolLimit = Math.min(limit * 10 * guildCount(db), 300);
        return db.prepare(`
            SELECT m.url, m.kind, m.uses, f.score
            FROM (
                SELECT rowid AS rid, bm25(corpus_media_fts) AS score
                FROM corpus_media_fts
                WHERE corpus_media_fts MATCH ?
                ORDER BY bm25(corpus_media_fts) LIMIT ?
            ) f
            JOIN corpus_media m ON m.id = f.rid
            WHERE m.guild_id = ? AND m.uses >= ?
            ORDER BY f.score, m.uses DESC
            LIMIT ?
        `).all(match, poolLimit, guildId, minUses, limit);
    } catch (e) {
        safeError('[MEDIA] Media retrieval failed:', e);
        return [];
    }
}

// How often a reply carries a GIF, and how close together two can land. A
// reaction GIF is funny because it is occasional; a bot that answers every
// message with one is a bot nobody keeps in the server.
const GARNISH_CHANCE = 0.12;
const GARNISH_COOLDOWN_MS = 10 * 60 * 1000;

// Decides whether this particular reply gets a GIF, and which.
//
// Four gates, cheapest first: the per-channel cooldown, the dice, a topical
// FTS match, and the GIF being established enough to be a habit. All four must
// pass, which is what makes this a garnish rather than a gimmick.
function pickGarnishGif(db, guildId, queryText, {
    channelId,
    cooldowns,
    now = Date.now(),
    chance = GARNISH_CHANCE,
    cooldownMs = GARNISH_COOLDOWN_MS,
    random = Math.random,
} = {}) {
    if (!db || !guildId || !channelId) return null;

    const lastUsed = cooldowns?.get(channelId) ?? 0;
    if (now - lastUsed < cooldownMs) return null;
    if (random() >= chance) return null;

    const hits = findMatchingMedia(db, guildId, queryText, { limit: 3 });
    if (hits.length === 0) return null;

    // Pick among the top few rather than always the single best, so the same
    // topic does not always produce the same GIF.
    const chosen = hits[Math.floor(random() * hits.length)] || hits[0];
    cooldowns?.set(channelId, now);
    return chosen.url;
}

function countMedia(db, guildId) {
    if (!db || !guildId) return 0;
    try {
        return db.prepare('SELECT COUNT(*) AS n FROM corpus_media WHERE guild_id = ?').get(guildId)?.n ?? 0;
    } catch (e) {
        return 0;
    }
}

function forgetMedia(db, guildId) {
    if (!db || !guildId) return 0;
    try {
        const before = countMedia(db, guildId);
        db.prepare('DELETE FROM corpus_media WHERE guild_id = ?').run(guildId);
        return before;
    } catch (e) {
        safeError('[MEDIA] Failed to forget media:', e);
        return 0;
    }
}

module.exports = {
    initMediaSchema,
    recordMedia,
    extractMedia,
    classifyUrl,
    buildContext,
    findMatchingMedia,
    pickGarnishGif,
    countMedia,
    forgetMedia,
    MIN_USES_TO_REUSE,
    GARNISH_CHANCE,
    GARNISH_COOLDOWN_MS,
};
