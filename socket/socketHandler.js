const { Server } = require('socket.io');
const Meeting = require('../models/meetingModel');
const Message = require('../models/messageModel');

const socketHandler = (server) => {
    const io = new Server(server, {
        cors: {
            origin: ['http://localhost:5173', 'http://localhost:3000', 'http://zoom.sampc.uz', 'https://zoom.sampc.uz'],
            methods: ["GET", "POST"],
            credentials: true
        }
    });

    const users = {};             
    const socketToRoom = {};      
    const sharingUser = {};       
    const blockedUsers = {};      
    const waitingRoom = {};       
    const admittedUsers = {}; // roomId -> Set of userIds to prevent re-entering waiting room on refresh

    function getRoomRole(meeting, userId, isGuest) {
        if (isGuest) return 'guest';
        if (!meeting) return 'participant';
        if (String(meeting.hostId) === String(userId) || (meeting.hostId?._id && String(meeting.hostId._id) === String(userId))) return 'host';
        const coHostIds = (meeting.coHosts || []).map(id => String(id._id || id));
        if (coHostIds.includes(String(userId))) return 'cohost';
        return 'participant';
    }

    function broadcastWaitingRoom(roomId) {
        if (users[roomId]) {
            users[roomId].filter(u => u.role === 'host' || u.role === 'cohost').forEach(u => {
                io.to(u.socketId).emit('waiting-room-update', waitingRoom[roomId] || []);
            });
        }
    }

    function handleUserLeaving(socket, roomID) {
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

    io.on('connection', (socket) => {
        socket.on('join-room', async (roomID, userId, userName, isGuest) => {
            const meeting = await Meeting.findOne({ meetingCode: roomID }).populate('hostId', 'name');
            const role = getRoomRole(meeting, userId, isGuest);

            if (meeting?.settings?.isWaitingRoomEnabled && role === 'participant') {
                if (!admittedUsers[roomID] || !admittedUsers[roomID].has(userId)) {
                    if (!waitingRoom[roomID]) waitingRoom[roomID] = [];
                if (!waitingRoom[roomID].find(u => u.userId === userId)) {
                    waitingRoom[roomID].push({ socketId: socket.id, userId, userName, isGuest });
                }
                socket.emit('waiting-room');
                broadcastWaitingRoom(roomID);
                return;
                }
            }

            await admitUser(socket, roomID, userId, userName, role, meeting);
        });

        async function admitUser(socket, roomID, userId, userName, role, meeting) {
            if (users[roomID]) {
                users[roomID] = users[roomID].filter(u => u.userId !== userId);
            }

            socket.join(roomID);
            socketToRoom[socket.id] = roomID;

            if (!admittedUsers[roomID]) admittedUsers[roomID] = new Set();
            admittedUsers[roomID].add(userId);

            const userData = { socketId: socket.id, userId, userName, micStatus: true, videoStatus: true, role };
            if (users[roomID]) {
                users[roomID].push(userData);
            } else {
                users[roomID] = [userData];
            }

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

            // Fetch and send previous messages
            const prevMessages = await Message.find({ meetingId: roomID }).sort({ createdAt: 1 }).limit(50);
            socket.emit('previous-messages', prevMessages);
        }

        socket.on('admit-user', async ({ roomId, targetSocketId }) => {
            if (waitingRoom[roomId]) {
                const userToAdmit = waitingRoom[roomId].find(u => u.socketId === targetSocketId);
                if (userToAdmit) {
                    waitingRoom[roomId] = waitingRoom[roomId].filter(u => u.socketId !== targetSocketId);
                    const meeting = await Meeting.findOne({ meetingCode: roomId });
                    const role = getRoomRole(meeting, userToAdmit.userId, userToAdmit.isGuest);
                    const targetSocket = io.sockets.sockets.get(targetSocketId);
                    if (targetSocket) {
                        await admitUser(targetSocket, roomId, userToAdmit.userId, userToAdmit.userName, role, meeting);
                    }
                    broadcastWaitingRoom(roomId);
                }
            }
        });

        socket.on('deny-user', ({ roomId, targetSocketId }) => {
            if (waitingRoom[roomId]) {
                waitingRoom[roomId] = waitingRoom[roomId].filter(u => u.socketId !== targetSocketId);
                io.to(targetSocketId).emit('waiting-room-denied');
                broadcastWaitingRoom(roomId);
            }
        });

        socket.on('sending-signal', payload => {
            io.to(payload.userToSignal).emit('user-joined', { signal: payload.signal, callerID: payload.callerID, callerUserId: payload.callerUserId });
        });

        socket.on('returning-signal', payload => {
            io.to(payload.callerID).emit('receiving-returned-signal', { signal: payload.signal, id: socket.id });
        });

        socket.on('chat-message', async ({ roomId, message, userName, userId }) => {
            // Save to DB
            const newMessage = await Message.create({
                meetingId: roomId,
                senderId: userId || socket.id,
                senderName: userName,
                text: message
            });

            io.to(roomId).emit('chat-message', { 
                _id: newMessage._id,
                text: message, 
                userName, 
                time: new Date().toLocaleTimeString() 
            });
        });

        socket.on('start-screen-share', ({ roomId, userId, userName, role }) => {
            sharingUser[roomId] = { socketId: socket.id, userId, userName, role };
            socket.to(roomId).emit('screen-sharing-started', { socketId: socket.id, userId, userName, role });
        });

        // FIX: accept { roomId } object (client sends object, not string)
        socket.on('stop-screen-share', ({ roomId }) => {
            delete sharingUser[roomId];
            socket.to(roomId).emit('screen-sharing-stopped');
        });

        socket.on('hand-raise', ({ roomId, userId }) => {
            socket.to(roomId).emit('user-hand-raised', userId);
        });

        socket.on('give-turn', ({ roomId, targetUserId }) => {
            io.to(roomId).emit('turn-updated', { userId: targetUserId });
        });

        socket.on('mute-all', ({ roomId }) => {
            socket.to(roomId).emit('room-muted-all');
        });

        socket.on('update-media-status', ({ roomId, micStatus, videoStatus }) => {
            if (users[roomId]) {
                const user = users[roomId].find(u => u.socketId === socket.id);
                if (user) {
                    if (micStatus !== undefined) user.micStatus = micStatus;
                    if (videoStatus !== undefined) user.videoStatus = videoStatus;
                    io.to(roomId).emit('update-user-list', users[roomId]);
                }
            }
        });

        socket.on('block-user', ({ roomId, targetUserId, targetSocketId }) => {
            io.to(targetSocketId).emit('blocked');
            if (!blockedUsers[roomId]) blockedUsers[roomId] = new Set();
            blockedUsers[roomId].add(targetUserId);
            // Remove from room
            if (users[roomId]) {
                users[roomId] = users[roomId].filter(u => u.socketId !== targetSocketId);
                io.to(roomId).emit('update-user-list', users[roomId]);
            }
        });

        socket.on('file-message', ({ roomId, userId, userName, file }) => {
            io.to(roomId).emit('chat-message', {
                userName,
                file,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
        });

        socket.on('request-to-share', ({ roomId, hostId, userId, userName, type }) => {
            // Find host/cohost socket and forward request
            if (users[roomId]) {
                const moderators = users[roomId].filter(u => u.role === 'host' || u.role === 'cohost');
                moderators.forEach(mod => {
                    io.to(mod.socketId).emit('share-request-received', {
                        userId,
                        userName,
                        type,
                        requesterSocketId: socket.id
                    });
                });
            }
        });

        socket.on('share-permission-response', ({ userId, approved, type }) => {
            // userId here is the requester's socketId
            io.to(userId).emit('share-request-result', { approved, type });
        });

        socket.on('force-stop-share', ({ roomId, targetSocketId }) => {
            io.to(targetSocketId).emit('force-stop-share');
        });

        socket.on('disconnect', () => {
            const roomID = socketToRoom[socket.id];
            handleUserLeaving(socket, roomID);
        });

        socket.on('leave-room', () => {
            const roomID = socketToRoom[socket.id];
            handleUserLeaving(socket, roomID);
            socket.leave(roomID);
        });
        
        socket.on('end-meeting', ({ roomId }) => {
            io.to(roomId).emit('meeting-ended');
            delete users[roomId];
            delete sharingUser[roomId];
            delete waitingRoom[roomId];
            delete admittedUsers[roomId];
        });

        socket.on('kick-user', ({ roomId, targetSocketId, targetUserId }) => {
            io.to(targetSocketId).emit('kicked');
            // Remove from active users (not permanently blocked)
            if (users[roomId]) {
                users[roomId] = users[roomId].filter(u => u.socketId !== targetSocketId);
                io.to(roomId).emit('update-user-list', users[roomId]);
            }
        });

        socket.on('promote-cohost', ({ roomId, targetUserId, targetSocketId }) => {
            if (users[roomId]) {
                const user = users[roomId].find(u => u.socketId === targetSocketId);
                if (user) user.role = 'cohost';
                io.to(targetSocketId).emit('role-updated', { role: 'cohost' });
                io.to(roomId).emit('update-user-list', users[roomId]);
            }
        });

        socket.on('demote-cohost', ({ roomId, targetUserId, targetSocketId }) => {
            if (users[roomId]) {
                const user = users[roomId].find(u => u.socketId === targetSocketId);
                if (user) user.role = 'participant';
                io.to(targetSocketId).emit('role-updated', { role: 'participant' });
                io.to(roomId).emit('update-user-list', users[roomId]);
            }
        });
    });
};

module.exports = socketHandler;
