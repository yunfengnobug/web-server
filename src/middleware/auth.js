const jwt = require('jsonwebtoken')

const JWT_SECRET = process.env.JWT_SECRET || 'web-manage-jwt-secret-2024'

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ code: 401, message: '未登录或 token 已过期' })
  }

  const token = authHeader.split(' ')[1]

  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    req.user = decoded
    next()
  } catch {
    return res.status(401).json({ code: 401, message: 'token 无效或已过期' })
  }
}

module.exports = authMiddleware
