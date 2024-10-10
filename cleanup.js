// cleanup.js
const fs = require('fs');
const path = require('path');

// Path to the directory where ZIP files are stored
const downloadsDir = path.join(__dirname, 'downloads');

function cleanupOldZipFiles () {
    fs.readdir(downloadsDir, (err, files) => {
        if (err) {
            console.error('Error reading downloads directory:', err);
            return;
        }

        const now = Date.now();
        const oneHour = 60 * 60 * 1000; // 1 hour in milliseconds

        files.forEach(file => {
            const filePath = path.join(downloadsDir, file);
            fs.stat(filePath, (err, stats) => {
                if (err) {
                    console.error('Error getting file stats:', err);
                    return;
                }

                // Check if the file is older than 1 hour
                if (now - stats.mtimeMs > oneHour) {
                    // Delete the file
                    fs.unlink(filePath, err => {
                        if (err) {
                            console.error('Error deleting file:', err);
                        } else {
                            console.log(`Deleted old ZIP file: ${filePath}`);
                        }
                    });
                }
            });
        });
    });
}

module.exports = { cleanupOldZipFiles };
