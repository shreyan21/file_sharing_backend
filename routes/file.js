import multer from 'multer'
import ftp from 'basic-ftp'
import path from 'path'
import fs from "fs"
import { Router } from 'express'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { pool } from '../config/db.js'


dotenv.config()
const file_route = Router()

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadDir = path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
    console.log("'uploads' folder created.");
}

// Set up Multer storage engine to save files temporarily locally
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}` + file.originalname);
    }
});

const upload = multer({ storage })
const ftpCredentials = {
    host: `${process.env.FTP_HOST}`,
    user: `${process.env.FTP_USER}`,
    password: `${process.env.FTP_PASSWORD}`,
    port: 21,
    passive: true

}
if (!fs.existsSync("./uploads")) {
    fs.mkdirSync("./uploads");
}
file_route.post("/upload", upload.single("file"), async (req, res) => {
    if (!req.file) {
        return res.status(400).send("No file uploaded.");
    }

    const getemail = await pool.request().input('email', req.body.email).query('select * from users where email=@email')
    if (getemail.recordset.length === 0) {
        return res.status(401).json({ message: 'User not registered' })
    }
    const localFilePath = path.join(__dirname, "uploads", req.file.filename);

    // The remote path of the directory created for you on the FTP server
    const remoteFilePath = `/files/${req.file.filename}`; // Example: `/files/uploads/`

    try {
        // Create an FTP client instance
        const client = new ftp.Client();
        //
        client.ftp.verbose = true; // Optional: Enable verbose logging for debugging

        // Connect to the FTP server
        await client.access(ftpCredentials);

        // Upload the file from local to remote FTP server
        await client.uploadFrom(localFilePath, remoteFilePath);
        const { email } = req.body

        await pool.request().input('uploaded_by', email).input('filename', req.file.filename).query('Insert into filestorage(filename,uploaded_by) values(@filename,@uploaded_by);')
        await fs.promises.unlink(localFilePath);

        client.close();
        return res.status(200).send("File uploaded successfully to FTP server!");

        // Close the FTP connection
    } catch (error) {
        console.error("FTP upload error:", error);
        return res.status(500).send("Error uploading file to FTP server.");
    }
});
file_route.get('/file/:remotePath', async (req, res) => {
    const remotePath = decodeURIComponent(req.params.remotePath); // Get and decode the file path
    if (!remotePath) {
        return res.status(400).send("Missing file path.");
    }

    try {
        // Set headers to indicate the file type (optional, depending on file type)
        res.setHeader('Content-Disposition', `attachment; filename="${remotePath.split('/').pop()}"`);

        // Download the file from FTP server and stream it to the client
        await downloadFileFromFtp(remotePath, res);

        // After the download completes, no further response needed
    } catch (error) {
        console.error("Error during file download:", error);
        res.status(500).send("Error downloading the file.");
    }
});


async function downloadFileFromFtp(remotePath, res) {

    try {


        // Stream the file from FTP to the response object
        await client.downloadTo(res, remotePath);
    } catch (error) {
        console.error("Error downloading file:", error);
        res.status(500).send("Error downloading file.");
    } finally {
        client.close();
    }
}
export default file_route
