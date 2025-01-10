import multer from 'multer';
import ftp from 'basic-ftp';
import path from 'path';
import fs from "fs";
import { Router } from 'express';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { pool } from '../config/db.js';
import mime from 'mime-types'
import { authenticate } from '../middleware/authentication.js';

dotenv.config();
const file_route = Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadDir = path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
    console.log("uploads' folder created.");
}

// Set up Multer storage engine to save files temporarily locally
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});

const upload = multer({ storage });
const ftpCredentials = {
    host: `${process.env.FTP_HOST}`,
    user: `${process.env.FTP_USER}`,
    password: `${process.env.FTP_PASSWORD}`,
    port: 21,
    passive: true
};

// if (!fs.existsSync("./uploads")) {
//     fs.mkdirSync("./uploads");
// }

file_route.post("/upload", [authenticate, upload.single("file")], async (req, res) => {
    if (!req.file) {
        return res.status(400).send("No file uploaded.");
    }

    const result = await pool.request().input('email', req.body.email).query('SELECT email FROM users WHERE email = @email');
    // if (result.recordset.length === 0) {
    //     return res.status(401).json({ message: 'User not registered' });
    // }

    const localfilepath = path.join(__dirname, "uploads", req.file.filename);
    const remotefilepath = path.join("files/", `${req.file.filename}`);
    let { can_read = [], can_edit = [], can_download = [] } = req.body;

    try {
        // Parse the fields if they are sent as JSON strings
        if (can_edit && typeof can_edit === 'string') {
            can_edit = JSON.parse(can_edit);
        }

        if (can_read && typeof can_read === 'string') {
            can_read = JSON.parse(can_read);
        }

        if (can_download && typeof can_download === 'string') {
            can_download = JSON.parse(can_download);
        }

        // Create an FTP client instance
        const client = new ftp.Client();
        client.ftp.verbose = true; // Optional: Enable verbose logging for debugging

        // Connect to the FTP server
        await client.access(ftpCredentials);

        // Upload the file from local to remote FTP server
        const list = await client.list("/files")
        const filenames = list.map(file => file.filename || file.name);  // Modify this as per the actual response structure

        // Check if the file already exists
        const fileExists = filenames.some(e => e === req.file.filename);  // 'some' is more efficient than 'filter'

        if (fileExists) {
            return res.status(409).json({ message: 'File with this name is already present' });
        }
        await client.uploadFrom(localfilepath, remotefilepath);

        // Insert file details into the filestorage table
        await pool.request()
            .input('uploaded_by', result.recordset[0].email)
            .input('filename', req.file.filename)
            .query('INSERT INTO filestorage (filename, uploaded_by) VALUES (@filename, @uploaded_by);');

        // Function to insert or update permissions for users
        const setPermissions = async (emailList, permissionType, permissionValue) => {
            for (const userEmail of emailList) {
                await pool.request()
                    .input('user_email', userEmail)
                    .input('filename', req.file.filename)
                    .input('permission_type', permissionType)
                    .input('permission_value', permissionValue)
                    .query(`
                        IF EXISTS (SELECT 1 FROM file_permissions WHERE user_email = @user_email AND file_name = @filename)
                        BEGIN
                            -- Update the permission record for this user
                            UPDATE file_permissions
                            SET ${permissionType} = @permission_value
                            WHERE user_email = @user_email AND file_name = @filename;
                        END
                        ELSE
                        BEGIN
                            -- Insert the permission record for this user
                            INSERT INTO file_permissions (user_email, file_name, ${permissionType})
                            VALUES (@user_email, @filename, @permission_value);
                        END
                    `);
            }
        };

        // Step 1: Set permissions for users in the can_edit array
        if (can_edit.length > 0) {
            await setPermissions(can_edit, 'can_edit', 'YES');
            await setPermissions(can_edit, 'can_read', 'YES');
            await setPermissions(can_edit, 'can_download', 'YES');
        }

        // Step 2: Set permissions for users in the can_download array (but not in can_edit)
        const canDownloadNotEdit = can_download.filter(email => !can_edit.includes(email));
        if (canDownloadNotEdit.length > 0) {
            await setPermissions(canDownloadNotEdit, 'can_read', 'YES');
            await setPermissions(canDownloadNotEdit, 'can_download', 'YES');
            await setPermissions(canDownloadNotEdit, 'can_edit', 'NO');
        }

        // Step 3: Set permissions for users in the can_read array (but not in can_edit or can_download)
        const canReadNotEditOrDownload = can_read.filter(email => !can_edit.includes(email) && !can_download.includes(email));
        if (canReadNotEditOrDownload.length > 0) {
            await setPermissions(canReadNotEditOrDownload, 'can_read', 'YES');
            await setPermissions(canReadNotEditOrDownload, 'can_download', 'NO');
            await setPermissions(canReadNotEditOrDownload, 'can_edit', 'NO');
        }

        // Delete the file from the local uploads directory after upload
        try {
            await fs.promises.unlink(localfilepath);
            console.log(`Successfully deleted file: ${localfilepath}`);
        } catch (err) {
            console.error(`Failed to delete file: ${localfilepath}`, err);
        }

        // Close the FTP connection
        client.close();

        return res.status(200).json({ message: "File uploaded successfully to FTP server and permissions set!" });

    } catch (e) {
        console.log(e);
        return res.status(500).send({ message: "Error uploading file to FTP server." });
    }
});




file_route.get('/showfiles', authenticate, async (req, res) => {
    const client = new ftp.Client();
    client.ftp.verbose = true;

    try {
        // Connect to the FTP server
        await client.access(ftpCredentials);

        // List all files in the 'files/' directory
        const fileList = await client.list('files/');

        // Prepare file metadata (name, size, etc.)
        const files = fileList.map(file => ({
            name: file.name,   // Name of the file
            size: file.size,   // Size of the file in bytes
            modifiedDate: file.modifiedAt, // Last modified date
            isDirectory: file.isDirectory, // Whether it is a directory
        }));

        // Return the file metadata to the frontend
        return res.status(200).json({ files });

    } catch (error) {
        console.error('Error fetching files from FTP server:', error);
        return res.status(500).send('Error fetching files');
    } finally {
        client.close();
    }
});
file_route.get('/showfile/:filename', authenticate, async (req, res) => {
    const { filename } = req.params;
    const client = new ftp.Client();
    client.ftp.verbose = true;

    try {
        // Connect to the FTP server
        await client.access(ftpCredentials);

        // Define the file path on the FTP server
        const filePath = `files/${filename}`;

        // Check if the file exists by trying to list the files in the directory
        const fileList = await client.list('files');
        const fileExists = fileList.some(file => file.name === filename);

        if (!fileExists) {
            return res.status(404).send('File not found on FTP server');
        }

        // Set MIME type for the file based o
        // n extension (image, pdf, etc.)
        const mimeType = mime.lookup(filename) || 'application/octet-stream';  // Default MIME type if none is found
        res.setHeader('Content-Type', mimeType);

        // Send the file size as a header to the client
        const fileStats = await client.size(filePath);
        res.setHeader('Content-Length', fileStats);

        // Stream the file directly to the response (client)
        await client.downloadTo(res, filePath);

    } catch (error) {
        console.error('Error fetching file from FTP server:', error);
        // Make sure the response is only sent once
        if (!res.headersSent) {
            return res.status(500).send('Error fetching file from FTP server');
        }
    } finally {
        // Always close the FTP client
        client.close();
    }
});

file_route.delete('/removefile/:filename', authenticate, async (req, res) => {
    const { filename } = req.params;
    const client = new ftp.Client();
    client.ftp.verbose = true;
    try {
        await client.access(ftpCredentials)
        const remotefilepath = `/files/${filename}`
        if (!filename) {
            return res.status(404).json({ message: 'File not found' })
        }
        await pool.request().input('filename', filename).query('delete from filestorage where filename=@filename')
        await client.remove(remotefilepath)
        return res.status(200).json({ message: 'File removed' })
    }
    catch (e) {
        return res.status(500).json({ message: 'Error deleting file' })
    }
})
export default file_route;
