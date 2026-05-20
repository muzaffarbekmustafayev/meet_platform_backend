const asyncHandler = require('express-async-handler');
const User = require('../models/userModel');
const Meeting = require('../models/meetingModel');
const Message = require('../models/messageModel');

const getStats = asyncHandler(async (req, res) => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 7), 90);
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

const getAllUsers = asyncHandler(async (req, res) => {
    const users = await User.find({}).select('-password -__v');
    return res.json(users);
});

const updateUserRole = asyncHandler(async (req, res) => {
    if (String(req.params.id) === String(req.user._id)) {
        res.status(400);
        throw new Error('You cannot change your own role');
    }
    const user = await User.findById(req.params.id);
    if (!user) { res.status(404); throw new Error('User not found'); }
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
    return res.json({ message: `User ${user.isBlocked ? 'blocked' : 'unblocked'} successfully` });
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
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) { res.status(404); throw new Error('User not found'); }
    return res.json({ message: 'User deleted successfully' });
});

const getAllMeetings = asyncHandler(async (req, res) => {
    const meetings = await Meeting.find({ deletedAt: null })
        .populate('hostId', 'name email')
        .sort({ createdAt: -1 })
        .lean();
    return res.json(meetings);
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
    getStats, getAllUsers, updateUserRole, toggleBlockUser,
    createUser, updateUser, deleteUser, getAllMeetings, deleteMeeting
};
