const Joi = require('joi');

const createMeetingSchema = Joi.object({
    title:    Joi.string().trim().max(120).allow('').optional(),
    roomType: Joi.string().valid('public', 'private').default('public'),
    password: Joi.string().min(6).max(64).allow('').optional()
});

const updateMeetingSchema = Joi.object({
    title:    Joi.string().trim().max(120).optional(),
    isPinned: Joi.boolean().optional()
});

const cohostSchema = Joi.object({
    userId: Joi.string().hex().length(24).required()
});

// Host can set a new password or leave empty to make the room public
const updatePasswordSchema = Joi.object({
    password: Joi.string().min(6).max(64).allow('').optional()
        .messages({ 'string.min': 'Password must be at least 6 characters' })
});

module.exports = { createMeetingSchema, updateMeetingSchema, cohostSchema, updatePasswordSchema };
