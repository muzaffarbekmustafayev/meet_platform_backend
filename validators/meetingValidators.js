const Joi = require('joi');

// Xona sozlamalari — yaratishda ham, jonli yangilashda ham bir xil shakl.
const settingsSchema = Joi.object({
    isChatEnabled:        Joi.boolean(),
    isWaitingRoomEnabled: Joi.boolean(),
    muteAllOnEntry:       Joi.boolean(),
    allowScreenSharing:   Joi.boolean()
});

const createMeetingSchema = Joi.object({
    title:    Joi.string().trim().max(120).allow('').optional(),
    roomType: Joi.string().valid('public', 'private').default('public'),
    password: Joi.string().min(6).max(64).allow('').optional(),
    settings: settingsSchema.optional()
});

// Jonli sozlama yangilash — kamida bitta maydon kerak (bo'sh obyekt rad etiladi).
const updateSettingsSchema = settingsSchema.min(1);

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

module.exports = { createMeetingSchema, updateMeetingSchema, cohostSchema, updatePasswordSchema, updateSettingsSchema };
