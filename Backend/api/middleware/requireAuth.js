const jwt = require('jsonwebtoken')
const { JWT_SECRET } = require('../../src/config')

// Xác thực bằng JWT (Authorization: Bearer) do /api/auth/login cấp cho web admin React
module.exports = (req, res, next) => {
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    try {
      req.user = jwt.verify(authHeader.slice(7), JWT_SECRET)
      return next()
    } catch {
      // Token hết hạn hoặc sai → 401 bên dưới
    }
  }
  res.status(401).json({ error: 'Chưa đăng nhập' })
}
