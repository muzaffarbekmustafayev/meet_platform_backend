const express = require('express');
const router = express.Router();
const {
    getStats, getAllUsers, exportUsers, updateUserRole, toggleBlockUser, createUser,
    updateUser, deleteUser, bulkUsers, getAllMeetings, exportMeetings, deleteMeeting
} = require('../controllers/adminController');
const { protect, admin } = require('../middleware/authMiddleware');
const { validate, validateObjectId } = require('../middleware/validate');
const {
    adminCreateUserSchema, adminUpdateUserSchema, updateRoleSchema, adminBulkUsersSchema
} = require('../validators/userValidators');

router.use(protect, admin);

router.get('/stats', getStats);

router.get('/users', getAllUsers);
router.get('/users/export', exportUsers);
router.post('/users', validate(adminCreateUserSchema), createUser);
router.post('/users/bulk', validate(adminBulkUsersSchema), bulkUsers);
router.put('/users/:id', validateObjectId('id'), validate(adminUpdateUserSchema), updateUser);
router.delete('/users/:id', validateObjectId('id'), deleteUser);
router.put('/users/:id/role', validateObjectId('id'), validate(updateRoleSchema), updateUserRole);
router.put('/users/:id/block', validateObjectId('id'), toggleBlockUser);

router.get('/meetings', getAllMeetings);
router.get('/meetings/export', exportMeetings);
router.delete('/meetings/:id', validateObjectId('id'), deleteMeeting);

module.exports = router;
