const rateLimit = require('express-rate-limit');

const isProd = process.env.NODE_ENV === 'production';

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: isProd ? 10 : 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many attempts, please try again later' }
});

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: isProd ? 120 : 1000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many requests, please slow down' }
});

const passwordResetLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: isProd ? 5 : 50,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many password reset attempts' }
});

// Per-room password attempt limiter: 5 attempts per 5 minutes per IP+roomCode
const roomPasswordLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: isProd ? 5 : 50,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const code = req.params.code || '';
        return `${req.ip}-${code}`;
    },
    skip: (req) => {
        // Skip rate limit if no password provided (will be handled elsewhere)
        return !req.query.password && !(req.body && req.body.password);
    },
    message: { message: 'Too many password attempts. Try again in 5 minutes.', retryAfter: 300 }
});

// Socket.io in-memory attempt tracker (no Redis needed)
const socketAttempts = new Map(); // key: `ip-roomCode`, value: { count, resetAt }

const checkSocketAttempt = (ip, roomCode) => {
    const key = `${ip}-${roomCode}`;
    const now = Date.now();
    const entry = socketAttempts.get(key);

    if (entry && entry.resetAt > now) {
        if (entry.count >= 5) {
            return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
        }
    } else {
        // Reset or new entry
        socketAttempts.set(key, { count: 0, resetAt: now + 5 * 60 * 1000 });
    }
    return { allowed: true };
};

const recordSocketFailure = (ip, roomCode) => {
    const key = `${ip}-${roomCode}`;
    const now = Date.now();
    const entry = socketAttempts.get(key);
    if (entry && entry.resetAt > now) {
        entry.count++;
    } else {
        socketAttempts.set(key, { count: 1, resetAt: now + 5 * 60 * 1000 });
    }
};

const clearSocketAttempts = (ip, roomCode) => {
    socketAttempts.delete(`${ip}-${roomCode}`);
};

// Cleanup old entries every 10 minutes
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of socketAttempts.entries()) {
        if (entry.resetAt <= now) socketAttempts.delete(key);
    }
}, 10 * 60 * 1000);

module.exports = {
    authLimiter,
    apiLimiter,
    passwordResetLimiter,
    roomPasswordLimiter,
    checkSocketAttempt,
    recordSocketFailure,
    clearSocketAttempts
};
