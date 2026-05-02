const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const http = require('http');
const connectDB = require('./config/db');
const userRoutes = require('./routes/userRoutes');
const meetingRoutes = require('./routes/meetingRoutes');
const adminRoutes = require('./routes/adminRoutes');
const socketHandler = require('./socket/socketHandler');

dotenv.config();
connectDB();

const app = express();
app.use(express.json());

const allowedOrigins = [
    'http://localhost:5173',
    'http://localhost:3000',
    'http://zoom.sampc.uz',
    'https://zoom.sampc.uz'
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use('/api/users', userRoutes);
app.use('/api/meetings', meetingRoutes);
app.use('/api/admin', adminRoutes);

const server = http.createServer(app);

// Initialize Socket.io
socketHandler(server);

const PORT = process.env.PORT || 5005;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    
    // Log all routes with a small delay to ensure initialization
    setTimeout(() => {
        console.log("\n--- REGISTERED ROUTES ---");
        function printRoutes(stack, prefix = '') {
            stack.forEach((middleware) => {
                if (middleware.route) { // Basic route
                    const methods = Object.keys(middleware.route.methods).join(',').toUpperCase();
                    console.log(`${methods.padEnd(7)} ${prefix}${middleware.route.path}`);
                } else if (middleware.name === 'router') { // Router middleware
                    const newPrefix = prefix + (middleware.regexp.source
                        .replace('\\/?(?=\\/|$)', '')
                        .replace('^\\', '')
                        .replace('\\/', '/'));
                    printRoutes(middleware.handle.stack, newPrefix);
                }
            });
        }

        if (app._router && app._router.stack) {
            printRoutes(app._router.stack);
        }
        console.log("-------------------------\n");
    }, 100);
});
