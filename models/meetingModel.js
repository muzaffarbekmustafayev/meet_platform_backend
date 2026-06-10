const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const meetingSchema = mongoose.Schema({
    hostId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    title: {
        type: String,
        required: true,
        trim: true,
        maxlength: 120
    },
    meetingCode: {
        type: String,
        unique: true,
        required: true,
        index: true
    },
    roomType: {
        type: String,
        enum: ['public', 'private'],
        default: 'public'
    },
    password: {
        type: String,
        select: false
    },
    status: {
        type: String,
        enum: ['scheduled', 'active', 'completed'],
        default: 'active'
    },
    startTime: {
        type: Date,
        default: Date.now
    },
    endTime: Date,
    coHosts: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    settings: {
        isChatEnabled: { type: Boolean, default: true },
        isWaitingRoomEnabled: { type: Boolean, default: false },
        muteAllOnEntry: { type: Boolean, default: false },
        allowScreenSharing: { type: Boolean, default: true }
    },
    isPinned: {
        type: Boolean,
        default: false
    },
    deletedAt: {
        type: Date,
        default: null,
        index: true
    }
}, {
    timestamps: true
});

meetingSchema.index({ hostId: 1, createdAt: -1 });
meetingSchema.index({ hostId: 1, isPinned: 1, createdAt: -1 });

meetingSchema.pre('save', async function () {
    if (!this.isModified('password') || !this.password) return;
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
});

meetingSchema.methods.matchPassword = async function (entered) {
    if (!this.password) return false;
    return await bcrypt.compare(entered, this.password);
};

const Meeting = mongoose.model('Meeting', meetingSchema);

module.exports = Meeting;
