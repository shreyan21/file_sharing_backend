// dbConfig.js
import dotenv from 'dotenv'
import sql from 'mssql'
dotenv.config()
const config = {
    user: `${process.env.DB_USER}`,      // Replace with your SQL Server username
    password: `${process.env.DB_PASSWORD}`,  // Replace with your SQL Server password
    server: `${process.env.DB_SERVER}`,  // Replace with your server name or IP address
    database: `${process.env.DATABASE}`,  // Name of your database
    options: {
      encrypt: true,           // Use encryption if your SQL Server requires it
      trustServerCertificate: true // If using a self-signed certificate
    },
  }


  const pool=await sql.connect(config)
  export {pool}
  