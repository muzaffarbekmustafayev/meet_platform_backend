const Meeting = require('../models/meetingModel');

const generateMeetingCode = () => {
    const p1 = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    const p2 = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    const p3 = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    return `${p1}-${p2}-${p3}`;
};

const createMeeting = async (req, res) => {
    try {
        const { title, password, roomType } = req.body;

        // Validation for private rooms
        if (roomType === 'private' && !password) {
            return res.status(400).json({ message: 'Password is required for private rooms' });
        }

        // Public rooms should not have password
        if (roomType === 'public' && password) {
            return res.status(400).json({ message: 'Public rooms cannot have password protection' });
        }

        const meeting = await Meeting.create({
            hostId: req.user._id,
            title: title || `${req.user.name}'s Meeting`,
            meetingCode: generateMeetingCode(),
            roomType: roomType || 'public',
            password: roomType === 'private' ? password : undefined
        });
        
        return res.status(201).json(meeting);
    } catch (error) {
        return res.status(400).json({ message: error.message });
    }
};

const getMeetingByCode = async (req, res) => {
    try {
        const meeting = await Meeting.findOne({ meetingCode: req.params.code })
            .populate('hostId', 'name email avatar')
            .populate('coHosts', 'name email');

        if (!meeting) {
            return res.status(404).json({ message: 'Meeting not found' });
        }

        // If it's a private room, check if password is provided and correct
        if (meeting.roomType === 'private') {
            const providedPassword = req.query.password || req.body.password;
            
            if (!providedPassword) {
                return res.status(403).json({ 
                    message: 'Password required for this private room',
                    requiresPassword: true 
                });
            }

            if (providedPassword !== meeting.password) {
                return res.status(403).json({ message: 'Invalid password' });
            }
        }

        return res.json(meeting);
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

const getMyMeetings = async (req, res) => {
    try {
        const meetings = await Meeting.find({ hostId: req.user._id }).sort({ createdAt: -1 });
        return res.json(meetings);
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

const deleteMeeting = async (req, res) => {
    try {
        const meeting = await Meeting.findById(req.params.id);
        
        if (!meeting) {
            return res.status(404).json({ message: 'Meeting not found' });
        }

        if (meeting.hostId.toString() !== req.user._id.toString()) {
            return res.status(403).json({ message: 'Not authorized to delete this meeting' });
        }

        await meeting.deleteOne();
        return res.json({ message: 'Meeting removed successfully' });
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

const updateMeeting = async (req, res) => {
    try {
        const meeting = await Meeting.findById(req.params.id);
        
        if (!meeting) {
            return res.status(404).json({ message: 'Meeting not found' });
        }

        if (meeting.hostId.toString() !== req.user._id.toString()) {
            return res.status(403).json({ message: 'Not authorized to update this meeting' });
        }

        meeting.title = req.body.title || meeting.title;
        await meeting.save();

        return res.json(meeting);
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

const promoteToCoHost = async (req, res) => {
    try {
        const meeting = await Meeting.findById(req.params.id);
        
        if (!meeting) {
            return res.status(404).json({ message: 'Meeting not found' });
        }
        
        if (String(meeting.hostId) !== String(req.user._id)) {
            return res.status(403).json({ message: 'Only host can promote co-hosts' });
        }

        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ message: 'User ID is required' });
        }

        if (!meeting.coHosts.map(String).includes(String(userId))) {
            meeting.coHosts.push(userId);
            await meeting.save();
        }
        
        return res.json({ message: 'Promoted to co-host', coHosts: meeting.coHosts });
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

const removeCoHost = async (req, res) => {
    try {
        const meeting = await Meeting.findById(req.params.id);
        
        if (!meeting) {
            return res.status(404).json({ message: 'Meeting not found' });
        }
        
        if (String(meeting.hostId) !== String(req.user._id)) {
            return res.status(403).json({ message: 'Only host can manage co-hosts' });
        }

        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ message: 'User ID is required' });
        }

        meeting.coHosts = meeting.coHosts.filter(id => String(id) !== String(userId));
        await meeting.save();
        
        return res.json({ message: 'Co-host removed', coHosts: meeting.coHosts });
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

const getPinnedMeetings = async (req, res) => {
    try {
        let meetings = await Meeting.find({ hostId: req.user._id, isPinned: true }).sort({ createdAt: -1 });
        if (meetings.length === 0) {
            meetings = await Meeting.find({ hostId: req.user._id }).sort({ createdAt: -1 }).limit(4);
        }
        return res.json(meetings);
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

const getMeetingActivity = async (req, res) => {
    try {
        const oneYearAgo = new Date();
        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
        
        const meetings = await Meeting.find({ hostId: req.user._id, createdAt: { $gte: oneYearAgo } }).select('createdAt title');
        
        const heatmapWeeks = Array.from({ length: 52 }, () => Array.from({ length: 7 }, () => 0));
        
        meetings.forEach(m => {
            const diffTime = Math.abs(new Date() - new Date(m.createdAt));
            const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
            if (diffDays <= 364) {
                const weekIdx = 51 - Math.floor(diffDays / 7);
                const dayIdx = new Date(m.createdAt).getDay();
                if(weekIdx >= 0 && weekIdx < 52) {
                    heatmapWeeks[weekIdx][dayIdx] += 1;
                }
            }
        });
        
        const timelineMap = {};
        
        meetings.forEach(m => {
            const date = new Date(m.createdAt);
            const monthYear = date.toLocaleString('default', { month: 'long', year: 'numeric' });
            
            if (!timelineMap[monthYear]) {
                timelineMap[monthYear] = { month: monthYear, events: [] };
            }
            
            // Limit to 5 events per month to not overload
            if (timelineMap[monthYear].events.length < 5) {
                timelineMap[monthYear].events.push({
                    type: 'meeting',
                    text: `Hosted meeting: ${m.title}`,
                    date: date.toLocaleDateString(),
                    icon: 'camera'
                });
            }
        });

        // Convert map to array and sort descending
        const timeline = Object.values(timelineMap).sort((a, b) => {
            return new Date(b.month) - new Date(a.month);
        });

        // Provide a default empty state if there are no meetings
        if (timeline.length === 0) {
            timeline.push({
                month: new Date().toLocaleString('default', { month: 'long', year: 'numeric' }),
                events: [
                    { type: 'setting', text: 'Joined the platform', date: new Date().toLocaleDateString(), icon: 'settings' }
                ]
            });
        }

        return res.json({
            totalMeetings: meetings.length,
            heatmap: heatmapWeeks,
            timeline: timeline
        });
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

module.exports = { createMeeting, getMeetingByCode, getMyMeetings, deleteMeeting, updateMeeting, promoteToCoHost, removeCoHost, getPinnedMeetings, getMeetingActivity };
