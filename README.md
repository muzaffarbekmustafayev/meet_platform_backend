# Meetra — Backend

WebSocket-first signaling server + REST API for the Meetra video platform. Handles authentication, meeting CRUD, real-time chat, peer signaling, and host moderation.

## ✨ Features

- **WebRTC signaling** — `signal`, `offer`, `answer`, `ice-candidate`
- **Mesh room management** — joins, leaves, role transitions
- **Roles** — `host`, `cohost`, `participant`, `guest` with permission gates
- **Public-room fast path** — guests join instantly, no admit step
- **Real-time chat** — message history, edit, delete, file payloads
- **Host moderation** — mute everyone, end meeting, kick, block
- **Hand raise**, **spotlight**, **pin**, **co-host promote/demote**
- **JWT auth** — bcrypt password hashing
- **Rate limiting** — login & API endpoints

## 🛠 Stack

- [Node.js](https://nodejs.org/) 18+
- [Express](https://expressjs.com/)
- [Socket.io](https://socket.io/)
- [MongoDB](https://www.mongodb.com/) + [Mongoose](https://mongoosejs.com/)
- [JWT](https://jwt.io/) + [bcrypt](https://github.com/kelektiv/node.bcrypt.js)
- [Joi](https://joi.dev/) / [express-validator](https://express-validator.github.io/)

## 📁 Structure

```text
meet_platform_backend/
├── config/             # Mongo connection, env helpers
├── controllers/        # Route handlers (auth, meetings, users)
├── middleware/         # Auth, rate-limit, error
├── models/             # Mongoose schemas (User, Meeting, Message)
├── routes/             # REST endpoints
├── socket/             # socketHandler.js — all real-time logic
├── utils/              # Helpers
├── validators/         # Request validation
└── server.js           # HTTP + Socket.io bootstrap
```

## ⚙️ Setup

```bash
# Requires Node.js 18+ and MongoDB (local or Atlas)
npm install
cp .env.example .env
```

**`.env`**

```env
PORT=5005
MONGO_URI=mongodb://localhost:27017/meetra
JWT_SECRET=replace-me-with-a-long-random-string
JWT_EXPIRES_IN=7d
NODE_ENV=development
CORS_ORIGIN=http://localhost:5173
```

## 🧑‍💻 Scripts

| Command         | What it does                          |
| --------------- | ------------------------------------- |
| `npm run dev`   | Nodemon watch mode                    |
| `npm start`     | Production start                      |

## 📡 Socket events (selected)

**Client → Server**

| Event                    | Purpose                                           |
| ------------------------ | ------------------------------------------------- |
| `join-room`              | Enter a meeting (auto-admitted)                   |
| `leave-room`             | Disconnect from current meeting                   |
| `signal`                 | Forward WebRTC SDP / ICE between peers            |
| `chat-message`           | Send a chat message                               |
| `update-media-status`    | Notify mic/cam state change                       |
| `start-screen-share`     | Announce screen-share start                       |
| `stop-screen-share`      | Announce screen-share end                         |
| `mute-all`               | Host: mute everyone                               |
| `end-meeting`            | Host: close room for everyone                     |
| `kick-user`              | Host/co-host: remove a user                       |
| `block-user`             | Host: permanently block a user                    |
| `promote-cohost`         | Host: grant co-host                               |
| `demote-cohost`          | Host: revoke co-host                              |
| `raise-hand`             | Toggle hand-raise                                 |

**Server → Client**

| Event                   | Purpose                                   |
| ----------------------- | ----------------------------------------- |
| `room-users`            | Current participant list                  |
| `user-joined`           | New peer announcement                     |
| `user-left`             | Peer disconnected                         |
| `signal`                | Relayed WebRTC signal                     |
| `chat-message`          | Broadcast message                         |
| `previous-messages`     | History on join                           |
| `media-status-update`   | Peer toggled mic/cam                      |
| `kicked` / `blocked`    | You were removed                          |
| `meeting-ended`         | Host ended the meeting                    |
| `force-mute`            | Host muted you                            |

## 🌐 REST endpoints (selected)

| Method | Path                              | Purpose                       |
| ------ | --------------------------------- | ----------------------------- |
| `POST` | `/api/users/register`             | Sign up                       |
| `POST` | `/api/users/login`                | Sign in                       |
| `POST` | `/api/users/guest-login`          | Guest token                   |
| `GET`  | `/api/users/profile`              | My profile                    |
| `PUT`  | `/api/users/profile`              | Update profile                |
| `GET`  | `/api/meetings`                   | My meeting history            |
| `POST` | `/api/meetings`                   | Create meeting                |
| `PUT`  | `/api/meetings/:id`               | Update title / pin            |
| `DELETE` | `/api/meetings/:id`             | Delete meeting                |
| `GET`  | `/api/meetings/pinned`            | Pinned rooms                  |
| `GET`  | `/api/meetings/activity`          | Heatmap + timeline            |

## 🛡 Security

- JWT verification on every authenticated socket / REST call
- bcrypt password hashing (12 rounds)
- Per-IP rate limiting on auth endpoints
- CORS whitelist via `CORS_ORIGIN`
- NoSQL-injection sanitization on user input

## 🚀 Deployment

The backend is a plain Node HTTP + WebSocket server. Any host that supports persistent WebSocket connections works:

- **Render / Railway / Fly.io** — point at this folder, set env vars
- **VPS** — `pm2 start server.js --name meetra-api` behind nginx
- **Docker** — bring your own Dockerfile (Node 18-alpine + MongoDB connection string)

⚠️ **Vercel is not suitable for this backend** — Vercel functions are stateless / short-lived and don't keep WebSocket connections alive.

## 📄 License

MIT
