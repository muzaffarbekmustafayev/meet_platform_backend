const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const Meeting = require('../models/meetingModel');
const Message = require('../models/messageModel');
const User = require('../models/userModel');
const { getAllowedOrigins } = require('../config/env');
const { checkSocketAttempt, recordSocketFailure, clearSocketAttempts } = require('../middleware/rateLimiters');

const CHAT_RATE_WINDOW_MS = 10 * 1000;
const CHAT_RATE_MAX = 15;
const MAX_MESSAGE_LEN = 2000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ADMITTED_TTL_MS = 6 * 60 * 60 * 1000;

const socketHandler = (server, opts = {}) => {
    const allowedOrigins = opts.allowedOrigins || getAllowedOrigins();

    const io = new Server(server, {
        // Fayllar base64 ko'rinishida yuboriladi — 5MB fayl ~6.7MB bo'ladi.
        // Default 1MB chegara fayl yuborishni bloklaydi, shuning uchun oshiramiz.
        maxHttpBufferSize: 8 * 1024 * 1024,
        cors: {
            origin: allowedOrigins,
            methods: ['GET', 'POST'],
            credentials: true
        }
    });

    // roomId → [{ socketId, userId, userName, micStatus, videoStatus, role }]
    const users = {};
    // socketId → roomId
    const socketToRoom = {};
    // roomId → { socketId, userId, userName, role }
    const sharingUser = {};
    // roomId → Set<userId>
    const blockedUsers = {};
    // roomId → [{ socketId, userId, userName }]
    const waitingRoom = {};
    // roomId → Map<userId, timestamp>  (survives reconnect within TTL)
    const admittedUsers = {};
    // roomId → Set<socketId> — moderator tomonidan demonstratsiyaga ruxsat berilganlar
    const approvedSharers = {};
    // socketId → [timestamps]
    const chatRate = new Map();
    // roomId → { isChatEnabled, isWaitingRoomEnabled, muteAllOnEntry, allowScreenSharing }
    // Xona sozlamalari xotirada (har chat/share'da DB'ga bormaslik uchun). admitUser'da
    // DB'dan to'ldiriladi, host jonli o'zgartirsa yangilanadi.
    const roomSettings = {};

    const DEFAULT_SETTINGS = {
        isChatEnabled: true,
        isWaitingRoomEnabled: false,
        muteAllOnEntry: false,
        allowScreenSharing: true
    };

    // Mongoose subdoc yoki oddiy obyektdan xavfsiz, to'liq sozlama obyekti yasaymiz.
    function normalizeSettings(raw) {
        const s = raw && typeof raw === 'object' ? (raw.toObject ? raw.toObject() : raw) : {};
        return {
            isChatEnabled:        typeof s.isChatEnabled === 'boolean' ? s.isChatEnabled : DEFAULT_SETTINGS.isChatEnabled,
            isWaitingRoomEnabled: typeof s.isWaitingRoomEnabled === 'boolean' ? s.isWaitingRoomEnabled : DEFAULT_SETTINGS.isWaitingRoomEnabled,
            muteAllOnEntry:       typeof s.muteAllOnEntry === 'boolean' ? s.muteAllOnEntry : DEFAULT_SETTINGS.muteAllOnEntry,
            allowScreenSharing:   typeof s.allowScreenSharing === 'boolean' ? s.allowScreenSharing : DEFAULT_SETTINGS.allowScreenSharing
        };
    }

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

    function getRoomRole(meeting, userId) {
        if (!meeting) return 'participant';
        const hostId = meeting.hostId?._id ? String(meeting.hostId._id) : String(meeting.hostId);
        if (hostId === String(userId)) return 'host';
        const coHostIds = (meeting.coHosts || []).map(id => String(id._id || id));
        if (coHostIds.includes(String(userId))) return 'cohost';
        return 'participant';
    }

    // Rollarni DB (yagona haqiqat manbai) bilan moslaymiz: yaratuvchi=host doim,
    // DB coHosts=cohost, qolgani=participant. Har kim qo'shilganda/promotion bo'lganda
    // chaqiriladi — xotiradagi rol hech qachon DB'dan ajralib qolmaydi, shuning uchun
    // rollar "almashib" yoki "ishlamay" qolmaydi.
    function syncRolesFromMeeting(roomId, meeting) {
        const room = users[roomId];
        if (!room) return;
        for (const u of room) {
            const correct = getRoomRole(meeting, u.userId);
            if (u.role !== correct) {
                u.role = correct;
                io.to(u.socketId).emit('role-updated', { role: correct });
            }
        }
        io.to(roomId).emit('update-user-list', room);
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

            if (room.length === 0) {
                delete users[roomID];
                delete roomSettings[roomID];
            } else {
                // Rollarni KO'CHIRMAYMIZ. Rol — DB'ning sof proyeksiyasi: yaratuvchi
                // har doim host, coHosts — cohost, qolgani participant. Host vaqtincha
                // chiqib qaytsa, getRoomRole unga yana 'host' beradi. Tasodifiy a'zoga
                // moderator huquqini bermaymiz — bu rollarning "almashishi"ga sabab edi.
                io.to(roomID).emit('update-user-list', room);
            }
        }
        // Sharer left/disconnected → clear stale sharing state for the room
        if (sharingUser[roomID]?.socketId === socket.id) {
            delete sharingUser[roomID];
            socket.to(roomID).emit('screen-sharing-stopped');
        }
        approvedSharers[roomID]?.delete(socket.id);
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

    // Auth middleware — attaches socket.authUserId if a valid JWT is provided.
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
        } catch (_) { /* ignore unauthenticated */ }
        next();
    });

    io.on('connection', (socket) => {

        async function admitUser(socket, roomID, userId, userName, role, meeting, isReconnect = false) {
            // Kick old socket if same user reconnects
            if (users[roomID]) {
                const existing = users[roomID].find(u => u.userId === userId && u.socketId !== socket.id);
                if (existing) {
                    const oldSocket = io.sockets.sockets.get(existing.socketId);
                    if (oldSocket) {
                        oldSocket.leave(roomID);
                        oldSocket.disconnect(true);
                    }
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

            // Xona sozlamalarini DB'dan xotiraga olamiz (yagona joriy nusxa)
            roomSettings[roomID] = normalizeSettings(meeting?.settings);

            if (!admittedUsers[roomID]) admittedUsers[roomID] = new Map();
            admittedUsers[roomID].set(userId, Date.now());

            const userData = { socketId: socket.id, userId, userName, micStatus: false, videoStatus: false, role };
            if (users[roomID]) users[roomID].push(userData);
            else users[roomID] = [userData];

            // Xotiradagi barcha rollarni DB bilan moslab, hammaga tarqatamiz.
            // Joriy socket'ning ro'yxatdagi roli ham shu yerda DB bo'yicha aniqlanadi —
            // 'your-role'ni xotiradan o'qib yuboramiz (param bilan ajralib qolmaydi).
            syncRolesFromMeeting(roomID, meeting);

            const myRole = users[roomID].find(u => u.socketId === socket.id)?.role || role;
            socket.emit('your-role', { role: myRole });
            socket.emit('room-settings', roomSettings[roomID]);
            const usersInThisRoom = users[roomID].filter(u => u.socketId !== socket.id);
            socket.emit('all-users', usersInThisRoom);

            // Moderator endigina kirgan bo'lsa — joriy kutish xonasini unga uzatamiz
            if ((role === 'host' || role === 'cohost') && waitingRoom[roomID]?.length) {
                socket.emit('waiting-room-update', waitingRoom[roomID]);
            }

            // Mute-on-entry: muteAllOnEntry yoqilgan bo'lsa, yangi qo'shilgan ishtirokchi
            // mikrofon o'chiq kiradi. Moderator va reconnect ta'sirlanmaydi.
            if (!isReconnect && role === 'participant' && meeting?.settings?.muteAllOnEntry) {
                userData.micStatus = false;
                socket.emit('mute-on-entry');
            }

            if (sharingUser[roomID]) {
                socket.emit('screen-sharing-started', {
                    socketId: sharingUser[roomID].socketId,
                    userId: sharingUser[roomID].userId,
                    userName: sharingUser[roomID].userName,
                    role: sharingUser[roomID].role,
                    screenStreamId: sharingUser[roomID].screenStreamId || null
                });
            }

            const prevMessages = await Message.find({ meetingId: roomID })
                .sort({ createdAt: 1 })
                .limit(50);
            socket.emit('previous-messages', prevMessages);
        }

        // ── join-room ──────────────────────────────────────────────────────────
        safeOn(socket, 'join-room', async (roomID, userId, userName, password) => {
            if (!roomID || !userId) return;
            // Authenticated users: ignore client-supplied userId — use the verified one
            if (socket.authUserId) userId = socket.authUserId;

            const meeting = await Meeting.findOne({ meetingCode: roomID, deletedAt: null })
                .select('+password')
                .populate('hostId', 'name')
                .populate('coHosts', '_id');
            if (!meeting) {
                socket.emit('room-not-found');
                return;
            }

            // Password check for private rooms
            if (meeting.roomType === 'private') {
                const clientIp = socket.handshake.address || 'unknown';
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
                    const ok = await meeting.matchPassword(String(password));
                    if (!ok) {
                        recordSocketFailure(clientIp, roomID);
                        socket.emit('error', { message: 'Invalid room password' });
                        return;
                    }
                    clearSocketAttempts(clientIp, roomID);
                } catch {
                    socket.emit('error', { message: 'Password validation failed' });
                    return;
                }
            }

            const role = getRoomRole(meeting, userId);

            if (blockedUsers[roomID]?.has(userId)) {
                socket.emit('blocked');
                return;
            }

            // Ruxsat oqimi: FAQAT private xonada host tasdig'i kerak. Public xonaga
            // har doim to'g'ridan-to'g'ri kiriladi. Moderator (host/cohost) va ilgari
            // qabul qilingan foydalanuvchi (TTL ichida — reconnect) hech qachon kutmaydi.
            const isMod = role === 'host' || role === 'cohost';
            const alreadyAdmitted = admittedUsers[roomID]?.has(userId);
            const needsApproval = meeting.roomType === 'private' && !isMod && !alreadyAdmitted;

            if (needsApproval) {
                if (!waitingRoom[roomID]) waitingRoom[roomID] = [];
                // Lobby'da reconnect bo'lsa — eski yozuvni almashtiramiz
                waitingRoom[roomID] = waitingRoom[roomID].filter(u => u.userId !== userId);
                waitingRoom[roomID].push({ socketId: socket.id, userId, userName });
                // disconnect/deny tozalashi uchun socket->room bog'lanishini saqlaymiz
                socketToRoom[socket.id] = roomID;
                socket.emit('in-waiting-room');
                broadcastWaitingRoom(roomID);
                return;
            }

            await admitUser(socket, roomID, userId, userName, role, meeting);
        });

        // ── admit-user (host/cohost action) ───────────────────────────────────
        safeOn(socket, 'admit-user', async ({ roomId, targetSocketId }) => {
            if (!isModerator(roomId, socket.id)) return;
            if (!waitingRoom[roomId]) return;
            const userToAdmit = waitingRoom[roomId].find(u => u.socketId === targetSocketId);
            if (!userToAdmit) return;
            waitingRoom[roomId] = waitingRoom[roomId].filter(u => u.socketId !== targetSocketId);

            const meeting = await Meeting.findOne({ meetingCode: roomId, deletedAt: null })
                .populate('hostId', 'name')
                .populate('coHosts', '_id');
            const role = getRoomRole(meeting, userToAdmit.userId);
            const targetSocket = io.sockets.sockets.get(targetSocketId);
            if (targetSocket) {
                await admitUser(targetSocket, roomId, userToAdmit.userId, userToAdmit.userName, role, meeting);
            }
            broadcastWaitingRoom(roomId);
        });

        // ── deny-user ─────────────────────────────────────────────────────────
        safeOn(socket, 'deny-user', ({ roomId, targetSocketId }) => {
            if (!isModerator(roomId, socket.id)) return;
            if (!waitingRoom[roomId]) return;
            waitingRoom[roomId] = waitingRoom[roomId].filter(u => u.socketId !== targetSocketId);
            io.to(targetSocketId).emit('waiting-room-denied');
            broadcastWaitingRoom(roomId);
        });

        // ── WebRTC signalling ──────────────────────────────────────────────────
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

        // ── Chat ──────────────────────────────────────────────────────────────
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
            // Chat o'chirilgan bo'lsa, faqat moderator yoza oladi
            if (roomSettings[roomId]?.isChatEnabled === false && !isModerator(roomId, socket.id)) {
                socket.emit('socket-error', { event: 'chat-message', message: 'Chat is disabled' });
                return;
            }
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

        // ── Screen share ───────────────────────────────────────────────────────
        safeOn(socket, 'start-screen-share', ({ roomId, screenStreamId }) => {
            const me = users[roomId]?.find(u => u.socketId === socket.id);
            if (!me) return;

            const moderator = isModerator(roomId, socket.id);
            const approved = approvedSharers[roomId]?.has(socket.id);
            // Host demonstratsiyani umuman o'chirgan bo'lsa — oddiy ishtirokchi shareyola olmaydi
            if (!moderator && roomSettings[roomId]?.allowScreenSharing === false) {
                socket.emit('socket-error', { event: 'start-screen-share', message: 'Screen sharing is disabled' });
                return;
            }
            // Oddiy ishtirokchi faqat moderator ruxsati bilan demonstratsiya qila oladi
            if (!moderator && !approved) {
                socket.emit('socket-error', { event: 'start-screen-share', message: 'Share permission required' });
                return;
            }
            // Boshqa odam allaqachon demonstratsiya qilayotgan bo'lsa:
            // moderator uni siqib chiqaradi (takeover), oddiy ishtirokchi rad etiladi
            if (sharingUser[roomId] && sharingUser[roomId].socketId !== socket.id) {
                if (!moderator) {
                    socket.emit('socket-error', { event: 'start-screen-share', message: 'Another user is already sharing' });
                    return;
                }
                io.to(sharingUser[roomId].socketId).emit('force-stop-share');
            }
            // screenStreamId — receivers use it to tell the screen stream apart from the camera stream
            sharingUser[roomId] = { socketId: socket.id, userId: me.userId, userName: me.userName, role: me.role, screenStreamId: screenStreamId || null };
            socket.to(roomId).emit('screen-sharing-started', sharingUser[roomId]);
        });

        safeOn(socket, 'stop-screen-share', ({ roomId }) => {
            // Ruxsat bir martalik — to'xtatilgach qayta so'rash kerak
            approvedSharers[roomId]?.delete(socket.id);
            // Faqat sharer'ning o'zi (yoki moderator) to'xtata oladi; takeover'dan keyin
            // eski sharer'ning kechikkan stop'i yangi demonstratsiyani buzmasligi kerak
            if (sharingUser[roomId] && sharingUser[roomId].socketId !== socket.id) return;
            delete sharingUser[roomId];
            socket.to(roomId).emit('screen-sharing-stopped');
        });

        // ── Moderation ─────────────────────────────────────────────────────────
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
            // Delta event instead of broadcasting the full list (O(N²) at scale)
            io.to(roomId).emit('user-media-updated', { socketId: socket.id, micStatus: user.micStatus, videoStatus: user.videoStatus });
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

        safeOn(socket, 'kick-user', ({ roomId, targetSocketId, targetUserId }) => {
            if (!isModerator(roomId, socket.id)) return;
            io.to(targetSocketId).emit('kicked');
            if (users[roomId]) {
                users[roomId] = users[roomId].filter(u => u.socketId !== targetSocketId);
                io.to(roomId).emit('update-user-list', users[roomId]);
            }
        });

        // Server-authoritative: faqat haqiqiy DB host cohost tayinlay/yecha oladi va
        // o'zgarish DB'ga yoziladi (yagona haqiqat manbai). Frontend'ga ishonmaymiz.
        async function getMeetingForRoom(roomId) {
            return Meeting.findOne({ meetingCode: roomId, deletedAt: null })
                .populate('hostId', 'name')
                .populate('coHosts', '_id');
        }

        function actorIsDbHost(roomId, meeting) {
            const me = users[roomId]?.find(u => u.socketId === socket.id);
            if (!me || !meeting) return false;
            const hostId = meeting.hostId?._id ? String(meeting.hostId._id) : String(meeting.hostId);
            return hostId === String(me.userId);
        }

        safeOn(socket, 'promote-cohost', async ({ roomId, targetUserId, targetSocketId }) => {
            if (!users[roomId] || !targetUserId) return;
            const meeting = await getMeetingForRoom(roomId);
            if (!actorIsDbHost(roomId, meeting)) return;
            const hostId = meeting.hostId?._id ? String(meeting.hostId._id) : String(meeting.hostId);
            // Hostni cohost qilib bo'lmaydi (u allaqachon eng yuqori rol)
            if (String(targetUserId) === hostId) return;

            const coHostIds = (meeting.coHosts || []).map(c => String(c._id || c));
            if (!coHostIds.includes(String(targetUserId))) {
                meeting.coHosts.push(targetUserId);
                await meeting.save();
            }
            // Xotiradagi rollarni DB bilan moslab hammaga tarqatamiz
            syncRolesFromMeeting(roomId, meeting);
            // Yangi moderatorga joriy kutish xonasini ko'rsatamiz
            if (waitingRoom[roomId]?.length && targetSocketId) {
                io.to(targetSocketId).emit('waiting-room-update', waitingRoom[roomId]);
            }
        });

        safeOn(socket, 'demote-cohost', async ({ roomId, targetUserId }) => {
            if (!users[roomId] || !targetUserId) return;
            const meeting = await getMeetingForRoom(roomId);
            if (!actorIsDbHost(roomId, meeting)) return;

            const before = (meeting.coHosts || []).length;
            meeting.coHosts = (meeting.coHosts || []).filter(c => String(c._id || c) !== String(targetUserId));
            if (meeting.coHosts.length !== before) await meeting.save();
            syncRolesFromMeeting(roomId, meeting);
        });

        // Jonli sozlama yangilash — faqat DB host. DB'ga yoziladi, xotira yangilanadi
        // va butun xonaga tarqatiladi (chat/share/waiting-room darhol ta'sirlanadi).
        safeOn(socket, 'update-room-settings', async ({ roomId, settings }) => {
            if (!users[roomId] || !settings || typeof settings !== 'object') return;
            const meeting = await getMeetingForRoom(roomId);
            if (!actorIsDbHost(roomId, meeting)) return;

            // Faqat ruxsat etilgan boolean maydonlarni qabul qilamiz (whitelist)
            const allowed = ['isChatEnabled', 'isWaitingRoomEnabled', 'muteAllOnEntry', 'allowScreenSharing'];
            let changed = false;
            for (const key of allowed) {
                if (typeof settings[key] === 'boolean') {
                    meeting.settings[key] = settings[key];
                    changed = true;
                }
            }
            if (!changed) return;

            await meeting.save();
            roomSettings[roomId] = normalizeSettings(meeting.settings);
            io.to(roomId).emit('room-settings-updated', roomSettings[roomId]);
        });

        // ── File messages ──────────────────────────────────────────────────────
        safeOn(socket, 'file-message', async ({ roomId, userId, userName, file }) => {
            if (!roomId || !file || !file.data) return;
            const senderUser = users[roomId]?.find(u => u.socketId === socket.id);
            if (!senderUser) return;
            // Chat o'chirilgan bo'lsa, fayl ham yuborib bo'lmaydi (moderatordan tashqari)
            if (roomSettings[roomId]?.isChatEnabled === false && !isModerator(roomId, socket.id)) {
                socket.emit('socket-error', { event: 'file-message', message: 'Chat is disabled' });
                return;
            }
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
            const senderId = socket.authUserId || userId || socket.id;
            const safeFile = {
                name: String(file.name || 'file').slice(0, 255),
                type: String(file.type || '').slice(0, 150),
                size: Number(file.size) || approxBytes,
                data: file.data
            };
            // Faylni ham bazaga yozamiz — keyin qo'shilgan/qayta ulangan a'zolar tarixda ko'radi
            const savedFile = await Message.create({
                meetingId: roomId,
                senderId,
                senderName: senderUser.userName || userName,
                file: safeFile
            });
            io.to(roomId).emit('chat-message', {
                _id: savedFile._id,
                userName: senderUser.userName || userName,
                senderId,
                file: safeFile,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
        });

        // ── Screen share permission flow ───────────────────────────────────────
        safeOn(socket, 'request-to-share', ({ roomId, userId, userName, type }) => {
            if (!users[roomId]) return;
            // Demonstratsiya o'chirilgan bo'lsa — so'rovni hostga yubormay, darrov rad etamiz
            if (!isModerator(roomId, socket.id) && roomSettings[roomId]?.allowScreenSharing === false) {
                socket.emit('share-request-result', { approved: false, type });
                socket.emit('socket-error', { event: 'request-to-share', message: 'Screen sharing is disabled' });
                return;
            }
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
            // userId = requesterSocketId — ruxsatni server tomonda qayd qilamiz,
            // aks holda client tekshiruvni chetlab o'tishi mumkin
            if (approved) {
                if (!approvedSharers[roomId]) approvedSharers[roomId] = new Set();
                approvedSharers[roomId].add(userId);
            } else {
                approvedSharers[roomId]?.delete(userId);
            }
            io.to(userId).emit('share-request-result', { approved, type });
        });

        safeOn(socket, 'force-stop-share', ({ roomId, targetSocketId }) => {
            if (!isModerator(roomId, socket.id)) return;
            io.to(targetSocketId).emit('force-stop-share');
        });

        // ── Reconnect (skip waiting room — user was already admitted) ──────────
        safeOn(socket, 'reconnect-room', async (roomID, userId, userName) => {
            if (!roomID || !userId) return;
            if (socket.authUserId) userId = socket.authUserId;

            const meeting = await Meeting.findOne({ meetingCode: roomID, deletedAt: null })
                .populate('hostId', 'name')
                .populate('coHosts', '_id');
            if (!meeting) { socket.emit('room-not-found'); return; }

            const role = getRoomRole(meeting, userId);
            if (blockedUsers[roomID]?.has(userId)) { socket.emit('blocked'); return; }

            // Skip waiting room on reconnect — user was already admitted
            await admitUser(socket, roomID, userId, userName, role, meeting, true);
        });

        // ── Disconnect / Leave ─────────────────────────────────────────────────
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
            delete approvedSharers[roomId];
            delete roomSettings[roomId];
        });
    });
};

module.exports = socketHandler;

