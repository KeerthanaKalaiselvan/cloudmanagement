const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const fileSchema = new mongoose.Schema({
    filename: {
        type: String,
        required: true,
    },
    url: {
        type: String,
        required: true,
    },
    size: {
        type: Number,
        required: true,
    },
    folderId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Folder',  // Reference to the folder
    },
    googleId: {
        type: String,  // Store Google ID for the user who uploaded the file
        required: true,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
    key: {
        type: String,
        required: true,
    },
});

const File = mongoose.model('File', fileSchema);
module.exports = { File };
