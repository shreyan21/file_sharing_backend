import jwt from 'jsonwebtoken'
import dotenv from 'dotenv'

dotenv.config()
const authenticate = async (req, res, next) => {
    try {
        const { usertoken } = req.headers
       
        const decode=jwt.verify(usertoken,process.env.SECRET_KEY)
        console.log(decode)
        next()
    }
    catch (e) {
        return res.status(401).json({message:'Invalid token'})

    }
}

export {authenticate}