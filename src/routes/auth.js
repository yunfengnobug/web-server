const express = require('express')
const jwt = require('jsonwebtoken')
const bcrypt = require('bcryptjs')
const { getPool } = require('../db')
const authMiddleware = require('../middleware/auth')

const router = express.Router()

const JWT_SECRET = process.env.JWT_SECRET || 'web-manage-jwt-secret-2024'
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h'
const INVITE_CODE = process.env.INVITE_CODE || 'lizhaoxin'

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  })
}

function formatUser(row) {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    avatar: row.avatar || '',
  }
}

router.post('/register', async (req, res) => {
  const { username, password, name, inviteCode } = req.body

  if (!username || !password || !name || !inviteCode) {
    return res.json({ code: 400, message: '所有字段都不能为空' })
  }

  if (inviteCode !== INVITE_CODE) {
    return res.json({ code: 400, message: '邀请码无效' })
  }

  const pool = getPool()
  const [existing] = await pool.execute('SELECT id FROM users WHERE username = ?', [username])

  if (existing.length > 0) {
    return res.json({ code: 400, message: '用户名已存在' })
  }

  const hashedPassword = await bcrypt.hash(password, 10)
  await pool.execute('INSERT INTO users (username, password, name) VALUES (?, ?, ?)', [
    username,
    hashedPassword,
    name,
  ])

  res.json({ code: 200, message: '注册成功' })
})

router.post('/login', async (req, res) => {
  const { username, password } = req.body

  if (!username || !password) {
    return res.json({ code: 400, message: '用户名和密码不能为空' })
  }

  const pool = getPool()
  const [rows] = await pool.execute('SELECT * FROM users WHERE username = ?', [username])

  if (rows.length === 0) {
    return res.json({ code: 401, message: '用户名或密码错误' })
  }

  const user = rows[0]
  const valid = await bcrypt.compare(password, user.password)

  if (!valid) {
    return res.json({ code: 401, message: '用户名或密码错误' })
  }

  res.json({
    code: 200,
    message: '登录成功',
    data: { token: signToken(user), user: formatUser(user) },
  })
})

router.get('/userinfo', authMiddleware, async (req, res) => {
  const pool = getPool()
  const [rows] = await pool.execute('SELECT id, username, name, avatar FROM users WHERE id = ?', [
    req.user.id,
  ])

  if (rows.length === 0) {
    return res.status(401).json({ code: 401, message: '用户不存在' })
  }

  res.json({ code: 200, message: 'success', data: formatUser(rows[0]) })
})

module.exports = router
