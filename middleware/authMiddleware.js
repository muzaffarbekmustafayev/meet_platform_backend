const jwt = require('jsonwebtoken');
const asyncHandler = require('express-async-handler');
const User = require('../models/userModel');

const protect = asyncHandler(async (req, res, next) => {
    let token;
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
        token = auth.slice(7);
    }

    if (!token) {
        res.status(401);
        throw new Error('Not authorized, no token provided');
    }

    let decoded;
    try {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
        res.status(401);
        throw new Error('Not authorized, token failed or expired');
    }

    const user = await User.findById(decoded.id).select('-password');
    if (!user) {
        res.status(401);
        throw new Error('Not authorized, user not found');
    }
    if (user.isBlocked) {
        res.status(403);
        throw new Error('Your account is blocked by administration');
    }

    req.user = user;
    next();
});

const admin = (req, res, next) => {
    if (req.user && req.user.role === 'admin') return next();
    res.status(403);
    next(new Error('Forbidden, admin privileges required'));
};

const host = (req, res, next) => {
    if (req.user && (req.user.role === 'user' || req.user.role === 'admin' || req.user.role === 'guest')) return next();
    res.status(403);
    next(new Error('Forbidden, login required to create meetings'));
};

module.exports = { protect, admin, host };
