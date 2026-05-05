const User = require('../models/userModel');
const Meeting = require('../models/meetingModel');

const getStats = async (req, res) => {
    try {
        const totalUsers = await User.countDocuments();
        const totalMeetings = await Meeting.countDocuments();
        const users = await User.countDocuments({ role: 'user' });
        const admins = await User.countDocuments({ role: 'admin' });
        
        return res.json({
            totalUsers,
            totalMeetings,
            users,
            admins
        });
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

const getAllUsers = async (req, res) => {
    try {
        const users = await User.find({}).select('-password');
        return res.json(users);
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

const updateUserRole = async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        user.role = req.body.role || user.role;
        const updatedUser = await user.save();
        
        return res.json(updatedUser);
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

const toggleBlockUser = async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        user.isBlocked = !user.isBlocked;
        await user.save();
        
        return res.json({ message: `User ${user.isBlocked ? 'blocked' : 'unblocked'} successfully` });
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

const createUser = async (req, res) => {
    try {
        const { name, email, password, role } = req.body;
        
        if (!name || !email || !password) {
            return res.status(400).json({ message: 'Please provide all required fields' });
        }

        const userExists = await User.findOne({ email });
        if (userExists) {
            return res.status(400).json({ message: 'User with this email already exists' });
        }
        
        const user = await User.create({ name, email, password, role: role || 'user' });
        return res.status(201).json(user);
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

const updateUser = async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        user.name = req.body.name || user.name;
        user.email = req.body.email || user.email;
        user.role = req.body.role || user.role;
        
        if (req.body.password) {
            user.password = req.body.password;
        }
        
        const updatedUser = await user.save();
        return res.json(updatedUser);
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

const getAllMeetings = async (req, res) => {
    try {
        const meetings = await Meeting.find({}).populate('hostId', 'name email').sort({ createdAt: -1 });
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

        await meeting.deleteOne();
        return res.json({ message: 'Meeting deleted successfully' });
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

module.exports = {
    getStats,
    getAllUsers,
    updateUserRole,
    toggleBlockUser,
    createUser,
    updateUser,
    getAllMeetings,
    deleteMeeting
};
