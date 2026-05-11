const asyncHandler = require('express-async-handler');
const crypto = require('crypto');
const User = require('../models/userModel');
const generateToken = require('../config/generateToken');
const escapeRegex = require('../utils/escapeRegex');

const sendUser = (user, withToken = false) => {
    const payload = {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        avatar: user.avatar,
        bio: user.bio,
        links: user.links || [],
        contactsCount: user.contactsCount,
        followersCount: user.followersCount
    };
    if (withToken) payload.token = generateToken(user._id);
    return payload;
};

const registerUser = asyncHandler(async (req, res) => {
    const { name, email, password, role } = req.body;

    const userExists = await User.findOne({ email });
    if (userExists) {
        res.status(409);
        throw new Error('User with this email already exists');
    }

    const safeRole = role === 'admin' ? 'user' : (role || 'user');

    const user = await User.create({
        name,
        email,
        password,
        role: safeRole
    });

    if (!user) {
        res.status(400);
        throw new Error('Invalid user data received');
    }
    return res.status(201).json(sendUser(user, true));
});

const authUser = asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const user = await User.findOne({ email });

    if (!user || !(await user.matchPassword(password))) {
        res.status(401);
        throw new Error('Invalid email or password');
    }
    if (user.isBlocked) {
        res.status(403);
        throw new Error('Your account is blocked by administration');
    }

    return res.json(sendUser(user, true));
});

const guestLogin = asyncHandler(async (req, res) => {
    const { name, email } = req.body;
    // Always create a fresh guest record. Synthesize a unique email so a
    // guest can never inherit a previous guest user's identity by reusing
    // an arbitrary email address.
    const rand = crypto.randomBytes(6).toString('hex');
    const synthEmail = `guest+${Date.now()}.${rand}@guest.local`;

    const guestUser = await User.create({
        name,
        email: synthEmail,
        role: 'guest',
        bio: email ? `Guest contact: ${email}` : undefined
    });

    return res.json(sendUser(guestUser, true));
});

const getUserProfile = asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id)
        .populate('followers', '_id name email avatar')
        .populate('following', '_id name email avatar');

    if (!user) {
        res.status(404);
        throw new Error('User not found');
    }
    return res.json({
        ...sendUser(user, false),
        followers: user.followers || [],
        following: user.following || []
    });
});

const updateUserProfile = asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id);
    if (!user) {
        res.status(404);
        throw new Error('User not found');
    }

    if (req.body.name !== undefined) user.name = req.body.name;
    if (req.body.bio !== undefined) user.bio = req.body.bio;
    if (Array.isArray(req.body.links)) user.links = req.body.links.slice(0, 5);

    if (req.body.password) {
        const ok = await user.matchPassword(req.body.currentPassword || '');
        if (!ok) {
            res.status(400);
            throw new Error('Current password is incorrect');
        }
        user.password = req.body.password;
    }

    const updatedUser = await user.save();
    return res.json(sendUser(updatedUser, true));
});

const forgotPassword = asyncHandler(async (req, res) => {
    // Email-sending is not implemented. We respond identically whether the
    // email exists or not to avoid user enumeration.
    res.status(200).json({
        message: 'If an account exists for this email, a reset link has been sent'
    });
});

const googleAuth = asyncHandler(async (req, res) => {
    const { token } = req.body;
    if (!token) {
        res.status(400);
        throw new Error('Google token required');
    }

    try {
        // Verify token with Google (using client-side validation for demo)
        // In production, verify at Google servers using google-auth-library
        const parts = token.split('.');
        if (parts.length !== 3) {
            res.status(401);
            throw new Error('Invalid token format');
        }

        // Decode payload (unsafe for production - use google-auth-library)
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        const { email, name, picture } = payload;

        if (!email) {
            res.status(400);
            throw new Error('Email not provided by Google');
        }

        // Find or create user
        let user = await User.findOne({ email });
        if (user) {
            // Update profile picture if available
            if (picture && !user.avatar) {
                user.avatar = picture;
                await user.save();
            }
        } else {
            // Create new user from Google profile
            user = await User.create({
                name: name || email.split('@')[0],
                email,
                avatar: picture,
                role: 'user',
                password: crypto.randomBytes(32).toString('hex') // Random password for OAuth users
            });
        }

        if (user.isBlocked) {
            res.status(403);
            throw new Error('Your account is blocked by administration');
        }

        return res.json(sendUser(user, true));
    } catch (error) {
        res.status(401);
        throw new Error('Invalid Google token: ' + error.message);
    }
});

const followUser = asyncHandler(async (req, res) => {
    const userToFollowId = req.params.id;
    const currentUserId = req.user._id;

    if (userToFollowId === currentUserId.toString()) {
        res.status(400);
        throw new Error('You cannot follow yourself');
    }

    const userToFollow = await User.findById(userToFollowId);
    if (!userToFollow) {
        res.status(404);
        throw new Error('User not found');
    }

    const followResult = await User.updateOne(
        { _id: userToFollowId, followers: { $ne: currentUserId } },
        { $push: { followers: currentUserId }, $inc: { followersCount: 1 } }
    );
    if (followResult.modifiedCount === 0) {
        res.status(400);
        throw new Error('You are already following this user');
    }
    await User.updateOne(
        { _id: currentUserId, following: { $ne: userToFollowId } },
        { $push: { following: userToFollowId }, $inc: { contactsCount: 1 } }
    );

    const fresh = await User.findById(userToFollowId).select('followersCount');
    return res.json({ message: 'Successfully followed user', followersCount: fresh.followersCount });
});

const unfollowUser = asyncHandler(async (req, res) => {
    const userToUnfollowId = req.params.id;
    const currentUserId = req.user._id;

    const userToUnfollow = await User.findById(userToUnfollowId);
    if (!userToUnfollow) {
        res.status(404);
        throw new Error('User not found');
    }

    const result = await User.updateOne(
        { _id: userToUnfollowId, followers: currentUserId },
        { $pull: { followers: currentUserId }, $inc: { followersCount: -1 } }
    );
    if (result.modifiedCount === 0) {
        res.status(400);
        throw new Error('You are not following this user');
    }
    await User.updateOne(
        { _id: currentUserId, following: userToUnfollowId },
        { $pull: { following: userToUnfollowId }, $inc: { contactsCount: -1 } }
    );

    const fresh = await User.findById(userToUnfollowId).select('followersCount');
    return res.json({ message: 'Successfully unfollowed user', followersCount: fresh.followersCount });
});

const searchUsers = asyncHandler(async (req, res) => {
    const raw = (req.query.q || '').toString().trim();
    if (!raw || raw.length < 2) return res.json([]);

    const safe = escapeRegex(raw).slice(0, 60);
    const users = await User.find({
        _id: { $ne: req.user._id },
        role: { $ne: 'guest' },
        $or: [
            { name: { $regex: safe, $options: 'i' } },
            { email: { $regex: safe, $options: 'i' } }
        ]
    })
        .select('_id name email avatar role')
        .limit(20);
    return res.json(users);
});

module.exports = {
    registerUser,
    authUser,
    guestLogin,
    getUserProfile,
    updateUserProfile,
    forgotPassword,
    googleAuth,
    followUser,
    unfollowUser,
    searchUsers
};
