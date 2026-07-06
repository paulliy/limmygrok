'use strict';

const util = require('util');
let config = {};
try {
    config = require('../config.json');
} catch (e) {
    // Ignore if not present
}

const URL_REGEX = /https?:\/\/[^\s]+/gi;
const IMAGE_MIME_TYPES_BY_EXTENSION = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
};

function isImageUrl(url) {
    try {
        const parsed = new URL(url);
        const pathname = parsed.pathname.toLowerCase();
        return pathname.endsWith('.png') ||
               pathname.endsWith('.jpg') ||
               pathname.endsWith('.jpeg') ||
               pathname.endsWith('.gif') ||
               pathname.endsWith('.webp');
    } catch (e) {
        return false;
    }
}

async function downloadImageAsBase64(url) {
    try {
        if (!url) return null;
        if (url.startsWith('data:')) {
            return url;
        }
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            return url;
        }

        const response = await fetch(url);
        if (!response.ok) {
            safeError(`Failed to download image: ${response.status} ${response.statusText} from ${url}`);
            return url; // Fallback to original URL
        }
        const arrayBuffer = await response.arrayBuffer();
        const contentType = getImageMimeType(url, response.headers?.get?.('content-type'));
        return `data:${contentType};base64,${Buffer.from(arrayBuffer).toString('base64')}`;
    } catch (e) {
        safeError(`Error downloading image from ${url}:`, e);
        return url; // Fallback to original URL
    }
}

function getImageMimeType(url, contentType) {
    const normalizedContentType = typeof contentType === 'string'
        ? contentType.split(';')[0].trim().toLowerCase()
        : '';

    if (normalizedContentType.startsWith('image/')) {
        return normalizedContentType;
    }

    try {
        const pathname = new URL(url).pathname.toLowerCase();
        for (const [extension, mimeType] of Object.entries(IMAGE_MIME_TYPES_BY_EXTENSION)) {
            if (pathname.endsWith(extension)) {
                return mimeType;
            }
        }
    } catch (e) {
        // Use the default below when the URL cannot be parsed.
    }

    return 'image/png';
}

async function resolveImageUrlsToBase64(messages) {
    if (!messages || !Array.isArray(messages)) {
        return messages;
    }

    const resolvedMessages = [];
    for (const msg of messages) {
        if (!msg) continue;
        const newMsg = { ...msg };
        if (Array.isArray(newMsg.content)) {
            const newContent = [];
            for (const part of newMsg.content) {
                if (part && part.type === 'image_url' && part.image_url && part.image_url.url) {
                    const resolvedUrl = await downloadImageAsBase64(part.image_url.url);
                    newContent.push({
                        type: 'image_url',
                        image_url: {
                            url: resolvedUrl || part.image_url.url
                        }
                    });
                } else {
                    newContent.push(part);
                }
            }
            newMsg.content = newContent;
        }
        resolvedMessages.push(newMsg);
    }
    return resolvedMessages;
}

function parseTextAndImages(text, attachments) {
    const imageUrls = [];
    let cleanedText = text || '';
    
    // Extract URLs from text
    const matches = cleanedText.match(URL_REGEX) || [];
    for (const url of matches) {
        if (isImageUrl(url)) {
            imageUrls.push(url);
            // split/join removes every occurrence (String.replace with a string
            // argument only removes the first) and treats the URL literally.
            cleanedText = cleanedText.split(url).join('');
        }
    }
    
    // Check attachments
    const attachmentList = attachments && attachments.values 
        ? Array.from(attachments.values()) 
        : (Array.isArray(attachments) ? attachments : []);
        
    for (const attachment of attachmentList) {
        if (attachment && attachment.contentType && attachment.contentType.startsWith('image/')) {
            if (attachment.url) {
                imageUrls.push(attachment.url);
            }
        }
    }
    
    return { text: cleanedText, imageUrls };
}

function formatContent(text, imageUrls) {
    if (!imageUrls || imageUrls.length === 0) {
        return text;
    }
    const parts = [];
    if (text && text.trim() !== '') {
        parts.push({ type: 'text', text });
    }
    for (const url of imageUrls) {
        parts.push({ type: 'image_url', image_url: { url } });
    }
    return parts;
}

function parseDiscordMessage(message) {
    if (!message) return null;
    
    let role = 'user';
    if (message.role) {
        role = message.role;
    } else if (message.author) {
        role = message.author.bot ? 'assistant' : 'user';
    }
    
    if (Array.isArray(message.content)) {
        return { role, content: message.content };
    }
    
    const text = message.content || '';
    const attachments = message.attachments || [];
    
    const { text: parsedText, imageUrls } = parseTextAndImages(text, attachments);
    const content = formatContent(parsedText, imageUrls);
    
    return { role, content };
}

function isNonEmptyContent(content) {
    if (typeof content === 'string') return content.trim() !== '';
    if (Array.isArray(content)) return content.length > 0;
    return false;
}

function toContentParts(content) {
    return Array.isArray(content) ? content : [{ type: 'text', text: content }];
}

function mergeMessageContent(a, b) {
    if (typeof a === 'string' && typeof b === 'string') {
        return `${a}\n${b}`;
    }

    const partsA = toContentParts(a);
    const partsB = toContentParts(b);
    const merged = [...partsA];

    const lastPart = merged[merged.length - 1];
    const firstPartB = partsB[0];

    if (lastPart && lastPart.type === 'text' && firstPartB && firstPartB.type === 'text') {
        merged[merged.length - 1] = { type: 'text', text: `${lastPart.text}\n${firstPartB.text}` };
        merged.push(...partsB.slice(1));
    } else {
        merged.push(...partsB);
    }

    return merged;
}

function parseimgs(messages) {
    if (!messages) {
        return [];
    }

    const flatMessages = Array.isArray(messages) ? messages.flat(Infinity) : [messages];

    const parsed = flatMessages
        .map(msg => parseDiscordMessage(msg))
        .filter(msg => msg && isNonEmptyContent(msg.content));

    if (parsed.length === 0) {
        return [];
    }

    const merged = [];
    let lastMessage = { ...parsed[0] };

    for (let i = 1; i < parsed.length; i++) {
        const currentMessage = parsed[i];
        if (currentMessage.role === lastMessage.role) {
            lastMessage.content = mergeMessageContent(lastMessage.content, currentMessage.content);
        } else {
            merged.push(lastMessage);
            lastMessage = { ...currentMessage };
        }
    }
    merged.push(lastMessage);

    return merged;
}

function scrubString(str) {
    if (typeof str !== 'string') return str;
    let result = str;
    const discordToken = config.token;
    const apiKey = config.APIkey;
    if (discordToken && typeof discordToken === 'string' && discordToken.trim() !== '') {
        result = result.split(discordToken).join('[REDACTED_DISCORD_TOKEN]');
    }
    if (apiKey && typeof apiKey === 'string' && apiKey.trim() !== '') {
        result = result.split(apiKey).join('[REDACTED_API_KEY]');
    }
    return result;
}

function scrubValue(val, seen = new WeakSet()) {
    if (typeof val === 'string') {
        return scrubString(val);
    }
    if (val && typeof val === 'object') {
        if (seen.has(val)) {
            return val;
        }
        seen.add(val);

        if (val instanceof Error) {
            const scrubbedErr = new Error(scrubString(val.message));
            scrubbedErr.name = val.name;
            if (val.stack) {
                scrubbedErr.stack = scrubString(val.stack);
            }
            for (const key of Object.keys(val)) {
                scrubbedErr[key] = scrubValue(val[key], seen);
            }
            return scrubbedErr;
        }

        if (Array.isArray(val)) {
            return val.map(item => scrubValue(item, seen));
        }

        const scrubbedObj = {};
        for (const key of Object.keys(val)) {
            scrubbedObj[key] = scrubValue(val[key], seen);
        }
        return scrubbedObj;
    }
    return val;
}

function safeLog(...args) {
    const scrubbedArgs = args.map(arg => scrubValue(arg));
    console.log(...scrubbedArgs);
}

function safeError(...args) {
    const scrubbedArgs = args.map(arg => scrubValue(arg));
    console.error(...scrubbedArgs);
}

async function createChatCompletionWithFallback(openWebUI, payload, requestOptions) {
    if (!openWebUI?.chat?.completions?.create) {
        throw new Error('OpenWebUI client is not configured.');
    }

    try {
        const stream = await openWebUI.chat.completions.create({ ...payload, stream: true }, requestOptions);
        return { isStream: true, stream, content: '' };
    } catch (error) {
        const statusCode = error?.status || error?.statusCode || error?.response?.status;
        const message = typeof error?.message === 'string' ? error.message : '';
        const isStreamingProblem = /stream|no body|unsupported/i.test(message);
        const shouldFallback = payload?.stream !== false && (
            statusCode === 404 ||
            statusCode === 405 ||
            isStreamingProblem
        );

        if (!shouldFallback) {
            throw error;
        }

        safeLog('\n[DEBUG] Streaming chat request failed, retrying without streaming.', error);
        const fallbackPayload = { ...payload, stream: false };
        const response = await openWebUI.chat.completions.create(fallbackPayload, requestOptions);
        return {
            isStream: false,
            response,
            content: response?.choices?.[0]?.message?.content || ''
        };
    }
}

module.exports = {
    isImageUrl,
    parseTextAndImages,
    formatContent,
    parseDiscordMessage,
    parseimgs,
    resolveImageUrlsToBase64,
    safeLog,
    safeError,
    createChatCompletionWithFallback
};
