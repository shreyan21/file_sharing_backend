import express from 'express';
import crypto from 'crypto';
import { pool } from '../config/db.js'; // Ensure this is your SQL Server pool
import nodemailer from 'nodemailer';
import bcrypt from 'bcryptjs';
import validator from 'email-validator';
import jwt from 'jsonwebtoken'

const user_router = express.Router();

// Email transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL, // Your email
    pass: process.env.EMAIL_PASSWORD, // Your email password or app-specific password
  },
});
const htmlEmailTemplate = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
      body {
        font-family: Arial, sans-serif;
        margin: 0;
        padding: 0;
        background-color: #f4f4f9;
      }
      .email-container {
        width: 100%;
        max-width: 600px;
        margin: 30px auto;
        background-color: #ffffff;
        padding: 20px;
        border-radius: 8px;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
      }
      .email-header {
        text-align: center;
        margin-bottom: 20px;
      }
      .email-header img {
        width: 150px;
        margin-bottom: 20px;
      }
      .email-body {
        font-size: 16px;
        line-height: 1.5;
        color: #333333;
        margin-bottom: 20px;
      }
      .verification-code {
        font-size: 24px;
        font-weight: bold;
        color: #4CAF50;
        margin: 20px 0;
      }
      .cta-button {
        display: inline-block;
        padding: 12px 25px;
        background-color: #4CAF50;
        color: white;
        text-decoration: none;
        font-weight: bold;
        border-radius: 5px;
        text-align: center;
      }
      .footer {
        text-align: center;
        font-size: 12px;
        color: #999999;
        margin-top: 30px;
      }
      .footer a {
        color: #4CAF50;
        text-decoration: none;
      }
    </style>
  </head>
  <body>
    <div class="email-container">
      <div class="email-header">
        <h2>Email Verification Code</h2>
      </div>
      <div class="email-body">
        <p>Hello <strong>{{name}}</strong>,</p>
        <p>Thank you for registering with us. To complete your registration, please enter the following 6-digit verification code:</p>
        <div class="verification-code">{{verificationCode}}</div>
        <p>This code will expire in 10 minutes. If you did not request this verification code, please ignore this email.</p>
        <a href="http://192.168.1.194:3000/signup/verify" class="cta-button">Verify Your Email</a>
      </div>
      <div class="footer">
        <p>&copy; ${new Date().getFullYear()} Systomat Solutions. All rights reserved.</p>
        <p>Need help? <a href="mailto:support@your-company.com">Contact Support</a></p>
      </div>
    </div>
  </body>
  </html>
`;


// POST Route to Add User and Send Verification Code
user_router.post('/add', async (req, res) => {
  const { name, email, phone, password } = req.body;

  try {
    // Validate input
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Name, email, and password are required' });
    }

    // Check email format
    if (!validator.validate(email)) {
      return res.status(400).json({ message: 'Invalid email format' });
    }

    // Check if email already exists in the users table
    const existingUser = await pool.request()
      .input('email', email)
      .query('SELECT * FROM users WHERE email = @email');

    if (existingUser.recordset.length > 0) {
      return res.status(400).json({ message: 'User with this email already exists' });
    }

    // Generate a 6-digit verification code
    const verificationCode = crypto.randomInt(100000, 999999).toString();
    const existingVerification = await pool.request()
      .input('email', email)
      .query('SELECT * FROM email_verifications WHERE email = @email');

    // If an existing verification record is found, update it with the new verification code
    if (existingVerification.recordset.length > 0) {
      await pool.request()
        .input('email', email)
        .input('verification_code', verificationCode)
        .query(`
        UPDATE email_verifications
        SET verification_code = @verification_code
        WHERE email = @email;
      `);
    }
    else {
      // Otherwise, insert a new record for this email and the verification code
      await pool.request()
        .input('email', email)
        .input('verification_code', verificationCode)
        .query(`
              INSERT INTO email_verifications (email, verification_code)
              VALUES (@email, @verification_code);
            `);
    }

    // Insert the email and verification code into the email_verifications table
    await pool.request()
      .input('email', email)
      .input('verification_code', verificationCode)
      .query(`
        MERGE email_verifications AS target
        USING (SELECT @email AS email) AS source
        ON target.email = source.email
        WHEN MATCHED THEN
          UPDATE SET verification_code = @verification_code
        WHEN NOT MATCHED THEN
          INSERT (email, verification_code)
          VALUES (@email, @verification_code);
      `);

    // Send the verification code via email
    await transporter.sendMail({
      from: process.env.EMAIL,
      to: email,
      subject: 'Your Verification Code',
      html: htmlEmailTemplate.replace('{{name}}', name).replace('{{verificationCode}}', verificationCode),
    });

    return res.status(200).json({ message: 'Verification code sent to email' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

user_router.post('/verify', async (req, res) => {
  const { name, email, phone, password, verification_code } = req.body;

  try {
    // Validate input
    if (!name || !email || !password || !verification_code) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    // Verify the email and code from the email_verifications table
    const verificationResult = await pool.request()
      .input('email', email)
      .input('verification_code', verification_code)
      .query(`
        SELECT * FROM email_verifications
        WHERE email = @email AND verification_code = @verification_code
      `);

    if (verificationResult.recordset.length === 0) {
      return res.status(400).json({ message: 'Invalid or expired verification code' });
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert the user into the users table
    await pool.request()
      .input('name', name)
      .input('email', email)
      .input('phone', phone || null) // Insert phone if provided, otherwise NULL
      .input('password', hashedPassword)
      .input('permissions', 'can_read') // Default permissions
      .query(`
        INSERT INTO users (name, email, phone, password, permissions)
        VALUES (@name, @email, @phone, @password, @permissions)
      `);

    // Remove the verification record after user is successfully added
    await pool.request()
      .input('email', email)
      .query('DELETE FROM email_verifications WHERE email = @email');

    return res.status(201).json({ message: 'User registered successfully' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

user_router.post('/signin', async (req, res) => {
  try {
    const { email, password } = req.body
    const result = await pool.request().input('email', email).input('password', password).query(`select email from users where email=@email`)
    if (result.recordset.length === 0) {
      return res.status(404).json({ message: 'User not registered' })
    }
    else {
     const token= jwt.sign({
        email, name:result.recordset[0].name
      }, process.env.SECRET_KEY)
      return res.status(200).json({token})

    }

  }
  catch (e) {
    return res.status(500).json(e)

  }
})

export default user_router;
