# Meetra — Backend

Signaling server + REST API for the Meetra video platform. Express 5 + Socket.IO 4 + MongoDB. Handles auth, meeting CRUD, WebRTC signaling, chat, screen-share permissions, and host moderation.

## Stack

- **Node.js 18+**, **Express 5** (REST API)
- **Socket.IO 4** (signaling, chat, room state)
- **MongoDB + Mongoose** (users, meetings, messages)
- **JWT** (`jsonwebtoken`) + **bcryptjs**, Google OAuth (`google-auth-library`)
- **Joi** (validation), **helmet**, **cors**, **compression**, **express-rate-limit**, **morgan**

## Run

```bash
cp .env.example .env   # MONGO_URI, JWT_SECRET, ALLOWED_ORIGINS, ...
npm install
npm run dev            # nodemon, port 5005
npm start              # production
```

Health check: `GET /health`.

## Structure

```text
meet_platform_backend/
├── index.js                  # App bootstrap, middleware, graceful shutdown
├── config/                   # db connection, env validation, JWT token helper
├── controllers/              # user / meeting / admin controllers
├── routes/                   # /api/users, /api/meetings, /api/admin
├── middleware/               # auth (JWT), error handler, rate limiters, validate
├── validators/               # Joi schemas
├── models/                   # User, Meeting (soft-delete, password rooms), Message
└── socket/
    └── socketHandler.js      # All real-time logic (rooms, signaling, chat, moderation)
```

## Socket.IO events

Auth: pass a JWT via `socket.handshake.auth.token` — the server attaches `authUserId` and ignores client-supplied IDs for authenticated users.

### Room lifecycle

| Event (client → server) | Payload | Notes |
|---|---|---|
| `join-room` | `roomID, userId, userName, password?` | Password checked for private rooms (rate-limited) |
| `reconnect-room` | `roomID, userId, userName` | Skips waiting room within admitted TTL (6h) |
| `leave-room` / `end-meeting` | — / `{ roomId }` | `end-meeting` is host-only, clears all room state |
| `admit-user` / `deny-user` | `{ roomId, targetSocketId }` | Moderator-only waiting-room actions |

Server emits: `your-role`, `all-users`, `update-user-list`, `user-disconnected`, `host-changed`, `role-updated`, `meeting-ended`, `room-not-found`, `blocked`, `kicked`.

### WebRTC signaling (mesh, trickle ICE)

| Event | Direction | Notes |
|---|---|---|
| `sending-signal` → `user-joined` | initiator → peer | Multiple signals per peer (trickle) |
| `returning-signal` → `receiving-returned-signal` | peer → initiator | |

### Screen / document share

| Event | Notes |
|---|---|
| `start-screen-share { roomId, screenStreamId }` | Server-enforced: moderators share instantly (take over an active share); participants need approval. `screenStreamId` lets receivers tell the screen stream from the camera stream |
| `stop-screen-share { roomId }` | Only the active sharer's stop is accepted; one-time approval is consumed |
| `request-to-share` → `share-request-received` | Participant asks; moderators get the request |
| `share-permission-response { userId, approved }` | Moderator decision, recorded server-side (`approvedSharers`) |
| `force-stop-share { roomId, targetSocketId }` | Moderator forcibly stops a sharer |

Server emits `screen-sharing-started { ..., screenStreamId }` (also to late joiners) and `screen-sharing-stopped` (including when the sharer disconnects).

### Chat & media state

| Event | Notes |
|---|---|
| `chat-message` / `edit-chat-message` / `delete-chat-message` | Persisted in MongoDB, rate-limited (15 msg / 10s), 2000-char limit |
| `file-message` | ≤5 MB base64 broadcast (roadmap: move to object storage) |
| `update-media-status` → `user-media-updated` | Delta event — only the changed user is broadcast (O(N), not O(N²)) |
| `hand-raise`, `give-turn`, `mute-all`, `kick-user`, `block-user`, `promote-cohost`, `demote-cohost` | Moderation (role-checked server-side) |

## Security notes

- Helmet, CORS whitelist (`ALLOWED_ORIGINS`), body limit, API + socket rate limiting.
- Private-room password attempts are rate-limited per IP+room.
- Share permissions and moderation are validated **server-side** — client checks are UX only.
- Known remaining issues and fixes are tracked in `../CODE_REVIEW.md` (top item: make JWT mandatory for room join to fully prevent identity spoofing).
