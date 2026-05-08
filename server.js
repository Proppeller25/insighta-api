const express = require('express')
const mongoose = require('mongoose')
const cors = require('cors')
const cookieParser = require('cookie-parser')
const morgan = require('morgan')
const fs = require('fs')
const path = require('path')


const Profile = require('./models/profileModel')
const json = require('./seed_profiles.json')
require('dotenv').config()

const profileRoutes = require('./routes/profileRoutes')
const userRoutes = require('./routes/userRoutes')
const auth = require('./middleware/auth')
const rateLimit = require('./middleware/rateLimit')

const app = express()
const allowedOrigins = [
  'http://localhost:3001', 
  'http://localhost:5173', 
  'https://insighta-web-portal-black.vercel.app',
  'https://egbebo-stage3.vercel.app'
]
const corsOptions = {
  credentials: true,
  origin: (origin, callback) => {
    // Allow requests with no origin (like curl, mobile apps) or in non-production
    if (!origin || process.env.NODE_ENV !== 'production') {
      callback(null, true);
    } else if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
}
const PORT = process.env.PORT || 3000
let connectionPromise = null

const apiRateLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  message: 'Too many requests, please try again later.',
  keyPrefix: 'api',
  keyGenerator: (req) => req.user?.id || req.ip || 'unknown'
})

app.use(cors(corsOptions))
app.use(cookieParser(process.env.COOKIE_SECRET || process.env.JWT_SECRET || 'insighta-cookie-secret'))
app.use(express.json())

const isProduction = process.env.NODE_ENV === 'production' || process.env.ENVIRONMENT === 'production'

// In development, write request logs to both the console and a local file.
// In production/serverless, keep console logging only because the filesystem may be read-only.
const morganMiddlewares = [morgan('combined')]
if (!isProduction) {
  const accessLogPath = path.join(__dirname, 'access.log')
  const accessLogStream = fs.createWriteStream(accessLogPath, { flags: 'a' })
  morganMiddlewares.push(morgan('combined', { stream: accessLogStream }))
}

morganMiddlewares.forEach((middleware) => app.use(middleware))

const connectDB = async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is not set')
  }

  if (mongoose.connection.readyState === 1) {
    return mongoose.connection
  }

  if (!connectionPromise) {
    connectionPromise = mongoose.connect(process.env.MONGODB_URI)
  }

  try {
    await connectionPromise
    return mongoose.connection
  } catch (error) {
    connectionPromise = null
    throw error
  }
}

app.get('/', (req, res) => {
  res.json({ message: 'Hello from the server!' })
})

app.get('/api/classify', auth, apiRateLimit, async (req, res) => {
  try {
    await connectDB()

    const { name } = req.query

    if (!name || name.trim().length === 0 || name === "''") {
      return res.status(400).json({ status: 'error', message: 'Missing or empty name parameter' })
    }

    if (typeof name !== 'string') {
      return res.status(422).json({ status: 'error', message: 'Name is not a string' })
    }

    const apiRes = await fetch(`https://api.genderize.io?name=${encodeURIComponent(name)}`)
    const apiData = await apiRes.json()

    if (!apiData.gender || !apiData.count) {
      return res.json({ status: 'error', message: 'No apiData or prediction available for the provided name' })
    }

    const response = {
      name,
      gender: apiData.gender,
      probability: apiData.probability,
      sample_Size: apiData.count,
      is_confident: apiData.probability >= 0.7 && apiData.count >= 100,
      processed_at: new Date().toISOString()
    }

    return res.status(200).json({
      status: 'success',
      data: response
    })
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: 'An error occurred while processing the request.'
    })
  }
})

const ensureDatabaseConnection = async (req, res, next) => {
  try {
    await connectDB()
    next()
  } catch (error) {
    next(error)
  }
}

app.use('/auth', ensureDatabaseConnection)
app.use('/users', ensureDatabaseConnection)
app.use('/api', ensureDatabaseConnection)

app.use('/', userRoutes)
app.use('/api', profileRoutes)
app.use('/api', userRoutes)
// app.use('/api/v1', profileRoutes)

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error)
  }

  return res.status(500).json({
    status: 'error',
    message: error.message || 'Internal server error'
  })
})

const seedData = async () => {
  await connectDB()

  const allNames = json.map((profile) => profile.name.trim().toLowerCase())
  const existingProfiles = await Profile.find({ name: { $in: allNames } }).select('name')
  const existingNames = existingProfiles.map((profile) => profile.name)
  const profilesToInsert = []

  for (const profile of json) {
    const normalizedName = profile.name.trim().toLowerCase()

    if (!existingNames.includes(normalizedName)) {
      profilesToInsert.push({
        name: normalizedName,
        gender: profile.gender,
        gender_probability: profile.gender_probability,
        age: profile.age,
        age_group: profile.age_group,
        country_id: profile.country_id,
        country_name: profile.country_name,
        country_probability: profile.country_probability
      })
    }
  }

  if (profilesToInsert.length > 0) {
    await Profile.insertMany(profilesToInsert)
    console.log(`${profilesToInsert.length} profiles inserted into database`)
    return
  }

  console.log('Database already seeded')
}

if (require.main === module) {
  connectDB()
    .then(() => {
      console.log('Connected to database')
      app.listen(PORT, () => console.log(`Local server running on port ${PORT}`))
    })
    .then(() => seedData())
    .catch((error) => {
      console.error('Database connection failed:', error.message)
    })
}

app.connectDB = connectDB
app.seedData = seedData

// Vercel serverless handler
module.exports = app
