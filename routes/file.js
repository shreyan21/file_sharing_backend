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

if (!fs.existsSync("./uploads")) {
    fs.mkdirSync("./uploads");
}
const getFileType = (filename) => {
    const ext = filename.split('.').pop().toLowerCase();
    switch (ext) {
        case 'pdf': return 'pdf';
        case 'jpg':
        case 'jpeg': return 'image';
        case 'png': return 'image';
        case 'txt': return 'text';
        case 'doc':
        case 'docx': return 'word';
        case 'mp3': return 'audio';
        case 'mp4': return 'video';
        default: return 'file'; // Default for unknown file types
    }
}

// Function to assign an icon based on file type
const getFileIcon = (fileType) => {
    switch (fileType) {
        case 'pdf': return '📄'; // PDF icon
        case 'image': return '🖼️'; // Image icon
        case 'text': return '📃'; // Text file icon
        case 'word': return '📑'; // Word document icon
        case 'audio': return '🎵'; // Audio file icon
        case 'video': return '🎥'; // Video file icon
        default: return '📁'; // Default file icon
    }
}

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

        await pool.request().input('email', req.body.email).input('filename', req.file.filename).query(`insert into file_permissions(user_email,file_name,can_read,can_edit,can_download) values(@email,@filename,'YES','YES','YES')`)
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
            await setPermissions(can_edit, 'can_download', 'NO');
        }

        // Step 2: Set permissions for users in the can_download array 
        const canDownloadNotEdit = can_download.filter(email => !can_edit.includes(email));
        if (canDownloadNotEdit.length > 0) {
            await setPermissions(canDownloadNotEdit, 'can_read', 'YES');
            await setPermissions(canDownloadNotEdit, 'can_download', 'YES');
            await setPermissions(canDownloadNotEdit, 'can_edit', 'YES');
        }

        // Step 3: Set permissions for users in the can_read array
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




// Modify the /showfiles endpoint to return rich metadata
file_route.get('/showfiles', authenticate, async (req, res) => {
    const client = new ftp.Client();
    try {
        await client.access(ftpCredentials);
        const files = await client.list('/files');

        // Enhanced metadata response
        const fileData = files.map(file => ({
            filename: file.name,
            type: getFileType(file.name),
            icon: getFileIcon(getFileType(file.name)),
            size: file.size,
            modified: file.modifiedAt || file.date
        }));

        const result = await pool.request().input('email', req.user.email).query(`select * from file_permissions where user_email=@email`)
        const result2 = await pool.request().input('email', req.user.email).query(`select filename , uploaded_by from filestorage where uploaded_by=@email`)
        res.json({ fileData, permission: result.recordset, can_delete: result2.recordset });
    } catch (err) {
        console.error('Error fetching file list:', err);
        res.status(500).json({ error: 'Error fetching file list' });
    } finally {
        client.close();
    }
});

// Rename File Endpoint
file_route.put('/rename/:filename', authenticate, async (req, res) => {
    const { newName } = req.body;
    const { filename } = req.params;
    const client = new ftp.Client();

    try {
        // Verify new name validity
        if (!newName || newName.includes('/')) {
            return res.status(400).json({ error: 'Invalid file name' });
        }

        await client.access(ftpCredentials);

        // Check if new name exists
        const files = await client.list('/files');
        if (files.some(f => f.name === newName)) {
            return res.status(409).json({ error: 'File name already exists' });
        }

        // Rename on FTP server

        // Update database records
        await client.rename(`/files/${filename}`, `/files/${newName}`);
        await pool.request()
            .input('oldName', filename)
            .input('newName', newName)
            .query(`
            UPDATE filestorage
            SET filename = @newName
            WHERE filename = @oldName; 
            
           
            `);

        await pool.request().input('oldName', filename)
            .input('newName', newName)
            .query(`
           
            
            UPDATE file_permissions
            SET file_name = @newName
            WHERE file_name = @oldName;
            `)

        return res.json({ message: 'File renamed successfully', newName });
    } catch (err) {
        console.error('Renaming error:', err);
        res.status(500).json({ error: 'Error renaming file' });
    } finally {
        client.close();
    }
});

file_route.get('/showfiles/:filename', async (req, res) => {
    const client = new ftp.Client();
    try {
        await client.access(ftpCredentials);
        const folderpath = path.join(__dirname, 'uploads');

       

        const localFilePath = path.join(folderpath, req.params.filename);
        await client.downloadTo(localFilePath, `/files/${req.params.filename}`);

        const mimeType = mime.lookup(req.params.filename) || 'application/octet-stream';

        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Disposition', 'inline');

        const fileStream = fs.createReadStream(localFilePath);
        fileStream.pipe(res);

        fileStream.on('end', () => fs.unlinkSync(localFilePath));
        fileStream.on('error', () => fs.unlinkSync(localFilePath));

    } catch (err) {
        console.error('Error fetching file:', err);
        res.status(500).send('Error fetching file');
    } finally {
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
        return res.status(200).json({ message: 'File removed', deletedFile: filename })
    }
    catch (e) {
        return res.status(500).json({ message: 'Error deleting file' })
    }
})
export default file_route;
