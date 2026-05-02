const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const connectDB = require('./config/db');
const userRoutes = require('./routes/userRoutes');
const meetingRoutes = require('./routes/meetingRoutes');
const Message = require('./models/messageModel');
const Meeting = require('./models/meetingModel');

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

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST"],
        credentials: true
    }
});

// In-memory state
const users = {};             // roomID -> [{ socketId, userId, userName, micStatus, videoStatus, role }]
const socketToRoom = {};      // socketId -> roomID
const sharingUser = {};       // roomID -> { userId, socketId, userName }
const blockedUsers = {};      // roomID -> Set of userIds
const waitingRoom = {};       // roomID -> [{ socketId, userId, userName, isGuest }]

// Determine a user's in-room role
function getRoomRole(meeting, userId, isGuest) {
    if (isGuest) return 'guest';
    if (!meeting) return 'participant';
    if (String(meeting.hostId) === String(userId) || (meeting.hostId?._id && String(meeting.hostId._id) === String(userId))) return 'host';
    const coHostIds = (meeting.coHosts || []).map(id => String(id._id || id));
    if (coHostIds.includes(String(userId))) return 'cohost';
    return 'participant';
}

io.on('connection', (socket) => {

    // ──────────────────────────────────────────────────────
    // JOIN ROOM  (registered users)
    // ──────────────────────────────────────────────────────
    socket.on('join-room', async (roomID, userID, userName, isGuest = false) => {
        try {
            if (blockedUsers[roomID] && blockedUsers[roomID].has(userID)) {
                socket.emit('error-message', 'You are blocked from this meeting.');
                return;
            }

            // Fetch meeting to check waiting-room setting & co-hosts
            let meeting = null;
            try {
                meeting = await Meeting.findOne({ meetingCode: roomID });
            } catch (e) { /* ignore, meeting may not exist yet */ }

            const role = getRoomRole(meeting, userID, isGuest);

            // Guests always go to waiting room.
            // Regular participants go to waiting room if the setting is enabled AND host isn't already in room.
            const hostInRoom = users[roomID] && users[roomID].some(u => u.role === 'host');
            const waitingEnabled = meeting?.settings?.isWaitingRoomEnabled !== false;

            if (role === 'guest' || (role === 'participant' && waitingEnabled && !hostInRoom)) {
                // Put them in waiting room
                if (!waitingRoom[roomID]) waitingRoom[roomID] = [];
                // Avoid duplicates
                if (!waitingRoom[roomID].find(u => u.socketId === socket.id)) {
                    waitingRoom[roomID].push({ socketId: socket.id, userId: userID, userName, isGuest });
                }
                socketToRoom[socket.id] = roomID;
                socket.emit('waiting-room', { message: 'Please wait, the host will admit you shortly.' });
                // Notify host/co-hosts
                if (users[roomID]) {
                    users[roomID].filter(u => u.role === 'host' || u.role === 'cohost').forEach(u => {
                        io.to(u.socketId).emit('waiting-room-update', waitingRoom[roomID]);
                    });
                }
                return;
            }

            // Join the room directly
            await admitUser(socket, roomID, userID, userName, role, meeting);
        } catch (error) {
            console.error("Error in join-room:", error);
        }
    });

    // ──────────────────────────────────────────────────────
    // ADMIT / DENY from waiting room (Host & Co-host)
    // ──────────────────────────────────────────────────────
    socket.on('admit-user', async ({ roomId, targetSocketId }) => {
        const waiting = waitingRoom[roomId];
        if (!waiting) return;
        const waiter = waiting.find(u => u.socketId === targetSocketId);
        if (!waiter) return;

        // Remove from waiting room
        waitingRoom[roomId] = waiting.filter(u => u.socketId !== targetSocketId);

        // Fetch meeting for role assignment
        let meeting = null;
        try { meeting = await Meeting.findOne({ meetingCode: roomId }); } catch (e) {}

        const role = getRoomRole(meeting, waiter.userId, waiter.isGuest);
        const targetSocket = io.sockets.sockets.get(targetSocketId);
        if (targetSocket) {
            await admitUser(targetSocket, roomId, waiter.userId, waiter.userName, role, meeting);
        }

        // Update waiting list for all host/cohosts
        broadcastWaitingRoom(roomId);
    });

    socket.on('deny-user', ({ roomId, targetSocketId }) => {
        waitingRoom[roomId] = (waitingRoom[roomId] || []).filter(u => u.socketId !== targetSocketId);
        io.to(targetSocketId).emit('waiting-room-denied', { message: 'The host did not admit you to this meeting.' });
        broadcastWaitingRoom(roomId);
    });

    // ──────────────────────────────────────────────────────
    // PROMOTE / DEMOTE CO-HOST  (Host only)
    // ──────────────────────────────────────────────────────
    socket.on('promote-cohost', ({ roomId, targetUserId, targetSocketId }) => {
        if (users[roomId]) {
            const actor = users[roomId].find(u => u.socketId === socket.id);
            if (!actor || actor.role !== 'host') return;
            const target = users[roomId].find(u => u.userId === targetUserId);
            if (target) {
                target.role = 'cohost';
                io.to(targetSocketId).emit('role-updated', { role: 'cohost' });
                io.to(roomId).emit('update-user-list', users[roomId]);
            }
        }
    });

    socket.on('demote-cohost', ({ roomId, targetUserId, targetSocketId }) => {
        if (users[roomId]) {
            const actor = users[roomId].find(u => u.socketId === socket.id);
            if (!actor || actor.role !== 'host') return;
            const target = users[roomId].find(u => u.userId === targetUserId);
            if (target) {
                target.role = 'participant';
                io.to(targetSocketId).emit('role-updated', { role: 'participant' });
                io.to(roomId).emit('update-user-list', users[roomId]);
            }
        }
    });

    // ──────────────────────────────────────────────────────
    // WEBRTC SIGNALING
    // ──────────────────────────────────────────────────────
    socket.on('sending-signal', (payload) => {
        io.to(payload.userToSignal).emit('user-joined', {
            signal: payload.signal,
            callerID: payload.callerID,
            callerUserId: payload.callerUserId
        });
    });

    socket.on('returning-signal', (payload) => {
        io.to(payload.callerID).emit('receiving-returned-signal', { signal: payload.signal, id: socket.id });
    });

    // ──────────────────────────────────────────────────────
    // CHAT  (guests cannot send)
    // ──────────────────────────────────────────────────────
    socket.on('chat-message', async (data) => {
        try {
            const { roomId, userId, userName, text } = data;

            // Block guests from chatting
            const roomID = socketToRoom[socket.id];
            const user = users[roomID]?.find(u => u.socketId === socket.id);
            if (user?.role === 'guest') {
                socket.emit('chat-blocked', { message: 'Guests cannot send messages.' });
                return;
            }

            let message;
            try {
                message = await Message.create({ meetingId: roomId, senderId: userId, senderName: userName, text });
            } catch (dbErr) {
                console.error("Database error saving message:", dbErr);
                message = { senderName: userName, text, createdAt: new Date() };
            }

            io.to(roomId).emit('message', {
                _id: message._id || Date.now(),
                userName: message.senderName || userName,
                text: message.text || text,
                time: new Date(message.createdAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
        } catch (error) {
            console.error("Error in chat-message:", error);
        }
    });

    socket.on('hand-raise', (data) => {
        io.to(data.roomId).emit('user-hand-raised', data.userId);
    });

    // ──────────────────────────────────────────────────────
    // SCREEN SHARE PERMISSIONS
    // ──────────────────────────────────────────────────────
    socket.on('request-screen-share', (data) => {
        const { roomId, userId, userName, hostId } = data;
        const room = users[roomId];
        if (room) {
            const host = room.find(u => u.userId === hostId);
            if (host) {
                io.to(host.socketId).emit('screen-share-request', { requesterId: userId, requesterName: userName, socketId: socket.id });
            }
        }
    });

    socket.on('screen-share-permission-response', (data) => {
        const { requesterSocketId, allowed } = data;
        io.to(requesterSocketId).emit('screen-share-permission-result', { allowed });
    });

    socket.on('start-screen-share', (data) => {
        const { roomId, userId, userName } = data;
        const user = users[roomId]?.find(u => u.socketId === socket.id);
        sharingUser[roomId] = { userId, userName, socketId: socket.id, role: user?.role || 'participant' };
        socket.to(roomId).emit('screen-sharing-started', sharingUser[roomId]);
    });

    socket.on('stop-screen-share', (data) => {
        const { roomId } = data;
        if (sharingUser[roomId] && sharingUser[roomId].socketId === socket.id) {
            delete sharingUser[roomId];
            io.to(roomId).emit('screen-sharing-stopped');
        }
    });

    // Request to share (Participant -> Host/Co-host)
    socket.on('request-to-share', ({ roomId, hostId, userId, userName, type }) => {
        // Find any host or cohost in the room and notify them
        if (users[roomId]) {
            users[roomId].filter(u => u.role === 'host' || u.role === 'cohost').forEach(u => {
                io.to(u.socketId).emit('share-request-received', { userId, userName, type, requesterSocketId: socket.id });
            });
        }
    });

    socket.on('share-permission-response', ({ userId, approved, type }) => {
        io.to(userId).emit('share-request-result', { approved, type });
    });

    // ──────────────────────────────────────────────────────
    // ROOM MANAGEMENT  (Host & Co-host)
    // ──────────────────────────────────────────────────────
    socket.on('kick-user', (data) => {
        const { roomId, targetSocketId } = data;
        const actor = users[roomId]?.find(u => u.socketId === socket.id);
        if (!actor || (actor.role !== 'host' && actor.role !== 'cohost')) return;
        console.log(`Kicking user ${targetSocketId} from room ${roomId}`);
        io.to(targetSocketId).emit('kicked');
    });

    socket.on('block-user', ({ roomId, targetUserId, targetSocketId }) => {
        const actor = users[roomId]?.find(u => u.socketId === socket.id);
        if (!actor || (actor.role !== 'host' && actor.role !== 'cohost')) return;
        console.log(`Blocking user ${targetUserId} from room ${roomId}`);
        if (!blockedUsers[roomId]) blockedUsers[roomId] = new Set();
        blockedUsers[roomId].add(targetUserId);
        io.to(targetSocketId).emit('blocked');
    });

    socket.on('give-turn', (data) => {
        const { roomId, targetUserId } = data;
        io.to(roomId).emit('turn-updated', { userId: targetUserId });
    });

    socket.on('update-media-status', (data) => {
        const { roomId, micStatus, videoStatus } = data;
        if (users[roomId]) {
            const user = users[roomId].find(u => u.socketId === socket.id);
            if (user) {
                if (micStatus !== undefined) user.micStatus = micStatus;
                if (videoStatus !== undefined) user.videoStatus = videoStatus;
                io.to(roomId).emit('update-user-list', users[roomId]);
            }
        }
    });

    // Mute all — host AND co-host can do this
    socket.on('mute-all', (data) => {
        const { roomId } = data;
        const actor = users[roomId]?.find(u => u.socketId === socket.id);
        if (!actor || (actor.role !== 'host' && actor.role !== 'cohost')) return;
        io.to(roomId).emit('room-muted-all');
    });

    // End meeting — host only
    socket.on('end-meeting', (data) => {
        const { roomId } = data;
        const actor = users[roomId]?.find(u => u.socketId === socket.id);
        if (!actor || actor.role !== 'host') return;
        io.to(roomId).emit('meeting-ended');
    });

    // ──────────────────────────────────────────────────────
    // FILE SHARING
    // ──────────────────────────────────────────────────────
    socket.on('file-message', async (data) => {
        try {
            const { roomId, userId, userName, file } = data;
            const user = users[roomId]?.find(u => u.socketId === socket.id);
            if (user?.role === 'guest') return; // guests cannot share files
            io.to(roomId).emit('message', {
                _id: Date.now(),
                userName,
                text: `Sent a file: ${file.name}`,
                file,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
        } catch (error) {
            console.error("Error in file-message:", error);
        }
    });

    // ──────────────────────────────────────────────────────
    // DISCONNECT
    // ──────────────────────────────────────────────────────
    socket.on('leave-room', () => {
        const roomID = socketToRoom[socket.id];
        if (roomID) handleUserLeaving(socket, roomID);
    });

    socket.on('disconnect', () => {
        const roomID = socketToRoom[socket.id];
        if (roomID) handleUserLeaving(socket, roomID);
    });
});

// ──────────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────────
async function admitUser(socket, roomID, userID, userName, role, meeting) {
    socket.join(roomID);

    const userObj = {
        socketId: socket.id,
        userId: userID,
        userName: userName || 'Guest',
        micStatus: true,
        videoStatus: true,
        role
    };

    if (users[roomID]) {
        if (users[roomID].length >= 50) { socket.emit('room-full'); return; }
        // Deduplicate by userId: remove old entry for same user if exists
        users[roomID] = users[roomID].filter(u => String(u.userId) !== String(userID));
        users[roomID].push(userObj);
    } else {
        users[roomID] = [userObj];
    }

    socketToRoom[socket.id] = roomID;

    const usersInThisRoom = users[roomID]
        .filter(u => u.socketId !== socket.id)
        .map(u => ({ socketId: u.socketId, userId: u.userId }));
    socket.emit('all-users', usersInThisRoom);

    // Send role to the joining user
    socket.emit('your-role', { role });

    // Send current sharing status
    if (sharingUser[roomID]) socket.emit('screen-sharing-started', sharingUser[roomID]);

    // Broadcast updated user list
    io.to(roomID).emit('update-user-list', users[roomID]);

    // Notify host/cohosts of current waiting room
    if (role === 'host' || role === 'cohost') {
        socket.emit('waiting-room-update', waitingRoom[roomID] || []);
    }

    // Send previous messages
    try {
        const previousMessages = await Message.find({ meetingId: roomID }).sort({ createdAt: 1 }).limit(50);
        socket.emit('previous-messages', previousMessages);
    } catch (err) {
        console.error("Error fetching previous messages:", err);
        socket.emit('previous-messages', []);
    }
}

function broadcastWaitingRoom(roomId) {
    if (users[roomId]) {
        users[roomId].filter(u => u.role === 'host' || u.role === 'cohost').forEach(u => {
            io.to(u.socketId).emit('waiting-room-update', waitingRoom[roomId] || []);
        });
    }
}

function handleUserLeaving(socket, roomID) {
    // Remove from waiting room if they were there
    if (waitingRoom[roomID]) {
        waitingRoom[roomID] = waitingRoom[roomID].filter(u => u.socketId !== socket.id);
        broadcastWaitingRoom(roomID);
    }

    let room = users[roomID];
    if (room) {
        room = room.filter(u => u.socketId !== socket.id);
        users[roomID] = room;
        if (room.length === 0) {
            delete users[roomID];
        } else {
            io.to(roomID).emit('update-user-list', users[roomID]);
        }
    }
    socket.to(roomID).emit('user-disconnected', socket.id);
    delete socketToRoom[socket.id];
}

const PORT = process.env.PORT || 5000;
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
