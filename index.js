import express from 'express'
import user_router from './routes/user.js'
import dotenv from 'dotenv'
import cors from 'cors'
import file_route from './routes/file.js'
dotenv.config()
const app=express()

app.use(express.json())
app.use(express.urlencoded({extended:false}))
app.use(cors())

app.use('/user',user_router)
app.use('/file',file_route)

app.listen(process.env.PORT)