'use strict';

// Discord message -> OpenAI chat-payload conversion, plus the image pipeline.
//
// Scope is deliberately narrow: this module turns Discord messages into the
// OpenAI `messages` shape and inlines images. Logging lives in utils/log.js,
// the request wrapper in utils/llm.js, and the persona in utils/prompt.js —
// import those directly rather than through here.

const dns = require('dns').promises;
const { safeError } = require('./log');

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

function isPrivateIp(ip) {
    if (!ip) return true; // Treat empty/falsy IPs as unsafe/private
    
    // IPv4 Check
    const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    const ipv4Match = ip.match(ipv4Regex);
    if (ipv4Match) {
        const parts = ipv4Match.slice(1).map(Number);
        if (parts.some(p => p < 0 || p > 255)) return true; // Invalid IPv4, treat as unsafe
        const [a, b, c, d] = parts;
        
        // 127.0.0.0/8 (Loopback)
        if (a === 127) return true;
        // 10.0.0.0/8 (Private network)
        if (a === 10) return true;
        // 172.16.0.0/12 (Private network)
        if (a === 172 && (b >= 16 && b <= 31)) return true;
        // 192.168.0.0/16 (Private network)
        if (a === 192 && b === 168) return true;
        // 169.254.0.0/16 (Link-local)
        if (a === 169 && b === 254) return true;
        // 0.0.0.0/8 (Local / broadcast)
        if (a === 0) return true;
        // 100.64.0.0/10 (Carrier-grade NAT)
        if (a === 100 && (b >= 64 && b <= 127)) return true;
        // 192.0.0.0/24 (IETF Protocol Assignments)
        if (a === 192 && b === 0 && c === 0) return true;
        // 192.0.2.0/24 (TEST-NET-1)
        if (a === 192 && b === 0 && c === 2) return true;
        // 198.18.0.0/15 (Benchmark testing)
        if (a === 198 && (b >= 18 && b <= 19)) return true;
        // 198.51.100.0/24 (TEST-NET-2)
        if (a === 198 && b === 51 && c === 100) return true;
        // 203.0.113.0/24 (TEST-NET-3)
        if (a === 203 && b === 0 && c === 113) return true;
        // 224.0.0.0/4 (Multicast)
        if (a >= 224) return true;
        
        return false;
    }
    
    // IPv6 Check
    const ipv6 = ip.toLowerCase().replace(/[\[\]]/g, '').trim();
    if (ipv6 === '::1' || ipv6 === '::') return true;
    
    // Unique local address fc00::/7 (f[c-d][0-9a-f]...)
    if (/^[fF][c-dCD]/i.test(ipv6)) return true;
    // Link-local fe80::/10 (f[e-f][8-b][0-9a-f]...)
    if (/^[fF][eE][89abAB]/i.test(ipv6)) return true;
    
    // IPv4-mapped IPv6 address (e.g. ::ffff:127.0.0.1)
    if (ipv6.startsWith('::ffff:')) {
        const remaining = ipv6.substring(7);
        if (ipv4Regex.test(remaining)) {
            return isPrivateIp(remaining);
        }
    }
    
    return false;
}

async function isSafeUrl(url) {
    try {
        const parsed = new URL(url);
        const hostname = parsed.hostname;
        
        // Resolve all IPs for the hostname
        const addresses = await dns.lookup(hostname, { all: true });
        
        for (const addr of addresses) {
            if (isPrivateIp(addr.address)) {
                return false;
            }
        }
        return true;
    } catch (e) {
        // If lookup fails or URL is invalid, treat as unsafe
        return false;
    }
}

const DISCORD_CDN_HOSTS = ['cdn.discordapp.com', 'media.discordapp.net'];

// Discord CDN links are signed and time-limited: `ex` is the expiry as a hex
// unix timestamp, and once it passes the URL 404s for everyone, us and the
// model provider alike.
//
// This matters because conversation memory holds image turns for up to
// MEMORY_LIMIT messages. Without this check an image posted hours ago keeps
// being sent on every later reply in that channel — routing the request to
// the (pricier) vision model via pickModel, and handing it a URL that
// resolves to nothing. Detecting it from the URL avoids the doomed fetch too.
//
// Anything we cannot read an expiry from is treated as live: an unsigned or
// unparseable URL might still work, and dropping a valid image is worse than
// attempting one that fails.
function isExpiredDiscordUrl(url, now = Date.now()) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch (e) {
        return false;
    }

    if (!DISCORD_CDN_HOSTS.includes(parsed.hostname.toLowerCase())) return false;

    const expiry = parsed.searchParams.get('ex');
    if (!expiry) return false;

    const expiresAtSeconds = Number.parseInt(expiry, 16);
    if (!Number.isFinite(expiresAtSeconds)) return false;

    return expiresAtSeconds * 1000 < now;
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

        // Only download images from Discord's CDN or media proxy hosts
        let parsed;
        try {
            parsed = new URL(url);
        } catch (e) {
            return url;
        }
        const hostname = parsed.hostname.toLowerCase();
        const allowedHosts = ['cdn.discordapp.com', 'media.discordapp.net'];
        if (!allowedHosts.includes(hostname)) {
            return url; // Fallback to raw URL unresolved
        }

        // SSRF check
        if (!await isSafeUrl(url)) {
            safeError(`Refusing to fetch unsafe URL: ${url}`);
            return url;
        }

        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
            if (!response.ok) {
                safeError(`Failed to download image: ${response.status} ${response.statusText} from ${url}`);
                return url; // Fallback to original URL
            }

            const contentLength = response.headers.get('content-length');
            const maxBytes = 10 * 1024 * 1024; // 10MB cap

            if (contentLength) {
                const size = parseInt(contentLength, 10);
                if (isNaN(size) || size > maxBytes) {
                    safeError(`Image size limit exceeded or invalid content-length: ${contentLength} from ${url}`);
                    return url;
                }
            }

            let buffer;
            if (response.body && typeof response.body.getReader === 'function') {
                const reader = response.body.getReader();
                const chunks = [];
                let totalLength = 0;
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        totalLength += value.length;
                        if (totalLength > maxBytes) {
                            await reader.cancel();
                            safeError(`Image size limit exceeded during stream from ${url}`);
                            return url;
                        }
                        chunks.push(value);
                    }
                } finally {
                    reader.releaseLock();
                }
                buffer = Buffer.concat(chunks);
            } else {
                // Fallback for mock/test fetch where response.body is not a web stream
                const arrayBuffer = await response.arrayBuffer();
                if (arrayBuffer.byteLength > maxBytes) {
                    safeError(`Image size limit exceeded: ${url}`);
                    return url;
                }
                buffer = Buffer.from(arrayBuffer);
            }

            const contentType = getImageMimeType(url, response.headers?.get?.('content-type'));
            return `data:${contentType};base64,${buffer.toString('base64')}`;
        } catch (fetchErr) {
            safeError(`Fetch error downloading image from ${url}:`, fetchErr);
            return url;
        }
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
                    // A link whose signature has already lapsed is dead for
                    // everyone; carrying it forward only pays vision-model
                    // rates to show the model nothing.
                    if (isExpiredDiscordUrl(part.image_url.url)) continue;

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
            // An image-only turn whose image has expired has nothing left to
            // say. Sending an empty content array is an API error, so the turn
            // is dropped — the same way parseimgs already drops empty ones.
            if (newContent.length === 0) continue;
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
    
    let finalParsedText = parsedText;
    if (role === 'user' && message.author && parsedText && parsedText.trim() !== '') {
        const name = message.member?.displayName || message.author.displayName || message.author.username;
        if (name) {
            finalParsedText = `${name}: ${parsedText}`;
        }
    }

    const content = formatContent(finalParsedText, imageUrls);
    
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

module.exports = {
    isImageUrl,
    isExpiredDiscordUrl,
    parseTextAndImages,
    formatContent,
    parseDiscordMessage,
    parseimgs,
    resolveImageUrlsToBase64,
};
