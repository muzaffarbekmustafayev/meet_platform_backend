const express = require('express');
const { createMeeting, getMeetingByCode, getMyMeetings, deleteMeeting, updateMeeting, promoteToCoHost, removeCoHost, getPinnedMeetings, getMeetingActivity } = require('../controllers/meetingController');
const { protect } = require('../middleware/authMiddleware');
const router = express.Router();

router.route('/').post(protect, createMeeting).get(protect, getMyMeetings);
router.route('/pinned').get(protect, getPinnedMeetings);
router.route('/activity').get(protect, getMeetingActivity);
router.route('/:code').get(getMeetingByCode);
router.route('/:id').delete(protect, deleteMeeting).put(protect, updateMeeting);
router.route('/:id/cohost').post(protect, promoteToCoHost).delete(protect, removeCoHost);

module.exports = router;
