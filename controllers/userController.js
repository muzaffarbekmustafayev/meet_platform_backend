const User = require('../models/userModel');
const generateToken = require('../config/generateToken');

const registerUser = async (req, res) => {
    try {
        const { name, email, password, role, username } = req.body;

        if (!name || !email || !password || !username) {
            return res.status(400).json({ message: 'Please enter all fields including username' });
        }

        const userExists = await User.findOne({ $or: [{ email }, { username }] });

        if (userExists) {
            return res.status(400).json({ message: 'User with this email or username already exists' });
        }

        const user = await User.create({
            name,
            email,
            username,
            password,
            role: role || 'user'
        });

        if (user) {
            return res.status(201).json({
                _id: user._id,
                name: user.name,
                email: user.email,
                username: user.username,
                role: user.role,
                avatar: user.avatar,
                token: generateToken(user._id)
            });
        } else {
            return res.status(400).json({ message: 'Invalid user data received' });
        }
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

const authUser = async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ message: 'Please provide email and password' });
        }

        const user = await User.findOne({ email });

        if (user && (await user.matchPassword(password))) {
            if (user.isBlocked) {
                return res.status(403).json({ message: 'Your account is blocked by administration' });
            }

            return res.json({
                _id: user._id,
                name: user.name,
                email: user.email,
                role: user.role,
                avatar: user.avatar,
                token: generateToken(user._id)
            });
        } else {
            return res.status(401).json({ message: 'Invalid email or password' });
        }
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

const getUserProfile = async (req, res) => {
    try {
        const user = await User.findById(req.user._id)
            .populate('followers', '_id name email avatar')
            .populate('following', '_id name email avatar');

        if (user) {
            return res.json({
                _id: user._id,
                name: user.name,
                email: user.email,
                username: user.username,
                role: user.role,
                avatar: user.avatar,
                bio: user.bio,
                links: user.links || [],
                contactsCount: user.contactsCount,
                followersCount: user.followersCount,
                followers: user.followers || [],
                following: user.following || []
            });
        } else {
            return res.status(404).json({ message: 'User not found' });
        }
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};


const updateUserProfile = async (req, res) => {
    try {
        const user = await User.findById(req.user._id);

        if (user) {
            user.name = req.body.name || user.name;
            user.bio = req.body.bio !== undefined ? req.body.bio : user.bio;
            if (req.body.links && Array.isArray(req.body.links)) {
                user.links = req.body.links.slice(0, 5); // Max 5 links
            }
            if (req.body.password) {
                user.password = req.body.password;
            }

            const updatedUser = await user.save();

            return res.json({
                _id: updatedUser._id,
                name: updatedUser.name,
                email: updatedUser.email,
                username: updatedUser.username,
                role: updatedUser.role,
                avatar: updatedUser.avatar,
                bio: updatedUser.bio,
                links: updatedUser.links,
                contactsCount: updatedUser.contactsCount,
                followersCount: updatedUser.followersCount,
                token: generateToken(updatedUser._id)
            });
        } else {
            return res.status(404).json({ message: 'User not found' });
        }
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

const forgotPassword = async (req, res) => {
    try {
        const { email } = req.body;
        const user = await User.findOne({ email });

        if (!user) {
            return res.status(404).json({ message: 'User with this email does not exist' });
        }

        // Normally, generate a token, save to DB, and send email here.
        // For demonstration, we just return success.
        return res.status(200).json({ message: 'Reset link sent to your email' });
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

const googleAuth = async (req, res) => {
    try {
        // Mock Google Auth logic
        return res.status(501).json({ message: 'Google Authentication requires real Client ID implementation.' });
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

const followUser = async (req, res) => {
    try {
        const userToFollowId = req.params.id;
        const currentUserId = req.user._id;

        if (userToFollowId === currentUserId.toString()) {
            return res.status(400).json({ message: "You cannot follow yourself" });
        }

        const userToFollow = await User.findById(userToFollowId);
        const currentUser = await User.findById(currentUserId);

        if (!userToFollow || !currentUser) {
            return res.status(404).json({ message: "User not found" });
        }

        if (!userToFollow.followers.includes(currentUserId)) {
            userToFollow.followers.push(currentUserId);
            userToFollow.followersCount = userToFollow.followers.length;
            await userToFollow.save();

            currentUser.following.push(userToFollowId);
            currentUser.contactsCount = currentUser.following.length;
            await currentUser.save();

            return res.json({ message: "Successfully followed user", followersCount: userToFollow.followersCount });
        } else {
            return res.status(400).json({ message: "You are already following this user" });
        }
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

const unfollowUser = async (req, res) => {
    try {
        const userToUnfollowId = req.params.id;
        const currentUserId = req.user._id;

        const userToUnfollow = await User.findById(userToUnfollowId);
        const currentUser = await User.findById(currentUserId);

        if (!userToUnfollow || !currentUser) {
            return res.status(404).json({ message: "User not found" });
        }

        if (userToUnfollow.followers.includes(currentUserId)) {
            userToUnfollow.followers = userToUnfollow.followers.filter(id => id.toString() !== currentUserId.toString());
            userToUnfollow.followersCount = userToUnfollow.followers.length;
            await userToUnfollow.save();

            currentUser.following = currentUser.following.filter(id => id.toString() !== userToUnfollowId.toString());
            currentUser.contactsCount = currentUser.following.length;
            await currentUser.save();

            return res.json({ message: "Successfully unfollowed user", followersCount: userToUnfollow.followersCount });
        } else {
            return res.status(400).json({ message: "You are not following this user" });
        }
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

const searchUsers = async (req, res) => {
    try {
        const query = req.query.q;
        if (!query) {
            return res.json([]);
        }
        const users = await User.find({
            $or: [
                { username: { $regex: query, $options: 'i' } },
                { name: { $regex: query, $options: 'i' } }
            ]
        }).select('_id name email username avatar role');
        return res.json(users);
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

module.exports = { registerUser, authUser, getUserProfile, updateUserProfile, forgotPassword, googleAuth, followUser, unfollowUser, searchUsers };
