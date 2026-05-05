const jwt = require('jsonwebtoken');
const User = require('../models/userModel');

const protect = async (req, res, next) => {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
        return res.status(401).json({ message: 'Not authorized, no token provided' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = await User.findById(decoded.id).select('-password');

        if (!req.user) {
            return res.status(401).json({ message: 'Not authorized, user not found' });
        }

        if (req.user.isBlocked) {
            return res.status(401).json({ message: 'Not authorized, user is blocked by administration' });
        }

        next();
    } catch (error) {
        return res.status(401).json({ message: 'Not authorized, token failed or expired' });
    }
};

const admin = (req, res, next) => {
    if (req.user && req.user.role === 'admin') {
        next();
    } else {
        return res.status(403).json({ message: 'Forbidden, admin privileges required' });
    }
};

// All authenticated non-guest users can create/manage meetings
const host = (req, res, next) => {
    if (req.user && (req.user.role === 'user' || req.user.role === 'admin')) {
        next();
    } else {
        return res.status(403).json({ message: 'Forbidden, login required to create meetings' });
    }
};

module.exports = { protect, admin, host };
