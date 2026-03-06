const express = require('express')
const cors = require('cors')
require('dotenv').config()

const { initDb } = require('./db')
const authRoutes = require('./routes/auth')
const cardsRoutes = require('./routes/cards')
const cardKeyRoutes = require('./routes/cardKey')
const cardClassRoutes = require('./routes/cardClass')
const cursorRoutes = require('./routes/cursor')
const verifyRecordRoutes = require('./routes/verifyRecord')
const userCardCategoryRoutes = require('./routes/userCardCategory')
const userCardRoutes = require('./routes/userCard')

const app = express()
const PORT = process.env.PORT || 3000

app.use(cors())
app.use(express.json())

app.use('/api/auth', authRoutes)
app.use('/api/cards', cardsRoutes)
app.use('/api/card-keys', cardKeyRoutes)
app.use('/api/card-classes', cardClassRoutes)
app.use('/api/cursor', cursorRoutes)
app.use('/api/verify-records', verifyRecordRoutes)
app.use('/api/user-card-categories', userCardCategoryRoutes)
app.use('/api/user-cards', userCardRoutes)

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
