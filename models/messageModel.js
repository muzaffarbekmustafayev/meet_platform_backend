const mongoose = require('mongoose');

const messageSchema = mongoose.Schema({
    meetingId: {
        type: String,
        required: true,
        index: true
    },
    senderId: {
        type: String,
        required: true
    },
    senderName: String,
    text: {
        type: String,
        default: '',
        maxlength: 2000
    },
    // Chatda ulashilgan fayl (base64 data URL ko'rinishida saqlanadi)
    file: {
        name: { type: String, maxlength: 255 },
        type: { type: String, maxlength: 150 },
        size: { type: Number, min: 0 },
        data: { type: String }
    }
}, {
    timestamps: true
});

// Xabar matnsiz bo'lsa ham, hech bo'lmasa fayl bo'lishi shart
messageSchema.pre('validate', function (next) {
    const hasText = this.text && this.text.trim();
    const hasFile = this.file && this.file.data;
    if (!hasText && !hasFile) return next(new Error('Message must have text or a file'));
    next();
});

messageSchema.index({ meetingId: 1, createdAt: 1 });

const Message = mongoose.model('Message', messageSchema);

module.exports = Message;
