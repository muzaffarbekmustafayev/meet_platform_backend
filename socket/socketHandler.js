const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const Meeting = require('../models/meetingModel');
const Message = require('../models/messageModel');
const User = require('../models/userModel');
const { getAllowedOrigins } = require('../config/env');

const CHAT_RATE_WINDOW_MS = 10 * 1000;
const CHAT_RATE_MAX = 15;
const MAX_MESSAGE_LEN = 2000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ADMITTED_TTL_MS = 6 * 60 * 60 * 1000;

const socketHandler = (server, opts = {}) => {
    const allowedOrigins = opts.allowedOrigins || getAllowedOrigins();

    const io = new Server(server, {
        cors: {
            origin: allowedOrigins,
            methods: ['GET', 'POST'],
            credentials: true
        }
    });

    const users = {};
    const socketToRoom = {};
    const sharingUser = {};
    const blockedUsers = {};
    const waitingRoom = {};
    const admittedUsers = {};   // roomId -> Map<userId, timestamp>
    const chatRate = new Map(); // socketId -> [timestamps]

    const cleanupAdmitted = () => {
        const now = Date.now();
        for (const room of Object.keys(admittedUsers)) {
            const map = admittedUsers[room];
            for (const [userId, ts] of map.entries()) {
                if (now - ts > ADMITTED_TTL_MS) map.delete(userId);
            }
            if (map.size === 0) delete admittedUsers[room];
        }
    };
    setInterval(cleanupAdmitted, 30 * 60 * 1000).unref();

    function isModerator(roomId, socketId) {
        const u = users[roomId]?.find(x => x.socketId === socketId);
        return !!u && (u.role === 'host' || u.role === 'cohost');
    }
    function isHost(roomId, socketId) {
        const u = users[roomId]?.find(x => x.socketId === socketId);
        return !!u && u.role === 'host';
    }

    function getRoomRole(meeting, userId, isGuest) {
        if (isGuest) return 'guest';
        if (!meeting) return 'participant';
        if (String(meeting.hostId) === String(userId) ||
            (meeting.hostId?._id && String(meeting.hostId._id) === String(userId))) return 'host';
        const coHostIds = (meeting.coHosts || []).map(id => String(id._id || id));
        if (coHostIds.includes(String(userId))) return 'cohost';
        return 'participant';
    }

    function broadcastWaitingRoom(roomId) {
        if (!users[roomId]) return;
        users[roomId]
            .filter(u => u.role === 'host' || u.role === 'cohost')
            .forEach(u => io.to(u.socketId).emit('waiting-room-update', waitingRoom[roomId] || []));
    }

    function handleUserLeaving(socket, roomID) {
        if (!roomID) return;
        if (waitingRoom[roomID]) {
            waitingRoom[roomID] = waitingRoom[roomID].filter(u => u.socketId !== socket.id);
            broadcastWaitingRoom(roomID);
        }
        let room = users[roomID];
        if (room) {
            room = room.filter(u => u.socketId !== socket.id);
            users[roomID] = room;
            if (room.length === 0) delete users[roomID];
            else io.to(roomID).emit('update-user-list', users[roomID]);
        }
        socket.to(roomID).emit('user-disconnected', socket.id);
        delete socketToRoom[socket.id];
        chatRate.delete(socket.id);
    }

    function checkChatRate(socketId) {
        const now = Date.now();
        const arr = (chatRate.get(socketId) || []).filter(t => now - t < CHAT_RATE_WINDOW_MS);
        if (arr.length >= CHAT_RATE_MAX) {
            chatRate.set(socketId, arr);
            return false;
        }
        arr.push(now);
        chatRate.set(socketId, arr);
        return true;
    }

    function safeOn(socket, event, handler) {
        socket.on(event, async (...args) => {
            try {
                await handler(...args);
            } catch (err) {
                console.error(`[socket ${event}] error:`, err.message);
                socket.emit('socket-error', { event, message: 'Server error' });
            }
        });
    }

    // Optional auth — attaches socket.authUserId if a valid token is provided.
    io.use(async (socket, next) => {
        const token = socket.handshake.auth?.token || socket.handshake.query?.token;
        if (!token) return next();
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            const user = await User.findById(decoded.id).select('_id role isBlocked');
            if (user && !user.isBlocked) {
                socket.authUserId = String(user._id);
                socket.authRole = user.role;
            }
        } catch (_) { /* ignore — fall through unauthenticated */ }
        next();
    });

    io.on('connection', (socket) => {
        async function admitUser(socket, roomID, userId, userName, role, meeting) {
            // Kick old socket if same user is reconnecting
            if (users[roomID]) {
                const existing = users[roomID].find(u => u.userId === userId && u.socketId !== socket.id);
                if (existing) {
                    const oldSocket = io.sockets.sockets.get(existing.socketId);
                    if (oldSocket) {
                        oldSocket.leave(roomID);
                        oldSocket.disconnect(true);
                    }
                    // Tell everyone the old socket disconnected BEFORE the new one joins
                    socket.to(roomID).emit('user-disconnected', existing.socketId);
                    delete socketToRoom[existing.socketId];
                    chatRate.delete(existing.socketId);
                    if (waitingRoom[roomID]) {
                        waitingRoom[roomID] = waitingRoom[roomID].filter(u => u.socketId !== existing.socketId);
                    }
                }
                users[roomID] = users[roomID].filter(u => u.userId !== userId);
            }

            socket.join(roomID);
            socketToRoom[socket.id] = roomID;

            if (!admittedUsers[roomID]) admittedUsers[roomID] = new Map();
            admittedUsers[roomID].set(userId, Date.now());

            // Client haqiqiy holatini keyinroq 'update-media-status' orqali yuboradi
            const userData = { socketId: socket.id, userId, userName, micStatus: false, videoStatus: false, role };
            if (users[roomID]) users[roomID].push(userData);
            else users[roomID] = [userData];

            socket.emit('your-role', { role });
            const usersInThisRoom = users[roomID].filter(u => u.socketId !== socket.id);
            socket.emit('all-users', usersInThisRoom);
            io.to(roomID).emit('update-user-list', users[roomID]);

            if (sharingUser[roomID]) {
                socket.emit('screen-sharing-started', {
                    socketId: sharingUser[roomID].socketId,
                    userId: sharingUser[roomID].userId,
                    userName: sharingUser[roomID].userName,
                    role: sharingUser[roomID].role
                });
            }

            const prevMessages = await Message.find({ meetingId: roomID })
                .sort({ createdAt: 1 })
                .limit(50);
            socket.emit('previous-messages', prevMessages);
        }

        safeOn(socket, 'join-room', async (roomID, userId, userName, isGuest, password) => {
            if (!roomID || !userId) return;
            // If authenticated, ignore client-supplied userId — use the verified one.
            if (socket.authUserId && !isGuest) userId = socket.authUserId;

            const meeting = await Meeting.findOne({ meetingCode: roomID, deletedAt: null }).select('+password').populate('hostId', 'name');
            if (!meeting) {
                socket.emit('room-not-found');
                return;
            }

            // Validate password for private rooms (with rate limiting)
            if (meeting.roomType === 'private') {
                const clientIp = socket.handshake.address || 'unknown';
                const { checkSocketAttempt, recordSocketFailure, clearSocketAttempts } = require('../middleware/rateLimiters');
                const check = checkSocketAttempt(clientIp, roomID);
                if (!check.allowed) {
                    socket.emit('error', {
                        message: `Too many password attempts. Try again in ${check.retryAfter} seconds.`,
                        retryAfter: check.retryAfter
                    });
                    return;
                }

                if (!password) {
                    socket.emit('error', { message: 'Password required for private room' });
                    return;
                }
                try {
                    const passwordMatch = await meeting.matchPassword(String(password));
                    if (!passwordMatch) {
                        recordSocketFailure(clientIp, roomID);
                        socket.emit('error', { message: 'Invalid room password' });
                        return;
                    }
                    // Successful — clear failure count
                    clearSocketAttempts(clientIp, roomID);
                } catch (err) {
                    socket.emit('error', { message: 'Password validation failed' });
                    return;
                }
            }

            const role = getRoomRole(meeting, userId, isGuest);

            if (blockedUsers[roomID]?.has(userId)) {
                socket.emit('blocked');
                return;
            }

            await admitUser(socket, roomID, userId, userName, role, meeting);
        });

        safeOn(socket, 'admit-user', async ({ roomId, targetSocketId }) => {
            if (!isModerator(roomId, socket.id)) return;
            if (!waitingRoom[roomId]) return;
            const userToAdmit = waitingRoom[roomId].find(u => u.socketId === targetSocketId);
            if (!userToAdmit) return;
            waitingRoom[roomId] = waitingRoom[roomId].filter(u => u.socketId !== targetSocketId);
            const meeting = await Meeting.findOne({ meetingCode: roomId, deletedAt: null });
            const role = getRoomRole(meeting, userToAdmit.userId, userToAdmit.isGuest);
            const targetSocket = io.sockets.sockets.get(targetSocketId);
            if (targetSocket) {
                await admitUser(targetSocket, roomId, userToAdmit.userId, userToAdmit.userName, role, meeting);
            }
            broadcastWaitingRoom(roomId);
        });

        safeOn(socket, 'deny-user', ({ roomId, targetSocketId }) => {
            if (!isModerator(roomId, socket.id)) return;
            if (!waitingRoom[roomId]) return;
            waitingRoom[roomId] = waitingRoom[roomId].filter(u => u.socketId !== targetSocketId);
            io.to(targetSocketId).emit('waiting-room-denied');
            broadcastWaitingRoom(roomId);
        });

        safeOn(socket, 'sending-signal', payload => {
            if (!payload?.userToSignal) return;
            io.to(payload.userToSignal).emit('user-joined', {
                signal: payload.signal, callerID: payload.callerID, callerUserId: payload.callerUserId
            });
        });

        safeOn(socket, 'returning-signal', payload => {
            if (!payload?.callerID) return;
            io.to(payload.callerID).emit('receiving-returned-signal', {
                signal: payload.signal, id: socket.id
            });
        });

        safeOn(socket, 'chat-message', async ({ roomId, message, userName, userId }) => {
            if (!roomId || typeof message !== 'string') return;
            const text = message.trim();
            if (!text || text.length > MAX_MESSAGE_LEN) return;
            if (!checkChatRate(socket.id)) {
                socket.emit('socket-error', { event: 'chat-message', message: 'Rate limit exceeded' });
                return;
            }
            const senderUser = users[roomId]?.find(u => u.socketId === socket.id);
            if (!senderUser) return;
            const senderId = socket.authUserId || userId || socket.id;

            const newMessage = await Message.create({
                meetingId: roomId,
                senderId,
                senderName: senderUser.userName || userName,
                text
            });

            io.to(roomId).emit('chat-message', {
                _id: newMessage._id,
                text,
                userName: senderUser.userName || userName,
                senderId,
                time: new Date().toLocaleTimeString()
            });
        });

        safeOn(socket, 'edit-chat-message', async ({ roomId, messageId, newText, userId }) => {
            if (!messageId || typeof newText !== 'string') return;
            const trimmed = newText.trim();
            if (!trimmed || trimmed.length > MAX_MESSAGE_LEN) return;
            const message = await Message.findById(messageId);
            if (!message) return;
            const myId = socket.authUserId || userId || socket.id;
            if (String(message.senderId) !== String(myId)) return;
            message.text = trimmed;
            await message.save();
            io.to(roomId).emit('chat-message-edited', { _id: messageId, newText: trimmed });
        });

        safeOn(socket, 'delete-chat-message', async ({ roomId, messageId, userId }) => {
            if (!messageId) return;
            const message = await Message.findById(messageId);
            if (!message) return;
            const myId = socket.authUserId || userId || socket.id;
            const moderator = isModerator(roomId, socket.id);
            if (String(message.senderId) !== String(myId) && !moderator) return;
            await message.deleteOne();
            io.to(roomId).emit('chat-message-deleted', { _id: messageId });
        });

        safeOn(socket, 'start-screen-share', ({ roomId, userId, userName, role }) => {
            const me = users[roomId]?.find(u => u.socketId === socket.id);
            if (!me) return;
            sharingUser[roomId] = { socketId: socket.id, userId: me.userId, userName: me.userName, role: me.role };
            socket.to(roomId).emit('screen-sharing-started', sharingUser[roomId]);
        });

        safeOn(socket, 'stop-screen-share', ({ roomId }) => {
            if (sharingUser[roomId] && sharingUser[roomId].socketId !== socket.id && !isModerator(roomId, socket.id)) return;
            delete sharingUser[roomId];
            socket.to(roomId).emit('screen-sharing-stopped');
        });

        safeOn(socket, 'hand-raise', ({ roomId, userId, userName }) => {
            socket.to(roomId).emit('user-hand-raised', { userId, userName });
        });

        safeOn(socket, 'give-turn', ({ roomId, targetUserId }) => {
            if (!isModerator(roomId, socket.id)) return;
            io.to(roomId).emit('turn-updated', { userId: targetUserId });
        });

        safeOn(socket, 'mute-all', ({ roomId }) => {
            if (!isModerator(roomId, socket.id)) return;
            socket.to(roomId).emit('room-muted-all');
        });

        safeOn(socket, 'update-media-status', ({ roomId, micStatus, videoStatus }) => {
            if (!users[roomId]) return;
            const user = users[roomId].find(u => u.socketId === socket.id);
            if (!user) return;
            if (micStatus !== undefined) user.micStatus = micStatus;
            if (videoStatus !== undefined) user.videoStatus = videoStatus;
            io.to(roomId).emit('update-user-list', users[roomId]);
        });

        safeOn(socket, 'block-user', ({ roomId, targetUserId, targetSocketId }) => {
            if (!isModerator(roomId, socket.id)) return;
            io.to(targetSocketId).emit('blocked');
            if (!blockedUsers[roomId]) blockedUsers[roomId] = new Set();
            blockedUsers[roomId].add(targetUserId);
            if (users[roomId]) {
                users[roomId] = users[roomId].filter(u => u.socketId !== targetSocketId);
                io.to(roomId).emit('update-user-list', users[roomId]);
            }
        });

        safeOn(socket, 'file-message', async ({ roomId, userId, userName, file }) => {
            if (!roomId || !file || !file.data) return;
            const senderUser = users[roomId]?.find(u => u.socketId === socket.id);
            if (!senderUser) return;
            const approxBytes = typeof file.data === 'string'
                ? Math.floor(file.data.length * 3 / 4)
                : 0;
            if (approxBytes > MAX_FILE_BYTES) {
                socket.emit('socket-error', { event: 'file-message', message: 'File too large' });
                return;
            }
            if (!checkChatRate(socket.id)) {
                socket.emit('socket-error', { event: 'file-message', message: 'Rate limit exceeded' });
                return;
            }
            io.to(roomId).emit('chat-message', {
                userName: senderUser.userName || userName,
                senderId: socket.authUserId || userId || socket.id,
                file,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
        });

        safeOn(socket, 'request-to-share', ({ roomId, hostId, userId, userName, type }) => {
            if (!users[roomId]) return;
            const moderators = users[roomId].filter(u => u.role === 'host' || u.role === 'cohost');
            moderators.forEach(mod => {
                io.to(mod.socketId).emit('share-request-received', {
                    userId, userName, type, requesterSocketId: socket.id
                });
            });
        });

        safeOn(socket, 'share-permission-response', ({ userId, approved, type }) => {
            const roomId = socketToRoom[socket.id];
            if (!isModerator(roomId, socket.id)) return;
            io.to(userId).emit('share-request-result', { approved, type });
        });

        safeOn(socket, 'force-stop-share', ({ roomId, targetSocketId }) => {
            if (!isModerator(roomId, socket.id)) return;
            io.to(targetSocketId).emit('force-stop-share');
        });

        safeOn(socket, 'reconnect-room', async (roomID, userId, userName, isGuest) => {
            if (!roomID || !userId) return;
            if (socket.authUserId && !isGuest) userId = socket.authUserId;

            const meeting = await Meeting.findOne({ meetingCode: roomID, deletedAt: null }).populate('hostId', 'name');
            if (!meeting) { socket.emit('room-not-found'); return; }

            const role = getRoomRole(meeting, userId, isGuest);
            if (blockedUsers[roomID]?.has(userId)) { socket.emit('blocked'); return; }

            // For reconnect: skip waiting room entirely (user was already in room)
            await admitUser(socket, roomID, userId, userName, role, meeting);
        });

        safeOn(socket, 'disconnect', () => {
            const roomID = socketToRoom[socket.id];
            handleUserLeaving(socket, roomID);
        });

        safeOn(socket, 'leave-room', () => {
            const roomID = socketToRoom[socket.id];
            handleUserLeaving(socket, roomID);
            if (roomID) socket.leave(roomID);
        });

        safeOn(socket, 'end-meeting', ({ roomId }) => {
            if (!isHost(roomId, socket.id)) return;
            io.to(roomId).emit('meeting-ended');
            delete users[roomId];
            delete sharingUser[roomId];
            delete waitingRoom[roomId];
            delete admittedUsers[roomId];
            delete blockedUsers[roomId];
        });

        safeOn(socket, 'kick-user', ({ roomId, targetSocketId, targetUserId }) => {
            if (!isModerator(roomId, socket.id)) return;
            io.to(targetSocketId).emit('kicked');
            if (users[roomId]) {
                users[roomId] = users[roomId].filter(u => u.socketId !== targetSocketId);
                io.to(roomId).emit('update-user-list', users[roomId]);
            }
        });

        safeOn(socket, 'promote-cohost', ({ roomId, targetUserId, targetSocketId }) => {
            if (!isHost(roomId, socket.id)) return;
            if (!users[roomId]) return;
            const user = users[roomId].find(u => u.socketId === targetSocketId);
            if (!user) return;
            user.role = 'cohost';
            io.to(targetSocketId).emit('role-updated', { role: 'cohost' });
            io.to(roomId).emit('update-user-list', users[roomId]);
        });

        safeOn(socket, 'demote-cohost', ({ roomId, targetUserId, targetSocketId }) => {
            if (!isHost(roomId, socket.id)) return;
            if (!users[roomId]) return;
            const user = users[roomId].find(u => u.socketId === targetSocketId);
            if (!user) return;
            user.role = 'participant';
            io.to(targetSocketId).emit('role-updated', { role: 'participant' });
            io.to(roomId).emit('update-user-list', users[roomId]);
        });
    });
};

module.exports = socketHandler;
