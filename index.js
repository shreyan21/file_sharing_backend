import express from 'express'
import user_router from './routes/user.js'
import dotenv from 'dotenv'
import cors from 'cors'
dotenv.config()
const app=express()

app.use(express.json())
app.use(cors())

app.use('/user',user_router)

// this is a comment
app.listen(process.env.PORT)