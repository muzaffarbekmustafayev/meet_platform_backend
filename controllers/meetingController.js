const asyncHandler = require('express-async-handler');
const Meeting = require('../models/meetingModel');

const generateMeetingCode = () => {
    const p1 = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    const p2 = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    const p3 = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    return `${p1}-${p2}-${p3}`;
};

const generateUniqueMeetingCode = async () => {
    for (let i = 0; i < 10; i++) {
        const code = generateMeetingCode();
        const exists = await Meeting.exists({ meetingCode: code });
        if (!exists) return code;
    }
    throw new Error('Could not generate a unique meeting code');
};

// Faqat ruxsat etilgan sozlama maydonlarini olamiz (model default'lari ustiga).
// Validatsiya Joi'da bo'lgan; bu yerda faqat oq ro'yxat (whitelist).
const pickSettings = (input) => {
    if (!input || typeof input !== 'object') return undefined;
    const out = {};
    for (const key of ['isChatEnabled', 'isWaitingRoomEnabled', 'muteAllOnEntry', 'allowScreenSharing']) {
        if (typeof input[key] === 'boolean') out[key] = input[key];
    }
    return Object.keys(out).length ? out : undefined;
};

const sanitizeMeeting = (meeting) => {
    if (!meeting) return meeting;
    const obj = meeting.toObject ? meeting.toObject() : meeting;
    delete obj.password;
    return obj;
};

const createMeeting = asyncHandler(async (req, res) => {
    const { title, password, roomType } = req.body;

    // Manual validation: private rooms must have a password
    if (roomType === 'private') {
        if (!password || String(password).trim().length < 6) {
            res.status(400);
            throw new Error('Private rooms require a password of at least 6 characters');
        }
    }

    const settings = pickSettings(req.body.settings);

    // Race-safe yaratish: meetingCode'da unique indeks bor. Ikki so'rov bir vaqtda
    // bir xil kod tanlasa, biri E11000 (duplicate) beradi — bunday holda yangi kod
    // bilan qayta urinamiz (uzog'i bilan 3 marta).
    let meeting;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            meeting = await Meeting.create({
                hostId: req.user._id,
                title: title || `${req.user.name}'s Meeting`,
                meetingCode: await generateUniqueMeetingCode(),
                roomType: roomType || 'public',
                password: roomType === 'private' ? String(password).trim() : undefined,
                ...(settings ? { settings } : {})
            });
            break;
        } catch (err) {
            // 11000 — duplicate key (meetingCode to'qnashuvi); boshqa xato bo'lsa — tashlaymiz
            if (err?.code === 11000 && attempt < 2) continue;
            throw err;
        }
    }

    return res.status(201).json(sanitizeMeeting(meeting));
});

const getMeetingByCode = asyncHandler(async (req, res) => {
    // Bu endpoint kodni bilgan har kimga ochiq (xonaga kirishdan oldin). Shu sababli
    // email kabi maxfiy maydonlarni OSHKOR QILMAYMIZ — faqat UI uchun zarur ism/avatar.
    const meeting = await Meeting.findOne({ meetingCode: req.params.code, deletedAt: null })
        .select('+password')
        .populate('hostId', 'name avatar')
        .populate('coHosts', 'name avatar');

    if (!meeting) {
        res.status(404);
        throw new Error('Meeting not found');
    }

    if (meeting.roomType === 'private') {
        const providedPassword = req.query.password || (req.body && req.body.password);
        if (!providedPassword) {
            return res.status(403).json({
                message: 'Password required for this private room',
                requiresPassword: true
            });
        }
        const ok = await meeting.matchPassword(String(providedPassword));
        if (!ok) {
            res.status(403);
            throw new Error('Invalid password');
        }
    }

    return res.json(sanitizeMeeting(meeting));
});

const getMyMeetings = asyncHandler(async (req, res) => {
    const meetings = await Meeting.find({ hostId: req.user._id, deletedAt: null })
        .sort({ createdAt: -1 });
    return res.json(meetings);
});

const deleteMeeting = asyncHandler(async (req, res) => {
    const meeting = await Meeting.findById(req.params.id);
    if (!meeting) {
        res.status(404);
        throw new Error('Meeting not found');
    }
    if (meeting.hostId.toString() !== req.user._id.toString()) {
        res.status(403);
        throw new Error('Not authorized to delete this meeting');
    }

    meeting.deletedAt = new Date();
    meeting.status = 'completed';
    await meeting.save();
    return res.json({ message: 'Meeting removed successfully' });
});

const updateMeeting = asyncHandler(async (req, res) => {
    const meeting = await Meeting.findById(req.params.id);
    if (!meeting) {
        res.status(404);
        throw new Error('Meeting not found');
    }
    if (meeting.hostId.toString() !== req.user._id.toString()) {
        res.status(403);
        throw new Error('Not authorized to update this meeting');
    }

    if (req.body.title !== undefined) meeting.title = req.body.title;
    if (req.body.isPinned !== undefined) meeting.isPinned = req.body.isPinned;
    await meeting.save();

    return res.json(sanitizeMeeting(meeting));
});

const promoteToCoHost = asyncHandler(async (req, res) => {
    const meeting = await Meeting.findById(req.params.id);
    if (!meeting) {
        res.status(404);
        throw new Error('Meeting not found');
    }
    if (String(meeting.hostId) !== String(req.user._id)) {
        res.status(403);
        throw new Error('Only host can promote co-hosts');
    }

    const { userId } = req.body;
    if (!meeting.coHosts.map(String).includes(String(userId))) {
        meeting.coHosts.push(userId);
        await meeting.save();
    }
    return res.json({ message: 'Promoted to co-host', coHosts: meeting.coHosts });
});

const removeCoHost = asyncHandler(async (req, res) => {
    const meeting = await Meeting.findById(req.params.id);
    if (!meeting) {
        res.status(404);
        throw new Error('Meeting not found');
    }
    if (String(meeting.hostId) !== String(req.user._id)) {
        res.status(403);
        throw new Error('Only host can manage co-hosts');
    }

    const { userId } = req.body;
    meeting.coHosts = meeting.coHosts.filter(id => String(id) !== String(userId));
    await meeting.save();
    return res.json({ message: 'Co-host removed', coHosts: meeting.coHosts });
});

const getPinnedMeetings = asyncHandler(async (req, res) => {
    let meetings = await Meeting.find({
        hostId: req.user._id,
        isPinned: true,
        deletedAt: null
    }).sort({ createdAt: -1 });
    if (meetings.length === 0) {
        meetings = await Meeting.find({ hostId: req.user._id, deletedAt: null })
            .sort({ createdAt: -1 })
            .limit(4);
    }
    return res.json(meetings);
});

const activityCache = new Map();
const ACTIVITY_TTL_MS = 5 * 60 * 1000;

const getMeetingActivity = asyncHandler(async (req, res) => {
    const cacheKey = String(req.user._id);
    const now = Date.now();
    const cached = activityCache.get(cacheKey);
    if (cached && now - cached.t < ACTIVITY_TTL_MS) {
        return res.json(cached.data);
    }

    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    const meetings = await Meeting.find({
        hostId: req.user._id,
        deletedAt: null,
        createdAt: { $gte: oneYearAgo }
    }).select('createdAt title');

    const heatmapWeeks = Array.from({ length: 52 }, () => Array.from({ length: 7 }, () => 0));
    meetings.forEach(m => {
        const diffTime = Math.abs(new Date() - new Date(m.createdAt));
        const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
        if (diffDays <= 364) {
            const weekIdx = 51 - Math.floor(diffDays / 7);
            const dayIdx = new Date(m.createdAt).getDay();
            if (weekIdx >= 0 && weekIdx < 52) heatmapWeeks[weekIdx][dayIdx] += 1;
        }
    });

    const timelineMap = {};
    meetings.forEach(m => {
        const date = new Date(m.createdAt);
        const monthYear = date.toLocaleString('default', { month: 'long', year: 'numeric' });
        if (!timelineMap[monthYear]) timelineMap[monthYear] = { month: monthYear, events: [] };
        if (timelineMap[monthYear].events.length < 5) {
            timelineMap[monthYear].events.push({
                type: 'meeting',
                text: `Hosted meeting: ${m.title}`,
                date: date.toLocaleDateString(),
                icon: 'camera'
            });
        }
    });

    const timeline = Object.values(timelineMap).sort((a, b) => new Date(b.month) - new Date(a.month));
    if (timeline.length === 0) {
        timeline.push({
            month: new Date().toLocaleString('default', { month: 'long', year: 'numeric' }),
            events: [{ type: 'setting', text: 'Joined the platform', date: new Date().toLocaleDateString(), icon: 'settings' }]
        });
    }

    const data = { totalMeetings: meetings.length, heatmap: heatmapWeeks, timeline };
    activityCache.set(cacheKey, { t: now, data });
    return res.json(data);
});

const changeMeetingPassword = asyncHandler(async (req, res) => {
    const meeting = await Meeting.findById(req.params.id).select('+password');
    if (!meeting) { res.status(404); throw new Error('Meeting not found'); }
    if (meeting.hostId.toString() !== req.user._id.toString()) {
        res.status(403); throw new Error('Only the host can change the room password');
    }

    const newPassword = req.body.password?.trim() || '';

    if (newPassword) {
        if (newPassword.length < 6) {
            res.status(400); throw new Error('Password must be at least 6 characters');
        }
        meeting.password = newPassword;
        meeting.roomType = 'private';
    } else {
        meeting.password = undefined;
        meeting.roomType = 'public';
    }

    await meeting.save();
    return res.json({ message: 'Room password updated successfully' });
});

module.exports = {
    createMeeting,
    getMeetingByCode,
    getMyMeetings,
    deleteMeeting,
    updateMeeting,
    changeMeetingPassword,
    promoteToCoHost,
    removeCoHost,
    getPinnedMeetings,
    getMeetingActivity
};
