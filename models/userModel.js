const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true,
        maxlength: 80
    },
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true
    },
    links: [{
        title: String,
        url: String
    }],
    password: {
        type: String,
        required: function () { return this.role !== 'guest'; },
        minlength: 6
    },
    avatar: {
        type: String,
        default: "https://icon-library.com/images/anonymous-avatar-icon/anonymous-avatar-icon-25.jpg"
    },
    role: {
        type: String,
        enum: ['admin', 'user', 'guest'],
        default: 'user'
    },
    isBlocked: {
        type: Boolean,
        default: false
    },
    bio: {
        type: String,
        default: 'Zamonaviy video aloqa tizimi ishqibozi.'
    },
    contactsCount: {
        type: Number,
        default: 0
    },
    followersCount: {
        type: Number,
        default: 0
    },
    followers: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    following: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    googleId: String
}, {
    timestamps: true
});

userSchema.index({ name: 'text' });
userSchema.index({ role: 1 });

userSchema.pre('save', async function () {
    if (!this.isModified('password') || !this.password) return;
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
});

userSchema.methods.matchPassword = async function (enteredPassword) {
    if (!this.password) return false;
    return await bcrypt.compare(enteredPassword, this.password);
};

userSchema.methods.toSafeJSON = function () {
    const obj = this.toObject();
    delete obj.password;
    delete obj.__v;
    return obj;
};

const User = mongoose.model('User', userSchema);

module.exports = User;
