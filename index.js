require("dotenv").config();

const express = require("express");
const passport = require("passport");
const session = require("express-session");
const bodyParser = require("body-parser");
const { User } = require("./models/user.model");
const { File } = require("./models/file.model");
const connectDB = require("./db");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const MongoStore = require('connect-mongo');
const AWS = require('aws-sdk');
const path = require('path');
const cron = require('node-cron');
const fs = require('fs');
const { cleanupOldZipFiles } = require('./cleanup'); // Import the cleanup function
const { Folder } = require('./models/folder.model');
const AdmZip = require('adm-zip');
const { Upload } = require('@aws-sdk/lib-storage');

const { S3Client, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const multer = require('multer');
const app = express();
// Schedule the cleanup job to run every hour
cron.schedule('0 * * * *', () => {
    console.log('Running cleanup job...');
    cleanupOldZipFiles();
});


app.use(bodyParser.json());
app.use(express.static('public'));
const http = require('http');
const { Server } = require("socket.io");

// Create an HTTP server
const server = http.createServer(app);

// Initialize Socket.IO with the server
const io = new Server(server);

// Listen for WebSocket connections
io.on('connection', (socket) => {
    console.log('A user connected');

    // Handle disconnections
    socket.on('disconnect', () => {
        console.log('A user disconnected');
    });
});

app.use(
    session({
        secret: "secret",
        resave: false,
        saveUninitialized: true,
        store: MongoStore.create({
            mongoUrl: process.env.MONGO_URI,
            collectionName: 'sessions',
            ttl: 14 * 24 * 60 * 60,  // Session expiration in seconds (14 days)
        }),
        cookie: {
            maxAge: 1000 * 60 * 60 * 24 * 14  // Cookie expiration (14 days)
        }
    })
);

app.use(passport.initialize());
app.use(passport.session());

passport.use(
    new GoogleStrategy(
        {
            clientID: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            callbackURL: process.env.CALLBACK_URL,
        },
        (accessToken, refreshToken, profile, done) => {
            return done(null, profile);
        }
    )
);

passport.serializeUser((user, done) => {
    done(null, user);
});

passport.deserializeUser((user, done) => {
    done(null, user);
});

app.get("/", (req, res) => {
    res.send("<a href='/auth/google'> Login To Google  </a>");
});

app.get(
    "/auth/google",
    passport.authenticate("google", { scope: ["profile", "email"] })
);

app.get(
    "/auth/google/callback",
    passport.authenticate("google", { failureRedirect: "/" }),
    (req, res) => {
        res.redirect("/profile");
    }
);

app.get("/profile", ensureAuthenticated, async (req, res) => {
    // console.log(req);
    const userAlreadyPresent = await User.findOne({ googleId: req.user.id });
   
    if (userAlreadyPresent== null) {
        await User.create({
            username: req.user.displayName,
            googleId: req.user.id,
            email: req.user.emails[0].value,
        });
    }
    res.sendFile(path.join(__dirname, 'public', 'profile.html'));
    
  
});
// Route to fetch all folders
app.get('/folders', async (req, res) => {
    try {
        const folders = await Folder.find();
        res.json({ success: true, folders });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get("/api/user", ensureAuthenticated, async (req, res) => {
    const user = await User.findOne({ googleId: req.user.id });
    res.json({ username: user.username });
});

function ensureAuthenticated (req, res, next) {
    if (req.isAuthenticated()) {
        return next();
    }
    res.redirect('/');
}

app.get("/logout", (req, res) => {
    req.logout();
    res.redirect("/");
});

// Configure AWS SDK v3 S3 client
const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

// Set up multer for file uploads
const upload = multer({
    storage: multer.memoryStorage(),  // Temporarily store file in memory
});

// Route to serve the upload form (only for authenticated users)
app.get("/upload", ensureAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'upload.html'));
});

// Handle file upload to S3 and save metadata in MongoDB
app.post("/upload", upload.single('file'), ensureAuthenticated, async (req, res) => {
    try {
        const { file } = req;
        const userGoogleId = req.user.id;  // Get googleId from the authenticated user
        const folderId = req.body.folderId;  // Folder ID from the request body

        const uploadParams = {
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: `${Date.now()}-${file.originalname}`,  // File path in S3
            Body: file.buffer,  // File data
            ACL: 'public-read',  // File access control
        };

        // Upload file to S3 using AWS SDK v3
        const uploadResult = await new Upload({
            client: s3Client,
            params: uploadParams,
        }).done();

        // Save file metadata in MongoDB
        const newFile = new File({
            filename: file.originalname,
            url: uploadResult.Location,  // S3 file URL
            size: file.size,
            folderId: folderId,  // Store the folder ID
            googleId: userGoogleId,  // Save the googleId of the user uploading the file
            key: uploadParams.Key,  // Save the file key
        });

        await newFile.save();

        // *** Update the Folder with the new file reference ***
        await Folder.findByIdAndUpdate(
            folderId,
            { $push: { files: newFile._id } },  // Push the file ID into the folder's `files` array
            { new: true }
        );

        // Notify via socket
        io.emit('file-uploaded', { filename: file.originalname });

        // Redirect to profile
        res.redirect("/profile");
    } catch (error) {
        console.error('Error uploading file:', error);
        res.status(500).json({ error: 'Error uploading file' });
    }
});

app.get("/files", ensureAuthenticated, async (req, res) => {
const userGoogleId = req.user.id;  // Get googleId from authenticated user

try {
    // Fetch files and folders for the authenticated user based on googleId
    const files = await File.find({ googleId: userGoogleId });  // Fetch files for this user
    const folders = await Folder.find({ googleId: userGoogleId });  // Fetch folders for this user

    // Return both files and folders in response
    res.json({ success: true, files, folders });
} catch (error) {
    console.error('Error fetching files and folders:', error);
    res.status(500).json({ error: 'Error fetching files and folders' });
}
 });




//delete file
app.delete('/files/delete/:fileKey', ensureAuthenticated, async (req, res) => {
    const fileKey = req.params.fileKey;

    try {
        const params = {
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: fileKey,  // Use the file key from the request
        };

        // Create a DeleteObjectCommand
        const command = new DeleteObjectCommand(params);

        // Send the command using the s3Client
        await s3Client.send(command);

        // Also delete file metadata from MongoDB
        await File.deleteOne({ key: fileKey });
        // Emit notification for file delete
        io.emit('Removing the file', { filename: fileKey });
res.json({ success: true });
        
    } catch (error) {
        console.error('Error deleting file:', error);
        res.status(500).json({ error: 'Error deleting file' });
    }
});
app.get('/files/download/:fileKey', ensureAuthenticated, async (req, res) => {
    const fileKey = req.params.fileKey;

    try {
        const params = {
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: fileKey,  // Use the file key from the request
        };

        // Create a GetObjectCommand
        const command = new GetObjectCommand(params);

        // Send the command using the s3Client
        const file = await s3Client.send(command);
        // Emit notification for file download
        io.emit('file-download-started', { filename: fileKey });
        res.attachment(fileKey);
        // Stream the file content back as a download
        file.Body.pipe(res);
    } catch (error) {
        console.error('Error downloading file:', error);
        res.status(500).json({ error: 'Error downloading file' });
    }
});

// Get contents of a folder (files and subfolders)
app.get('/folders/:folderId/contents', ensureAuthenticated, async (req, res) => {
    const folderId = req.params.folderId;
    const userGoogleId = req.user.id;

    try {
        // Fetch subfolders
        const subfolders = await Folder.find({ parentFolder: folderId, googleId: userGoogleId });

        // Fetch files in this folder
        const files = await File.find({ folder: folderId, googleId: userGoogleId });

        res.json({ success: true, subfolders, files });
    } catch (error) {
        console.error('Error fetching folder contents:', error);
        res.status(500).json({ error: 'Error fetching folder contents' });
    }
});


// POST route to create a new folder
app.post('/folders', ensureAuthenticated, async (req, res) => {
    const userGoogleId = req.user.id;  // Ensure user id is obtained from authenticated user

    const folderName = req.body.name;

    try {
        // Create a new folder document in MongoDB
        const newFolder = new Folder({
            name: folderName,
            googleId: userGoogleId  // Attach the googleId to the folder
        });

        // Save the folder
        await newFolder.save();

        res.json({ success: true, folder: newFolder });
    } catch (error) {
        console.error('Error creating folder:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});
// DELETE: Delete a folder
app.delete('/folders/delete/:folderId', async (req, res) => {
    const { folderId } = req.params;

    try {
        // Find the folder by ID
        const folder = await Folder.findById(folderId);
        if (!folder) {
            return res.status(404).json({ success: false, message: 'Folder not found' });
        }

        // Optionally, delete files from the file system
        // folder.files.forEach(file => {
        //     console.log(file);
        //     const filePath = path.join(__dirname, 'uploads', file); // Adjust path as needed
        //     fs.unlink(filePath, (err) => {
        //         if (err) {
        //             console.error(`Error deleting file: ${filePath}`, err);
        //         }
        //     });
        // });

        // Delete the folder from the database
        await Folder.findByIdAndDelete(folderId);
        res.json({ success: true, message: 'Folder deleted successfully.' });
    } catch (error) {
        console.error('Error deleting folder:', error);
        res.status(500).json({ success: false, message: 'Error deleting folder.' });
    }
});

app.get('/folders/download/:folderId', async (req, res) => {
    const { folderId } = req.params;

    try {
        // Find the folder by ID
       
        const folder = await Folder.findById(folderId).populate('files');
        if (!folder) {
            return res.status(404).json({ success: false, message: 'Folder not found' });
        }

        // Ensure the folder has files to download
        if (!Array.isArray(folder.files) || folder.files.length === 0) {
            return res.status(400).json({ success: false, message: 'No files found in this folder.' });
        }

        // Create a temporary directory if it doesn't exist
        const tempDir = path.join(__dirname, 'temp');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir);
        }

        // Create a new ZIP archive using adm-zip
        const zip = new AdmZip();

        // Iterate over files in the folder
        for (const file of folder.files) {
            const params = {
                Bucket: process.env.AWS_BUCKET_NAME, // Your S3 bucket name
                Key: file.key // S3 file key (stored in MongoDB)
            };

            // Get the file from S3
            const command = new GetObjectCommand(params);
            const fileStream = await s3Client.send(command).then(response => response.Body);

            // Store the file temporarily on the local system
            const tempFilePath = path.join(tempDir, file.filename);
            const tempFileWriteStream = fs.createWriteStream(tempFilePath);

            // Pipe the S3 stream to a local file
            fileStream.pipe(tempFileWriteStream);

            // Wait until the file is fully written before adding to ZIP
            await new Promise((resolve, reject) => {
                tempFileWriteStream.on('finish', () => {
                    // Add the local file to the ZIP archive
                    zip.addLocalFile(tempFilePath);
                    resolve();
                });
                tempFileWriteStream.on('error', reject);
            });
        }

        // Specify the zip file path
        const zipFilePath = path.join(__dirname, 'downloads', `${folder.name}.zip`);
        zip.writeZip(zipFilePath);

        // Send the ZIP file to the client for download
        res.download(zipFilePath, `${folder.name}.zip`, (err) => {
            if (err) {
                console.error('Error during ZIP download:', err);
            }

            // Optionally, clean up the temp ZIP file after download
            fs.unlink(zipFilePath, (err) => {
                if (err) {
                    console.error(`Error deleting ZIP file: ${zipFilePath}`, err);
                }
            });

            // Optionally, delete the temporary files stored locally
            folder.files.forEach(file => {
                const tempFilePath = path.join(tempDir, file.filename);
                fs.unlink(tempFilePath, (err) => {
                    if (err) {
                        console.error(`Error deleting temporary file: ${tempFilePath}`, err);
                    }
                });
            });
        });

    } catch (error) {
        console.error('Error downloading folder:', error);
        res.status(500).json({ success: false, message: 'Error downloading folder.' });
    }
});





connectDB()
    .then(() => {
        server.listen(3000, () => {
            console.log("Server is running on port 3000");
        });
    })
    .catch((err) => {
        console.log(err);
    });
