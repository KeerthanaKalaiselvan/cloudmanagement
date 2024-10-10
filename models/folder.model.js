const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const folderSchema = new Schema({
    name: {
        type: String,
        required: true,
    },
    parentFolder: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Folder',  // Self-reference to support nested folders
        default: null,  // Root folders will have `null` as parent
    },
    googleId: {
        type: String,
        required: true,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    }
});

const Folder = mongoose.model('Folder', folderSchema);

module.exports = { Folder };
