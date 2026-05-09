const express = require('express');
const {
    createMeeting, getMeetingByCode, getMyMeetings, deleteMeeting, updateMeeting,
    changeMeetingPassword, promoteToCoHost, removeCoHost, getPinnedMeetings, getMeetingActivity
} = require('../controllers/meetingController');
const { protect, host } = require('../middleware/authMiddleware');
const { validate, validateObjectId } = require('../middleware/validate');
const { createMeetingSchema, updateMeetingSchema, cohostSchema, updatePasswordSchema } = require('../validators/meetingValidators');
const { roomPasswordLimiter } = require('../middleware/rateLimiters');

const router = express.Router();

router.route('/')
    .post(protect, host, validate(createMeetingSchema), createMeeting)
    .get(protect, getMyMeetings);

router.get('/pinned', protect, getPinnedMeetings);
router.get('/activity', protect, getMeetingActivity);

router.get('/:code', roomPasswordLimiter, getMeetingByCode);

router.route('/:id')
    .delete(protect, validateObjectId('id'), deleteMeeting)
    .put(protect, validateObjectId('id'), validate(updateMeetingSchema), updateMeeting);

router.put('/:id/password', protect, validateObjectId('id'), validate(updatePasswordSchema), changeMeetingPassword);

router.route('/:id/cohost')
    .post(protect, validateObjectId('id'), validate(cohostSchema), promoteToCoHost)
    .delete(protect, validateObjectId('id'), validate(cohostSchema), removeCoHost);

module.exports = router;
