import express from 'express'
import user_router from './routes/user.js'
import dotenv from 'dotenv'
dotenv.config()
const app=express()

app.use(express.json())

app.use('/user',user_router)


app.listen(process.env.PORT)