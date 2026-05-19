const requiredVars = ['JWT_SECRET'];

const validateEnv = () => {
    const missing = requiredVars.filter(v => !process.env[v]);
    if (missing.length) {
        console.error(`FATAL: Missing required env vars: ${missing.join(', ')}`);
        process.exit(1);
    }

    if (!process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID === 'your_google_client_id_here') {
        console.warn('WARN: GOOGLE_CLIENT_ID is not set — Google OAuth will be unavailable');
    }

    if (process.env.NODE_ENV === 'production') {
        if (!process.env.MONGO_URI) {
            console.error('FATAL: MONGO_URI is required in production');
            process.exit(1);
        }
        if (process.env.JWT_SECRET.length < 32) {
            console.error('FATAL: JWT_SECRET must be at least 32 chars in production');
            process.exit(1);
        }
        if (/super_secret|change_me|dev_only|12345/i.test(process.env.JWT_SECRET)) {
            console.error('FATAL: JWT_SECRET looks like a default/example value');
            process.exit(1);
        }
        if (!process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID === 'your_google_client_id_here') {
            console.error('FATAL: GOOGLE_CLIENT_ID is required in production');
            process.exit(1);
        }
    }
};

const getAllowedOrigins = () => {
    const raw = process.env.ALLOWED_ORIGINS;
    if (raw) return raw.split(',').map(s => s.trim()).filter(Boolean);
    return [
        'http://localhost:5173',
        'http://localhost:3000',
        'http://zoom.sampc.uz',
        'https://zoom.sampc.uz'
    ];
};

module.exports = { validateEnv, getAllowedOrigins };
