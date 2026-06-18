const asyncHandler = require('express-async-handler');
const User = require('../models/userModel');
const Meeting = require('../models/meetingModel');
const Message = require('../models/messageModel');
const escapeRegex = require('../utils/escapeRegex');

/* ----------------------------- helpers ----------------------------- */

const parsePaging = (q) => {
    const page  = Math.max(parseInt(q.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || 20, 1), 100);
    return { page, limit, skip: (page - 1) * limit };
};

const buildSort = (q, allowed, def = 'createdAt') => {
    const field = allowed.includes(q.sort) ? q.sort : def;
    const dir   = q.order === 'asc' ? 1 : -1;
    return { [field]: dir };
};

const buildUserFilter = (q) => {
    const filter = {};
    if (q.role && q.role !== 'all')     filter.role = q.role;
    if (q.status && q.status !== 'all') filter.isBlocked = q.status === 'blocked';
    if (q.search && q.search.trim()) {
        const rx = new RegExp(escapeRegex(q.search.trim()), 'i');
        filter.$or = [{ name: rx }, { email: rx }];
    }
    return filter;
};

const buildMeetingFilter = (q) => {
    const filter = { deletedAt: null };
    if (q.status && q.status !== 'all') filter.status = q.status;
    if (q.type && q.type !== 'all')     filter.roomType = q.type;
    if (q.search && q.search.trim()) {
        const rx = new RegExp(escapeRegex(q.search.trim()), 'i');
        filter.$or = [{ title: rx }, { meetingCode: rx }];
    }
    return filter;
};

// Minimal, spec-compliant CSV serializer.
const toCsv = (rows, columns) => {
    const esc = (v) => {
        const s = v == null ? '' : String(v);
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = columns.map(c => esc(c.label)).join(',');
    const body = rows.map(r => columns.map(c => esc(c.get(r))).join(',')).join('\n');
    return `${head}\n${body}`;
};

const adminCount = (extra = {}) => User.countDocuments({ role: 'admin', ...extra });

/* ------------------------------ stats ------------------------------ */

const getStats = asyncHandler(async (req, res) => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 7), 90);
    const chartStart = new Date(todayStart);
    chartStart.setDate(chartStart.getDate() - (days - 1));

    const [
        totalUsers, totalMeetings, regularUsers, admins,
        blockedUsers, activeMeetings, totalMessages,
        publicMeetings, privateMeetings,
        newUsersToday, newMeetingsToday,
        userChartRaw, meetingChartRaw
    ] = await Promise.all([
        User.countDocuments(),
        Meeting.countDocuments({ deletedAt: null }),
        User.countDocuments({ role: 'user' }),
        User.countDocuments({ role: 'admin' }),
        User.countDocuments({ isBlocked: true }),
        Meeting.countDocuments({ deletedAt: null, status: 'active' }),
        Message.countDocuments(),
        Meeting.countDocuments({ deletedAt: null, roomType: 'public' }),
        Meeting.countDocuments({ deletedAt: null, roomType: 'private' }),
        User.countDocuments({ createdAt: { $gte: todayStart } }),
        Meeting.countDocuments({ deletedAt: null, createdAt: { $gte: todayStart } }),
        User.aggregate([
            { $match: { createdAt: { $gte: chartStart } } },
            { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
            { $sort: { _id: 1 } }
        ]),
        Meeting.aggregate([
            { $match: { deletedAt: null, createdAt: { $gte: chartStart } } },
            { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
            { $sort: { _id: 1 } }
        ])
    ]);

    const dateLabels = Array.from({ length: days }, (_, i) => {
        const d = new Date(chartStart);
        d.setDate(d.getDate() + i);
        return d.toISOString().slice(0, 10);
    });
    const userMap    = Object.fromEntries(userChartRaw.map(r => [r._id, r.count]));
    const meetingMap = Object.fromEntries(meetingChartRaw.map(r => [r._id, r.count]));
    const chartData  = dateLabels.map(date => ({ date, users: userMap[date] || 0, meetings: meetingMap[date] || 0 }));

    return res.json({
        totalUsers, totalMeetings, users: regularUsers, admins,
        blockedUsers, activeMeetings, totalMessages,
        publicMeetings, privateMeetings,
        newUsersToday, newMeetingsToday,
        chartData
    });
});

/* ------------------------------ users ------------------------------ */

const USER_SORT = ['name', 'email', 'role', 'createdAt'];

const getAllUsers = asyncHandler(async (req, res) => {
    const { page, limit, skip } = parsePaging(req.query);
    const filter = buildUserFilter(req.query);
    const sort   = buildSort(req.query, USER_SORT);

    const [items, total] = await Promise.all([
        User.find(filter).select('-password -__v').sort(sort).skip(skip).limit(limit).lean(),
        User.countDocuments(filter)
    ]);

    return res.json({ items, total, page, limit, pages: Math.ceil(total / limit) || 1 });
});

const exportUsers = asyncHandler(async (req, res) => {
    const filter = buildUserFilter(req.query);
    const users = await User.find(filter)
        .select('name email role isBlocked createdAt')
        .sort({ createdAt: -1 })
        .lean();

    const csv = toCsv(users, [
        { label: 'Name',    get: u => u.name },
        { label: 'Email',   get: u => u.email },
        { label: 'Role',    get: u => u.role },
        { label: 'Status',  get: u => (u.isBlocked ? 'Blocked' : 'Active') },
        { label: 'Created', get: u => new Date(u.createdAt).toISOString() }
    ]);

    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.attachment(`users-${new Date().toISOString().slice(0, 10)}.csv`);
    return res.send(csv);
});

const updateUserRole = asyncHandler(async (req, res) => {
    if (String(req.params.id) === String(req.user._id)) {
        res.status(400);
        throw new Error('You cannot change your own role');
    }
    const user = await User.findById(req.params.id);
    if (!user) { res.status(404); throw new Error('User not found'); }

    // Prevent demoting the only remaining admin (would lock everyone out).
    if (user.role === 'admin' && req.body.role !== 'admin' && (await adminCount()) <= 1) {
        res.status(400);
        throw new Error('Cannot demote the last admin');
    }

    user.role = req.body.role;
    await user.save();
    return res.json(user.toSafeJSON());
});

const toggleBlockUser = asyncHandler(async (req, res) => {
    if (String(req.params.id) === String(req.user._id)) {
        res.status(400);
        throw new Error('You cannot block yourself');
    }
    const user = await User.findById(req.params.id);
    if (!user) { res.status(404); throw new Error('User not found'); }
    user.isBlocked = !user.isBlocked;
    await user.save();
    return res.json({
        message: `User ${user.isBlocked ? 'blocked' : 'unblocked'} successfully`,
        user: user.toSafeJSON()
    });
});

const createUser = asyncHandler(async (req, res) => {
    const { name, email, password, role } = req.body;
    const exists = await User.findOne({ email }).select('_id').lean();
    if (exists) { res.status(409); throw new Error('User with this email already exists'); }
    const user = await User.create({ name, email, role: role || 'user', ...(password && { password }) });
    return res.status(201).json(user.toSafeJSON());
});

const updateUser = asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) { res.status(404); throw new Error('User not found'); }

    if (req.body.email && req.body.email !== user.email) {
        const taken = await User.findOne({ email: req.body.email, _id: { $ne: user._id } }).select('_id').lean();
        if (taken) { res.status(409); throw new Error('Email already in use'); }
        user.email = req.body.email;
    }

    // Guard last-admin demotion via the generic update path too.
    const demotingAdmin = req.body.role && req.body.role !== 'admin' && user.role === 'admin';
    if (demotingAdmin && String(user._id) === String(req.user._id)) {
        res.status(400);
        throw new Error('You cannot change your own role');
    }
    if (demotingAdmin && (await adminCount()) <= 1) {
        res.status(400);
        throw new Error('Cannot demote the last admin');
    }

    if (req.body.name)     user.name     = req.body.name;
    if (req.body.role)     user.role     = req.body.role;
    if (req.body.password) user.password = req.body.password;

    await user.save();
    return res.json(user.toSafeJSON());
});

const deleteUser = asyncHandler(async (req, res) => {
    if (String(req.params.id) === String(req.user._id)) {
        res.status(400);
        throw new Error('Cannot delete your own account');
    }
    const user = await User.findById(req.params.id);
    if (!user) { res.status(404); throw new Error('User not found'); }

    if (user.role === 'admin' && (await adminCount()) <= 1) {
        res.status(400);
        throw new Error('Cannot delete the last admin');
    }

    // Soft-delete the user's meetings so nothing dangles with a missing host.
    await Meeting.updateMany(
        { hostId: user._id, deletedAt: null },
        { deletedAt: new Date(), status: 'completed' }
    );
    await user.deleteOne();
    return res.json({ message: 'User deleted successfully' });
});

const bulkUsers = asyncHandler(async (req, res) => {
    const { action, ids } = req.body;
    const selfId = String(req.user._id);
    const targetIds = [...new Set(ids.map(String))].filter(id => id !== selfId);

    if (!targetIds.length) {
        res.status(400);
        throw new Error('No actionable users selected');
    }

    if (action === 'delete') {
        // Make sure at least one admin survives the bulk delete.
        if ((await adminCount({ _id: { $nin: targetIds } })) < 1) {
            res.status(400);
            throw new Error('Cannot delete all admins');
        }
        await Meeting.updateMany(
            { hostId: { $in: targetIds }, deletedAt: null },
            { deletedAt: new Date(), status: 'completed' }
        );
        const r = await User.deleteMany({ _id: { $in: targetIds } });
        return res.json({ message: `${r.deletedCount} user(s) deleted`, affected: r.deletedCount });
    }

    const r = await User.updateMany(
        { _id: { $in: targetIds } },
        { isBlocked: action === 'block' }
    );
    return res.json({ message: `${r.modifiedCount} user(s) ${action}ed`, affected: r.modifiedCount });
});

/* ----------------------------- meetings ---------------------------- */

const MEETING_SORT = ['title', 'status', 'roomType', 'createdAt'];

const getAllMeetings = asyncHandler(async (req, res) => {
    const { page, limit, skip } = parsePaging(req.query);
    const filter = buildMeetingFilter(req.query);
    const sort   = buildSort(req.query, MEETING_SORT);

    const [items, total] = await Promise.all([
        Meeting.find(filter).populate('hostId', 'name email').sort(sort).skip(skip).limit(limit).lean(),
        Meeting.countDocuments(filter)
    ]);

    return res.json({ items, total, page, limit, pages: Math.ceil(total / limit) || 1 });
});

const exportMeetings = asyncHandler(async (req, res) => {
    const filter = buildMeetingFilter(req.query);
    const meetings = await Meeting.find(filter)
        .populate('hostId', 'name email')
        .sort({ createdAt: -1 })
        .lean();

    const csv = toCsv(meetings, [
        { label: 'Title',     get: m => m.title },
        { label: 'Code',      get: m => m.meetingCode },
        { label: 'Host',      get: m => m.hostId?.name || '' },
        { label: 'HostEmail', get: m => m.hostId?.email || '' },
        { label: 'Type',      get: m => m.roomType },
        { label: 'Status',    get: m => m.status },
        { label: 'Created',   get: m => new Date(m.createdAt).toISOString() }
    ]);

    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.attachment(`meetings-${new Date().toISOString().slice(0, 10)}.csv`);
    return res.send(csv);
});

const deleteMeeting = asyncHandler(async (req, res) => {
    const meeting = await Meeting.findById(req.params.id);
    if (!meeting) { res.status(404); throw new Error('Meeting not found'); }
    meeting.deletedAt = new Date();
    meeting.status = 'completed';
    await meeting.save();
    return res.json({ message: 'Meeting deleted successfully' });
});

module.exports = {
    getStats,
    getAllUsers, exportUsers, updateUserRole, toggleBlockUser,
    createUser, updateUser, deleteUser, bulkUsers,
    getAllMeetings, exportMeetings, deleteMeeting
};
