const express = require('express');
const { registerUser, authUser, guestLogin, getUserProfile, updateUserProfile, forgotPassword, googleAuth, followUser, unfollowUser, searchUsers } = require('../controllers/userController');
const { protect } = require('../middleware/authMiddleware');
const router = express.Router();

router.post('/register', registerUser);
router.post('/login', authUser);
router.post('/guest-login', guestLogin);
router.route('/profile').get(protect, getUserProfile).put(protect, updateUserProfile);
router.get('/search', protect, searchUsers);
router.post('/forgot-password', forgotPassword);
router.post('/google-auth', googleAuth);
router.post('/follow/:id', protect, followUser);
router.post('/unfollow/:id', protect, unfollowUser);

module.exports = router;
