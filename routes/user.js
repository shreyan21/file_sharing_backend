// routes/auth.js
import express from 'express';
import crypto from 'crypto';
import { pool } from '../dbConfig.js'; // DB connection pool
import nodemailer from 'nodemailer';
import bcrypt from 'bcrypt';
import validator from 'email-validator';

const user_router = express.Router();

// Email transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL,
    pass: process.env.EMAIL_PASSWORD,
  },
});

user_router.post('/add', async (req, res) => {
  const { name, email, phone, password } = req.body;

  try {
    // Validate input
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Name, email, and password are required' });
    }

    // Check email format using is_email_valid
    if (validator.validate(email)) {
      return res.status(400).json({ message: 'Invalid email format' });
    }

    // Generate a 6-digit verification code
    const verificationCode = crypto.randomInt(100000, 999999).toString();

    // Insert or update email verification record with new verification code
    await pool.request()
      .input('email', email)
      .input('verification_code', verificationCode)
      .query(`
        MERGE email_verification AS target
        USING (SELECT @email AS email) AS source
        ON target.email = source.email
        WHEN MATCHED THEN
          UPDATE SET verification_code = @verification_code, created_at = GETDATE()
        WHEN NOT MATCHED THEN
          INSERT (email, verification_code, created_at)
          VALUES (@email, @verification_code, GETDATE());
      `);

    // Send the verification code via email
    await transporter.sendMail({
      from: process.env.EMAIL,
      to: email,
      subject: 'Your Verification Code',
      text: `Your verification code is: ${verificationCode}`,
    });

   return res.status(200).json({ message: 'Verification code sent to email' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// Route: Verify the code and add the user to the database
user_router.post('/verify', async (req, res) => {
  const { name, email, phone, password, verification_code } = req.body;

  try {
    // Validate input
    if (!name || !email || !password || !verification_code) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    // Verify the email and code
    const verificationResult = await pool.request()
      .input('email', email)
      .input('verification_code', verification_code)
      .query(`
        SELECT * FROM email_verification
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
      .query(`
        INSERT INTO users (name, email, phone, password)
        VALUES (@name, @email, @phone, @password)
      `);

    // Remove the verification record
    await pool.request()
      .input('email', email)
      .query('DELETE FROM email_verification WHERE email = @email');

    return res.status(201).json({ message: 'User registered successfully' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

export default user_router;
