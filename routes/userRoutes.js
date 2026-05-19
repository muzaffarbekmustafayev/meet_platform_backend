const express = require('express');
const {
    registerUser, authUser, getUserProfile, updateUserProfile,
    forgotPassword, googleAuth, followUser, unfollowUser, searchUsers
} = require('../controllers/userController');
const { protect } = require('../middleware/authMiddleware');
const { validate, validateObjectId } = require('../middleware/validate');
const { authLimiter, passwordResetLimiter } = require('../middleware/rateLimiters');
const {
    registerSchema, loginSchema, forgotPasswordSchema, updateProfileSchema
} = require('../validators/userValidators');

const router = express.Router();

router.post('/register', authLimiter, validate(registerSchema), registerUser);
router.post('/login', authLimiter, validate(loginSchema), authUser);
router.post('/forgot-password', passwordResetLimiter, validate(forgotPasswordSchema), forgotPassword);
router.post('/google-auth', authLimiter, googleAuth);

router.route('/profile')
    .get(protect, getUserProfile)
    .put(protect, validate(updateProfileSchema), updateUserProfile);

router.get('/search', protect, searchUsers);
router.post('/follow/:id', protect, validateObjectId('id'), followUser);
router.post('/unfollow/:id', protect, validateObjectId('id'), unfollowUser);

module.exports = router;
