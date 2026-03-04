const express = require('express')
const jwt = require('jsonwebtoken')
const authMiddleware = require('../middleware/auth')

const router = express.Router()

const JWT_SECRET = process.env.JWT_SECRET || 'web-manage-jwt-secret-2024'
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h'

// TODO: replace with database
const MOCK_USER = {
  id: 1,
  username: 'admin',
  password: 'admin123',
  name: '管理员',
  avatar: '',
}

router.post('/login', (req, res) => {
  const { username, password } = req.body

  if (!username || !password) {
    return res.json({ code: 400, message: '用户名和密码不能为空' })
  }

  if (username !== MOCK_USER.username || password !== MOCK_USER.password) {
    return res.json({ code: 401, message: '用户名或密码错误' })
  }

  const token = jwt.sign(
    { id: MOCK_USER.id, username: MOCK_USER.username },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN },
  )

  res.json({
    code: 200,
    message: '登录成功',
    data: {
      token,
      user: {
        id: MOCK_USER.id,
        username: MOCK_USER.username,
        name: MOCK_USER.name,
        avatar: MOCK_USER.avatar,
      },
    },
  })
})

router.get('/userinfo', authMiddleware, (req, res) => {
  res.json({
    code: 200,
    message: 'success',
    data: {
      id: MOCK_USER.id,
      username: MOCK_USER.username,
      name: MOCK_USER.name,
      avatar: MOCK_USER.avatar,
    },
  })
})

module.exports = router
