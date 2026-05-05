const mongoose = require('mongoose');

const meetingSchema = mongoose.Schema({
    hostId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    title: {
        type: String,
        required: true
    },
    meetingCode: {
        type: String,
        unique: true,
        required: true
    },
    password: {
        type: String
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
        isWaitingRoomEnabled: { type: Boolean, default: true },
        muteAllOnEntry: { type: Boolean, default: false },
        allowScreenSharing: { type: Boolean, default: true }
    },
    isPinned: {
        type: Boolean,
        default: false
    }
}, {
    timestamps: true
});

const Meeting = mongoose.model('Meeting', meetingSchema);

module.exports = Meeting;
