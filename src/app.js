const express = require('express')
const cors = require('cors')
require('dotenv').config()

const { initDb } = require('./db')
const authRoutes = require('./routes/auth')
const cardKeyRoutes = require('./routes/cardKey')

const app = express()
const PORT = process.env.PORT || 3000

app.use(cors())
app.use(express.json())

app.use('/api/auth', authRoutes)
app.use('/api/card-keys', cardKeyRoutes)

app.use((err, _req, res, _next) => {
  console.error(err)
  res.status(500).json({ code: 500, message: '服务器内部错误' })
})

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`)
    })
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err)
    process.exit(1)
  })
