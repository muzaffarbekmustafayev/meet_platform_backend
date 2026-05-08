const express = require('express');
const router = express.Router();
const {
    getStats, getAllUsers, updateUserRole, toggleBlockUser, createUser,
    updateUser, deleteUser, getAllMeetings, deleteMeeting
} = require('../controllers/adminController');
const { protect, admin } = require('../middleware/authMiddleware');
const { validate, validateObjectId } = require('../middleware/validate');
const {
    adminCreateUserSchema, adminUpdateUserSchema, updateRoleSchema
} = require('../validators/userValidators');

router.use(protect, admin);

router.get('/stats', getStats);
router.get('/users', getAllUsers);
router.post('/users', validate(adminCreateUserSchema), createUser);
router.put('/users/:id', validateObjectId('id'), validate(adminUpdateUserSchema), updateUser);
router.delete('/users/:id', validateObjectId('id'), deleteUser);
router.put('/users/:id/role', validateObjectId('id'), validate(updateRoleSchema), updateUserRole);
router.put('/users/:id/block', validateObjectId('id'), toggleBlockUser);

router.get('/meetings', getAllMeetings);
router.delete('/meetings/:id', validateObjectId('id'), deleteMeeting);

module.exports = router;
