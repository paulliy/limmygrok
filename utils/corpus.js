'use strict';

// The learning layer: what makes the bot sound like *this* server.
//
// The reference point is GenAi, which is a Markov chain over the server's own
// messages — that is why it is instant, funny, and picks up slang the day it
// is coined. A Markov chain gets its voice by only ever emitting word
// sequences the server has actually used; the price is that it cannot be
// coherent, answer anything, or stay on topic.
//
// This module keeps the source of the voice and drops the price. Every
// message the bot is allowed to see is written to a corpus. From that corpus
// two things are derived and handed to the model on every reply:
//
//   1. A DIALECT PROFILE — the server's own vocabulary, catchphrases, emoji
//      and typing habits, found by subtraction against a common-English list
//      (utils/commonWords.js). This is the Markov chain's transition table,
//      compressed into something a language model can read.
//   2. RETRIEVED PRECEDENT — the messages this server has actually written
//      about the topic at hand, pulled by full-text search. This is where the
//      server's *knowledge* (who is who, what the in-jokes mean, what
//      happened last week) comes from, and it is why the bot can talk about
//      things no model was trained on.
//
// One system, not two: there is no separate Markov mode. The corpus feeds the
// single LLM path in utils/prompt.js.

const { safeError } = require('./log');
const { COMMON_WORDS } = require('./commonWords');

// Keep the corpus bounded so a busy server cannot grow the SQLite file
// without limit. Oldest messages are dropped first.
const MAX_CORPUS_MESSAGES_PER_GUILD = 50_000;

// A profile is recomputed when it is either stale or meaningfully out of
// date. The message threshold is what makes the bot adapt *fast*: a new
// in-joke that catches on shows up in the dialect within ~40 messages rather
// than waiting out a timer.
const PROFILE_MAX_AGE_MS = 30 * 60 * 1000;
const PROFILE_REFRESH_MESSAGES = 40;

// How much corpus each profile computation reads. Recent messages matter
// most — a server's slang drifts — so this is a sliding window, not the whole
// history.
const PROFILE_WINDOW = 4000;

const URL_PATTERN = /https?:\/\/\S+/gi;
const USER_MENTION_PATTERN = /<@[!&]?\d+>/g;
const CHANNEL_MENTION_PATTERN = /<#\d+>/g;
const CUSTOM_EMOJI_PATTERN = /<a?:(\w+):\d+>/g;
const CODE_BLOCK_PATTERN = /```[\s\S]*?```|`[^`]*`/g;
const UNICODE_EMOJI_PATTERN = /\p{Extended_Pictographic}/gu;
const WORD_PATTERN = /[a-z0-9][a-z0-9'’-]*/g;

// --- schema ------------------------------------------------------------------

function initCorpusSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS corpus_messages (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id   TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            user_id    TEXT,
            author     TEXT,
            content    TEXT NOT NULL,
            ts         INTEGER NOT NULL
        );
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_corpus_guild_ts ON corpus_messages (guild_id, ts);');

    // External-content FTS index: the text is stored once in corpus_messages
    // and the index only holds postings, kept in sync by the triggers below.
    db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS corpus_fts USING fts5(
            content,
            content='corpus_messages',
            content_rowid='id',
            tokenize='unicode61'
        );
    `);
    db.exec(`
        CREATE TRIGGER IF NOT EXISTS corpus_messages_ai AFTER INSERT ON corpus_messages BEGIN
            INSERT INTO corpus_fts(rowid, content) VALUES (new.id, new.content);
        END;
    `);
    db.exec(`
        CREATE TRIGGER IF NOT EXISTS corpus_messages_ad AFTER DELETE ON corpus_messages BEGIN
            INSERT INTO corpus_fts(corpus_fts, rowid, content) VALUES ('delete', old.id, old.content);
        END;
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS corpus_profiles (
            guild_id      TEXT PRIMARY KEY,
            profile       TEXT NOT NULL,
            message_count INTEGER NOT NULL,
            computed_at   INTEGER NOT NULL
        );
    `);
}

// --- text handling -----------------------------------------------------------

// Strips the parts of a Discord message that are noise for style learning:
// code, links, and raw mention IDs. Custom emoji become :name: so the emoji
// itself survives as a token.
function normalizeForLearning(text) {
    return String(text || '')
        .replace(CODE_BLOCK_PATTERN, ' ')
        .replace(URL_PATTERN, ' ')
        .replace(USER_MENTION_PATTERN, ' ')
        .replace(CHANNEL_MENTION_PATTERN, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenize(text) {
    const cleaned = normalizeForLearning(text)
        .replace(CUSTOM_EMOJI_PATTERN, ' $1 ')
        .toLowerCase();
    return cleaned.match(WORD_PATTERN) || [];
}

// Messages that teach the bot nothing about how the server talks: bare links,
// bot commands, single characters. Filtered at write time so the corpus stays
// dense.
function isLearnable(text) {
    const normalized = normalizeForLearning(text);
    if (normalized.length < 3) return false;
    if (/^[/!.$?~-]\w+/.test(normalized)) return false; // bot command invocations
    return tokenize(normalized).length > 0;
}

// --- writing -----------------------------------------------------------------

const pruneCounters = new WeakMap();

function recordMessage(db, { guildId, channelId, userId, author, content, ts = Date.now() }) {
    if (!db || !guildId || !channelId) return false;
    if (!isLearnable(content)) return false;

    try {
        db.prepare(
            'INSERT INTO corpus_messages (guild_id, channel_id, user_id, author, content, ts) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(guildId, channelId, userId ?? null, author ?? null, normalizeForLearning(content), ts);
    } catch (e) {
        // Learning is best-effort; a write failure must never break a reply.
        safeError('[CORPUS] Failed to record message:', e);
        return false;
    }

    // Checking the row count on every insert would mean a COUNT(*) per
    // message, so amortise it: check once every 500 writes.
    const seen = (pruneCounters.get(db) || 0) + 1;
    pruneCounters.set(db, seen % 500);
    if (seen >= 500) pruneCorpus(db, guildId);

    return true;
}

// Deleting from corpus_messages fires the FTS sync trigger, whose own writes
// inflate the driver's reported `changes`. Both functions below therefore
// measure the corpus with COUNT(*) around the delete rather than trusting it —
// these numbers are shown to users by /dialect forget.
function pruneCorpus(db, guildId, maxMessages = MAX_CORPUS_MESSAGES_PER_GUILD) {
    if (!db || !guildId) return 0;
    try {
        const before = countMessages(db, guildId);
        if (before <= maxMessages) return 0;
        db.prepare(`
            DELETE FROM corpus_messages
            WHERE guild_id = ?
              AND id NOT IN (
                SELECT id FROM corpus_messages WHERE guild_id = ? ORDER BY ts DESC LIMIT ?
              )
        `).run(guildId, guildId, maxMessages);
        return before - countMessages(db, guildId);
    } catch (e) {
        safeError('[CORPUS] Failed to prune corpus:', e);
        return 0;
    }
}

function forgetGuild(db, guildId) {
    if (!db || !guildId) return 0;
    try {
        const before = countMessages(db, guildId);
        db.prepare('DELETE FROM corpus_messages WHERE guild_id = ?').run(guildId);
        db.prepare('DELETE FROM corpus_profiles WHERE guild_id = ?').run(guildId);
        return before;
    } catch (e) {
        safeError('[CORPUS] Failed to forget guild corpus:', e);
        return 0;
    }
}

function countMessages(db, guildId) {
    if (!db || !guildId) return 0;
    try {
        const row = db.prepare('SELECT COUNT(*) AS n FROM corpus_messages WHERE guild_id = ?').get(guildId);
        return row?.n ?? 0;
    } catch (e) {
        return 0;
    }
}

// --- profile computation -----------------------------------------------------

// Thresholds scale with corpus size. On a fresh server two people using a word
// twice is already a signal worth picking up; on a corpus of thousands it is
// noise. This is what lets the bot adapt within an evening of a new in-joke
// without turning every typo into "server slang" later on.
function thresholdsFor(sampleSize) {
    if (sampleSize < 200) return { minCount: 2, minUsers: 1 };
    if (sampleSize < 1000) return { minCount: 3, minUsers: 2 };
    return { minCount: 5, minUsers: 2 };
}

function addOccurrence(map, key, userId) {
    let entry = map.get(key);
    if (!entry) {
        entry = { count: 0, users: new Set(), example: null };
        map.set(key, entry);
    }
    entry.count += 1;
    if (userId) entry.users.add(userId);
    return entry;
}

function rankEntries(map, { minCount, minUsers }, limit) {
    const ranked = [];
    for (const [key, entry] of map) {
        if (entry.count < minCount) continue;
        if (entry.users.size < minUsers) continue;
        ranked.push({
            term: key,
            count: entry.count,
            users: entry.users.size,
            example: entry.example,
            // Terms several people use are far better evidence of shared
            // server vocabulary than one person repeating themselves.
            score: entry.count * (1 + Math.log2(entry.users.size + 1)),
        });
    }
    ranked.sort((a, b) => b.score - a.score);
    return ranked.slice(0, limit);
}

function computeStyleProfile(rows) {
    const words = new Map();
    const phrases = new Map();
    const customEmoji = new Map();
    const unicodeEmoji = new Map();

    let totalWords = 0;
    let lettered = 0;
    let allLowercase = 0;
    let questions = 0;
    let endsWithPunctuation = 0;
    let emojiTotal = 0;

    for (const row of rows) {
        const raw = row.content || '';
        const userId = row.user_id;
        const tokens = tokenize(raw);
        if (tokens.length === 0) continue;

        totalWords += tokens.length;

        // Typing habits, measured on the raw text so casing survives.
        if (/[a-zA-Z]/.test(raw)) {
            lettered += 1;
            if (raw === raw.toLowerCase()) allLowercase += 1;
        }
        if (raw.trim().endsWith('?')) questions += 1;
        if (/[.!?]$/.test(raw.trim())) endsWithPunctuation += 1;

        for (const match of raw.matchAll(CUSTOM_EMOJI_PATTERN)) {
            // Store the full <:name:id> form, not just :name:. Discord only
            // renders a custom emoji when the ID is present, so showing the
            // model the bare name taught it to emit text that renders as
            // literal ":limmy:" in chat. The full form is also what makes
            // /dialect show display the real emoji.
            addOccurrence(customEmoji, match[0], userId);
            emojiTotal += 1;
        }
        for (const match of raw.matchAll(UNICODE_EMOJI_PATTERN)) {
            addOccurrence(unicodeEmoji, match[0], userId);
            emojiTotal += 1;
        }

        // Vocabulary: words the server uses that ordinary English does not.
        for (const token of tokens) {
            if (token.length < 3 || token.length > 24) continue;
            if (COMMON_WORDS.has(token)) continue;
            if (/^\d+$/.test(token)) continue;
            const entry = addOccurrence(words, token, userId);
            if (!entry.example && raw.length <= 160) entry.example = raw;
        }

        // Catchphrases: recurring 2- and 3-word runs. Stopwords are kept here
        // on purpose — "holding site" and "get in vc" are phrases precisely
        // because of their common words — but a run made *entirely* of filler
        // is dropped below.
        for (let n = 2; n <= 3; n++) {
            for (let i = 0; i + n <= tokens.length; i++) {
                const gram = tokens.slice(i, i + n);
                if (gram.every((word) => COMMON_WORDS.has(word))) continue;
                const entry = addOccurrence(phrases, gram.join(' '), userId);
                if (!entry.example && raw.length <= 160) entry.example = raw;
            }
        }
    }

    const sampleSize = rows.length;
    const thresholds = thresholdsFor(sampleSize);
    const rankedPhrases = rankEntries(phrases, { ...thresholds, minCount: thresholds.minCount + 1 }, 40);

    // A trigram whose bigram half is already listed adds nothing, and vice
    // versa; keep the longer, more specific form.
    const keptPhrases = [];
    for (const phrase of rankedPhrases) {
        const subsumed = keptPhrases.some((kept) =>
            kept.term.includes(phrase.term) || phrase.term.includes(kept.term));
        if (!subsumed) keptPhrases.push(phrase);
        if (keptPhrases.length >= 12) break;
    }

    return {
        sampleSize,
        vocabulary: rankEntries(words, thresholds, 30),
        phrases: keptPhrases,
        customEmoji: rankEntries(customEmoji, { minCount: 2, minUsers: 1 }, 8),
        unicodeEmoji: rankEntries(unicodeEmoji, { minCount: 2, minUsers: 1 }, 8),
        style: {
            avgWords: sampleSize > 0 ? totalWords / sampleSize : 0,
            lowercaseRatio: lettered > 0 ? allLowercase / lettered : 0,
            questionRatio: sampleSize > 0 ? questions / sampleSize : 0,
            punctuationRatio: sampleSize > 0 ? endsWithPunctuation / sampleSize : 0,
            emojiPerMessage: sampleSize > 0 ? emojiTotal / sampleSize : 0,
        },
    };
}

function readProfileCache(db, guildId) {
    try {
        const row = db.prepare(
            'SELECT profile, message_count, computed_at FROM corpus_profiles WHERE guild_id = ?'
        ).get(guildId);
        if (!row) return null;
        return {
            profile: JSON.parse(row.profile),
            messageCount: row.message_count,
            computedAt: row.computed_at,
        };
    } catch (e) {
        return null;
    }
}

function writeProfileCache(db, guildId, profile, messageCount) {
    try {
        db.prepare(`
            INSERT INTO corpus_profiles (guild_id, profile, message_count, computed_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(guild_id) DO UPDATE SET
                profile = excluded.profile,
                message_count = excluded.message_count,
                computed_at = excluded.computed_at
        `).run(guildId, JSON.stringify(profile), messageCount, Date.now());
    } catch (e) {
        safeError('[CORPUS] Failed to cache profile:', e);
    }
}

// Returns the guild's dialect profile, recomputing it only when stale or when
// enough new messages have arrived to shift it. Computation reads a few
// thousand rows and takes single-digit milliseconds, but it happens on the
// reply path, so the cache matters.
function getStyleProfile(db, guildId, { force = false } = {}) {
    if (!db || !guildId) return null;

    const messageCount = countMessages(db, guildId);
    if (messageCount === 0) return null;

    const cached = readProfileCache(db, guildId);
    if (!force && cached) {
        const isStale = Date.now() - cached.computedAt > PROFILE_MAX_AGE_MS;
        const grewEnough = messageCount - cached.messageCount >= PROFILE_REFRESH_MESSAGES;
        if (!isStale && !grewEnough) return cached.profile;
    }

    try {
        const rows = db.prepare(
            'SELECT content, user_id FROM corpus_messages WHERE guild_id = ? ORDER BY ts DESC LIMIT ?'
        ).all(guildId, PROFILE_WINDOW);
        const profile = computeStyleProfile(rows);
        writeProfileCache(db, guildId, profile, messageCount);
        return profile;
    } catch (e) {
        safeError('[CORPUS] Failed to compute style profile:', e);
        return cached?.profile ?? null;
    }
}

// --- retrieval ---------------------------------------------------------------

// FTS5 treats bare punctuation and its own keywords as syntax, so every term
// is wrapped in double quotes (with internal quotes doubled) and OR'd.
function buildMatchQuery(text) {
    const tokens = tokenize(text)
        .filter((token) => token.length >= 3 && !COMMON_WORDS.has(token));

    const unique = [...new Set(tokens)].slice(0, 8);
    if (unique.length === 0) return null;
    return unique.map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ');
}

// A hit whose own text is this short, or opens on a pronoun, is likely to
// misattribute a fact once quoted in isolation: "he never opens correctly"
// says nothing about who "he" is without what came before it.
const LEADS_WITH_PRONOUN = /^\s*(he|him|his|she|her|hers|they|them|their|it|that|this|those|these|yeah|no|ye|nah)\b/i;
function needsPrecedingContext(content, tokenCount) {
    return tokenCount <= 4 || LEADS_WITH_PRONOUN.test(content);
}

// The message immediately before a hit, in the same channel — attached only
// when the hit itself is too short or pronoun-led to stand alone. Cheap
// (one indexed lookup per hit that needs it, and only a handful of hits ever
// do) and it is exactly the "what is this reacting to" pattern
// utils/media.js already relies on for GIFs.
function fetchPrecedingMessage(db, guildId, channelId, ts) {
    try {
        return db.prepare(
            'SELECT author, content FROM corpus_messages WHERE guild_id = ? AND channel_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1'
        ).get(guildId, channelId, ts) || null;
    } catch (e) {
        return null;
    }
}

// How many guilds this bot has learned from. Used to widen the FTS pool so
// that filtering it down to one guild still fills the precedent slots.
function guildCount(db) {
    try {
        return db.prepare('SELECT COUNT(DISTINCT guild_id) AS n FROM corpus_messages').get()?.n || 1;
    } catch (e) {
        return 1;
    }
}

// Ranking must happen *inside* the FTS table, before the join.
//
// The obvious phrasing — join corpus_fts to corpus_messages, filter by guild,
// `ORDER BY bm25(...) LIMIT n` — makes SQLite materialise the join for every
// matching row and only then sort, so a query term that appears in most
// messages costs time proportional to the whole corpus. Measured on a
// 1,200-message corpus: 133 ms that way, 1.2 ms this way, for byte-identical
// results. Neither the sort (1.0 ms alone) nor the join (0.5 ms alone) is
// slow; it is doing them in that order that is.
//
// So: rank and bound inside corpus_fts first, then join only the survivors.
// The guild filter has to move to the outer query as a result, which is why
// the inner limit is scaled by guildCount — otherwise, on a bot in several
// servers, another guild's hits would eat the pool before this guild's are
// counted.
const POOL_LIMIT_CAP = 600;

// Pulls the messages this server has actually written about the topic at
// hand. This is the bot's memory of server lore: names, running jokes, what
// happened last week — none of which any model was trained on.
//
// Plain BM25 has a second failure mode this corrects for: an OR query across
// up to eight terms lets a message that shares only the single rarest word
// outrank one that is actually about the whole question, because BM25
// rewards term rarity over term coverage. So a wider pool is pulled and
// re-ranked by how many distinct query terms each hit actually matches
// first, BM25 only as the tiebreaker — then near-duplicate reposts of the
// same catchphrase are collapsed so a handful of limited precedent slots
// aren't spent twice on the same line.
function retrieveSimilar(db, guildId, queryText, { limit = 6, poolMultiplier = 5 } = {}) {
    if (!db || !guildId) return [];
    const queryTokens = new Set(tokenize(queryText).filter((token) => token.length >= 3 && !COMMON_WORDS.has(token)));
    const match = buildMatchQuery(queryText);
    if (!match) return [];

    try {
        const poolLimit = Math.min(limit * poolMultiplier * guildCount(db), POOL_LIMIT_CAP);
        const pool = db.prepare(`
            SELECT m.id, m.author, m.user_id, m.channel_id, m.content, m.ts, f.score AS bm25score
            FROM (
                SELECT rowid AS rid, bm25(corpus_fts) AS score
                FROM corpus_fts
                WHERE corpus_fts MATCH ?
                ORDER BY bm25(corpus_fts) LIMIT ?
            ) f
            JOIN corpus_messages m ON m.id = f.rid
            WHERE m.guild_id = ?
            ORDER BY f.score
        `).all(match, poolLimit, guildId);

        const scored = pool.map((row) => {
            const rowTokens = tokenize(row.content);
            const overlap = rowTokens.filter((token) => queryTokens.has(token)).length;
            return { ...row, overlap, tokenCount: rowTokens.length };
        });
        scored.sort((a, b) => b.overlap - a.overlap || a.bm25score - b.bm25score);

        const seenContent = new Set();
        const deduped = [];
        for (const row of scored) {
            const key = row.content.toLowerCase().replace(/\s+/g, ' ').trim();
            if (seenContent.has(key)) continue;
            seenContent.add(key);
            deduped.push(row);
            if (deduped.length >= limit) break;
        }

        return deduped.map((row) => {
            const result = { author: row.author, content: row.content, ts: row.ts, userId: row.user_id };
            if (needsPrecedingContext(row.content, row.tokenCount)) {
                const preceding = fetchPrecedingMessage(db, guildId, row.channel_id, row.ts);
                if (preceding) {
                    result.precedingAuthor = preceding.author;
                    result.precedingContent = preceding.content;
                }
            }
            return result;
        });
    } catch (e) {
        safeError('[CORPUS] Retrieval failed:', e);
        return [];
    }
}

// Representative messages, chosen for shape rather than topic: close to the
// server's typical length, one per author, recent. Retrieval shows the model
// what the server knows; these show it what a message here looks like — which
// is the thing a Markov chain gets for free and a prompt has to teach.
function styleExemplars(db, guildId, { limit = 5 } = {}) {
    if (!db || !guildId) return [];
    try {
        const rows = db.prepare(
            'SELECT author, content, user_id FROM corpus_messages WHERE guild_id = ? ORDER BY ts DESC LIMIT 400'
        ).all(guildId);
        if (rows.length === 0) return [];

        const lengths = rows.map((row) => tokenize(row.content).length).filter((n) => n > 0);
        if (lengths.length === 0) return [];
        const average = lengths.reduce((sum, n) => sum + n, 0) / lengths.length;

        const seenAuthors = new Set();
        return rows
            .map((row) => ({ row, words: tokenize(row.content).length }))
            // Skip one-word grunts and outliers; both misrepresent the norm.
            .filter(({ words }) => words >= 2)
            .sort((a, b) => Math.abs(a.words - average) - Math.abs(b.words - average))
            .filter(({ row }) => {
                const author = row.user_id || row.author;
                if (seenAuthors.has(author)) return false;
                seenAuthors.add(author);
                return true;
            })
            .slice(0, limit)
            .map(({ row }) => row);
    } catch (e) {
        return [];
    }
}

// Fallback texture when retrieval finds nothing: a sample of how the server
// talks in general, so the model always has real examples in front of it.
function recentMessages(db, guildId, { limit = 6 } = {}) {
    if (!db || !guildId) return [];
    try {
        return db.prepare(
            'SELECT author, content, ts FROM corpus_messages WHERE guild_id = ? ORDER BY ts DESC LIMIT ?'
        ).all(guildId, limit);
    } catch (e) {
        return [];
    }
}

module.exports = {
    initCorpusSchema,
    recordMessage,
    pruneCorpus,
    forgetGuild,
    countMessages,
    getStyleProfile,
    computeStyleProfile,
    retrieveSimilar,
    recentMessages,
    styleExemplars,
    buildMatchQuery,
    guildCount,
    tokenize,
    normalizeForLearning,
    isLearnable,
    MAX_CORPUS_MESSAGES_PER_GUILD,
    PROFILE_MAX_AGE_MS,
    PROFILE_REFRESH_MESSAGES,
};
