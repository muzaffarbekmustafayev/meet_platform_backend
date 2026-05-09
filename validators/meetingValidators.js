const Joi = require('joi');

const createMeetingSchema = Joi.object({
    title: Joi.string().trim().max(120).allow('').optional(),
    roomType: Joi.string().valid('public', 'private').default('public'),
    password: Joi.string().min(6).max(64).allow('').optional()
});

const updateMeetingSchema = Joi.object({
    title: Joi.string().trim().max(120).optional(),
    isPinned: Joi.boolean().optional()
});

const cohostSchema = Joi.object({
    userId: Joi.string().hex().length(24).required()
});

const updatePasswordSchema = Joi.object({
    oldPassword: Joi.string().min(1).required(),
    newPassword: Joi.string().min(6).max(64).required()
        .messages({ 'string.min': 'New password must be at least 6 characters' })
});

module.exports = { createMeetingSchema, updateMeetingSchema, cohostSchema, updatePasswordSchema };
