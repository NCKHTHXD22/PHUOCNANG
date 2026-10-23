const router = require('express').Router()
const axios = require('axios')
const multer = require('multer')
const CONFIG = require('../../src/config')
const Feedback = require('../../src/models/Feedback')
const Category = require('../../src/models/Category')
const Citizen = require('../../src/models/Citizen')
const { saveImage } = require('../../src/utils/mediaStorage')
const { isPhone, normalizePhone } = require('../../src/services/feedbackService')
const { rateLimit } = require('../middleware/rateLimit')

const MAX_IMAGES = 5
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: MAX_IMAGES },
})

// Access token Zalo: chỉ nhận qua header Authorization để token KHÔNG nằm trên URL
// (URL bị ghi vào log Nginx, log trình duyệt và gửi kèm khi chuyển trang).
function getZaloAccessToken(req) {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) return header.slice(7).trim()
  return ''
}

// Chặn rút dữ liệu hàng loạt / dò mã qua các endpoint công khai
const publicRead = rateLimit({ name: 'public-read', windowMs: 60 * 1000, max: 60 })
const publicWrite = rateLimit({ name: 'public-write', windowMs: 10 * 60 * 1000, max: 10 })
const publicLogin = rateLimit({ name: 'public-login', windowMs: 10 * 60 * 1000, max: 20 })
const publicConsent = rateLimit({ name: 'public-consent', windowMs: 10 * 60 * 1000, max: 20 })

// GET /api/public/info — thông tin hiển thị cho ReportApp (tên đơn vị)
router.get('/info', publicRead, (req, res) => {
  res.json({ orgName: CONFIG.ORG_NAME, orgArea: CONFIG.ORG_AREA })
})

// GET /api/public/categories — danh sách danh mục cho ReportApp chọn (ẩn zaloGroupId nội bộ,
// tên đã bỏ tiền tố nội bộ để hiển thị gọn).
// Khi đã cấu hình CGY1022_LINHVUC_MAP thì chỉ trả danh mục ĐÃ map linhVucId 1022 — loại bỏ danh
// mục phụ trợ nội bộ hoặc rác test không dùng cho luồng phản ánh công dân.
router.get('/categories', publicRead, async (req, res) => {
  try {
    const { displayCategoryName, isMappedCategory, hasLinhVucMap } = require('../../src/services/cgy1022Service')
    const categories = await Category.find({}, 'name icon order').sort({ order: 1 }).lean()
    const official = hasLinhVucMap() ? categories.filter((c) => isMappedCategory(c.name)) : categories
    res.json({ categories: official.map((c) => ({ ...c, name: displayCategoryName(c.name) })) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/public/reverse-geocode — ReportApp gọi ngay sau khi bấm "Lấy vị trí tự động" để
// hiện tên địa chỉ ngay trên form.
router.get('/reverse-geocode', publicRead, async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat)
    const lng = parseFloat(req.query.lng)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'Thiếu hoặc sai lat/lng' })
    }
    const { reverseGeocodeAddress } = require('../../src/services/feedbackService')
    const address = await reverseGeocodeAddress(lat, lng)
    res.json({ address: address || '' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Đổi code OAuth v4 (Đăng nhập bằng Zalo, dùng cho ReportApp) lấy access_token cá nhân
async function exchangeCodeForToken(code) {
  const tokenRes = await axios.post(
    'https://oauth.zaloapp.com/v4/access_token',
    new URLSearchParams({ code, app_id: CONFIG.ZALO_APP_ID, grant_type: 'authorization_code' }),
    { headers: { secret_key: CONFIG.ZALO_APP_SECRET, 'Content-Type': 'application/x-www-form-urlencoded' } }
  )
  const accessToken = tokenRes.data?.access_token
  if (!accessToken) throw new Error(`Đăng nhập Zalo thất bại: ${JSON.stringify(tokenRes.data)}`)
  return accessToken
}

// Lấy profile thật từ Zalo bằng access_token — verify server-side, không tin userId
// do client tự gửi (tránh giả mạo danh tính để gửi phản ánh thay người khác)
// Token hết hạn / không hợp lệ → lỗi mang status 401 để ReportApp đưa người dân về màn đăng nhập.
async function fetchZaloProfile(accessToken) {
  let profileRes
  try {
    profileRes = await axios.get('https://graph.zalo.me/v2.0/me', {
      params: { fields: 'id,name,picture,phone' },
      headers: { access_token: accessToken },
      timeout: 10000,
    })
  } catch (e) {
    throw Object.assign(new Error(`Không kết nối được Zalo: ${e.message}`), { status: 502 })
  }
  const { id, name, picture, phone } = profileRes.data || {}
  if (!id) {
    throw Object.assign(new Error('Phiên đăng nhập Zalo đã hết hạn, vui lòng đăng nhập lại'), { status: 401 })
  }
  return { id: String(id), name: name || '', avatar: picture?.data?.url || '', phone: phone ? normalizePhone(phone) : '' }
}

// Trạng thái cho phép sử dụng SĐT trả về cho ReportApp:
// - granted=true  → đã đồng ý trước đó, form tự điền phone, KHÔNG hỏi lại
// - granted=false → hiện thông báo xin phép; suggestedPhone là SĐT Zalo trả về (nếu có) để điền sẵn
function consentInfo(citizen, profile) {
  if (citizen?.phoneConsent && citizen.phone) {
    return { granted: true, phone: citizen.phone, grantedAt: citizen.phoneConsentAt }
  }
  return { granted: false, phone: '', suggestedPhone: profile.phone || '' }
}

// POST /api/public/zalo-login — đổi code lấy access_token + profile cho ReportApp,
// đồng thời lưu/cập nhật người dân vào DB và trả trạng thái cho phép sử dụng SĐT.
router.post('/zalo-login', publicLogin, async (req, res) => {
  try {
    const { code } = req.body
    if (!code || typeof code !== 'string') return res.status(400).json({ error: 'Thiếu code đăng nhập Zalo' })
    const accessToken = await exchangeCodeForToken(code)
    const profile = await fetchZaloProfile(accessToken)

    const citizen = await Citizen.findOneAndUpdate(
      { zaloId: profile.id },
      { $set: { name: profile.name, avatar: profile.avatar, lastLoginAt: new Date() } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean()

    res.json({
      accessToken,
      profile: { id: profile.id, name: profile.name, avatar: profile.avatar },
      consent: consentInfo(citizen, profile),
    })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// POST /api/public/phone-consent — người dân bấm "Đồng ý" cho phép sử dụng SĐT.
// Lưu SĐT + thời điểm đồng ý vào DB → các lần sau không hỏi lại, form tự điền.
// Gọi lại endpoint này để đổi sang SĐT khác.
router.post('/phone-consent', publicConsent, async (req, res) => {
  try {
    const accessToken = getZaloAccessToken(req)
    if (!accessToken) return res.status(401).json({ error: 'Thiếu thông tin đăng nhập Zalo' })
    const phone = normalizePhone(req.body?.phone)
    if (!isPhone(phone)) {
      return res.status(400).json({ error: 'Số điện thoại không hợp lệ (VD: 0912345678)' })
    }
    const profile = await fetchZaloProfile(accessToken)

    const citizen = await Citizen.findOneAndUpdate(
      { zaloId: profile.id },
      {
        $set: {
          name: profile.name,
          avatar: profile.avatar,
          phone,
          phoneConsent: true,
          phoneConsentAt: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean()

    res.json({ ok: true, consent: consentInfo(citizen, profile) })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

// DELETE /api/public/phone-consent — người dân thu hồi quyền sử dụng SĐT (xoá SĐT đã lưu).
// Lần gửi phản ánh sau sẽ được hỏi lại.
router.delete('/phone-consent', publicConsent, async (req, res) => {
  try {
    const accessToken = getZaloAccessToken(req)
    if (!accessToken) return res.status(401).json({ error: 'Thiếu thông tin đăng nhập Zalo' })
    const profile = await fetchZaloProfile(accessToken)
    await Citizen.updateOne(
      { zaloId: profile.id },
      { $set: { phone: '', phoneConsent: false, phoneConsentAt: null } }
    )
    res.json({ ok: true, consent: { granted: false, phone: '', suggestedPhone: '' } })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

// POST /api/public/feedbacks — tạo phản ánh từ ReportApp (multipart, tối đa 5 ảnh).
// Ảnh lưu trên ổ đĩa VPS (src/utils/mediaStorage.js). Đẩy 1022 ĐỒNG BỘ trong request này —
// xem createFeedbackEntry() trong feedbackService.js.
function receiveImages(req, res, next) {
  upload.array('images', MAX_IMAGES)(req, res, (err) => {
    if (!err) return next()
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Mỗi ảnh tối đa 5MB'
      : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? `Tối đa ${MAX_IMAGES} ảnh`
      : err.message
    res.status(400).json({ error: msg })
  })
}

router.post('/feedbacks', publicWrite, receiveImages, async (req, res) => {
  try {
    const { categoryId, title, content, address, lat, lng, source } = req.body
    const accessToken = getZaloAccessToken(req)
    if (!accessToken) return res.status(401).json({ error: 'Thiếu thông tin đăng nhập Zalo' })

    if (!title || title.trim().length < 5) {
      return res.status(400).json({ error: 'Tiêu đề quá ngắn (tối thiểu 5 ký tự)' })
    }
    if (!content || content.trim().length < 5) {
      return res.status(400).json({ error: 'Nội dung phản ánh quá ngắn (tối thiểu 5 ký tự)' })
    }

    const profile = await fetchZaloProfile(accessToken)

    // SĐT chỉ lấy từ bản ghi người dân ĐÃ đồng ý cho phép sử dụng — không nhận SĐT tuỳ ý từ form
    const citizen = await Citizen.findOne({ zaloId: profile.id }).lean()
    if (!citizen?.phoneConsent || !citizen.phone) {
      return res.status(403).json({
        error: 'Bạn cần cho phép sử dụng số điện thoại trước khi gửi phản ánh',
        code: 'PHONE_CONSENT_REQUIRED',
      })
    }

    let category = null
    if (categoryId && /^[a-f\d]{24}$/i.test(categoryId)) category = await Category.findById(categoryId).lean()

    // Lưu ảnh lên VPS — kiểm tra hết trước, ảnh lỗi thì báo lại cho dân thay vì bỏ qua âm thầm
    const files = req.files || []
    let imageUrls
    try {
      imageUrls = files.map((file) => saveImage(file.buffer, 'feedback'))
    } catch (e) {
      return res.status(400).json({ error: e.message })
    }

    const latNum = parseFloat(lat)
    const lngNum = parseFloat(lng)
    const location = {
      address: typeof address === 'string' ? address.trim().slice(0, 500) : '',
      lat: Number.isFinite(latNum) ? latNum : null,
      lng: Number.isFinite(lngNum) ? lngNum : null,
      source: source === 'gps' || source === 'manual' ? source : '',
    }

    const { createFeedbackEntry } = require('../../src/services/feedbackService')
    const { sync } = await createFeedbackEntry({
      userId: profile.id,
      displayName: profile.name,
      contact: citizen.phone,
      title: title.trim().slice(0, 200),
      content: content.trim().slice(0, 5000),
      categoryId: category?._id || null,
      categoryName: category?.name || '',
      categoryGroupId: category?.zaloGroupId || null,
      imageUrls,
      location,
    })

    res.status(201).json({
      ok: true,
      code: sync.ok ? sync.gopyId : null,
      pending: !sync.ok,
      contact: citizen.phone,
    })
  } catch (err) {
    console.error('[ReportApp] Lỗi tạo phản ánh:', err.message)
    res.status(err.status || 500).json({ error: err.message })
  }
})

// GET /api/public/my-feedbacks — ReportApp: danh sách phản ánh của người dùng đang đăng nhập.
// Dùng đúng ID OAuth (profile.id) — cùng ID đã ghi lúc tạo phản ánh qua ReportApp.
// Trả cả phản ánh chưa có mã 1022 (đang đồng bộ) để dân thấy phản ánh vừa gửi.
router.get('/my-feedbacks', publicRead, async (req, res) => {
  try {
    const accessToken = getZaloAccessToken(req)
    if (!accessToken) return res.status(401).json({ error: 'Thiếu thông tin đăng nhập Zalo' })
    const profile = await fetchZaloProfile(accessToken)

    const items = await Feedback.find({ userId: profile.id })
      .sort({ createdAt: -1 })
      .limit(30)
      .select('title content createdAt status cgy1022.gopyId cgy1022.resultStatus')
      .lean()

    res.json({
      items: items.map((fb) => ({
        gopyId: fb.cgy1022?.gopyId || '',
        title: fb.title || fb.content.slice(0, 60),
        createdAt: fb.createdAt,
        resolved: fb.status === 'resolved' || fb.status === 'done',
      })),
    })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

// GET /api/public/my-feedbacks/:gopyId — trạng thái LIVE trực tiếp từ Cổng góp ý 1022 cho
// 1 phản ánh của CHÍNH người đang đăng nhập. 1022 lỗi thì trả trạng thái nội bộ thay thế.
router.get('/my-feedbacks/:gopyId', publicRead, async (req, res) => {
  try {
    const accessToken = getZaloAccessToken(req)
    if (!accessToken) return res.status(401).json({ error: 'Thiếu thông tin đăng nhập Zalo' })
    const profile = await fetchZaloProfile(accessToken)

    // Chỉ tìm trong CHÍNH phản ánh của user này — không cho xem mã của người khác dù đoán đúng số.
    const gopyId = String(req.params.gopyId)
    const fb = await Feedback.findOne({ userId: profile.id, 'cgy1022.gopyId': gopyId }).lean()
    if (!fb) return res.status(404).json({ error: 'Không tìm thấy phản ánh' })

    const cgy1022 = require('../../src/services/cgy1022Service')
    const { isResolvedOnCgy, extractResultContent } = require('../../src/services/cgy1022StatusService')

    let statusLabel
    let resolved
    let resultContent = ''
    try {
      const detail = await cgy1022.getFeedbackDetail(gopyId)
      resolved = isResolvedOnCgy(detail)
      statusLabel = detail?.tinhTrangXuLy || (resolved ? 'Đã xử lý' : 'Đang xử lý')
      resultContent = resolved ? extractResultContent(detail) : ''
    } catch (e) {
      console.warn(`[ReportApp] Tra 1022 gopyId=${gopyId} lỗi, dùng trạng thái nội bộ:`, e.message)
      resolved = fb.status === 'resolved' || fb.status === 'done'
      statusLabel = resolved ? 'Đã xử lý' : 'Đang xử lý'
      resultContent = resolved ? fb.finalResponse || '' : ''
    }

    res.json({
      gopyId,
      title: fb.title,
      content: fb.content,
      address: fb.location?.address || '',
      createdAt: fb.createdAt,
      statusLabel,
      resolved,
      resultContent,
    })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

// GET /api/public/map-markers — không cần auth, dùng cho bản đồ trang đăng nhập admin.
// Đây là dữ liệu AI CŨNG XEM ĐƯỢC nên chỉ để lại mức tổng quan: danh mục, trạng thái, thời gian,
// toạ độ làm tròn ~110m. KHÔNG trả nội dung phản ánh và địa chỉ chi tiết của công dân.
const MAP_MARKER_LIMIT = 300
const MAP_MARKER_DAYS = 180

router.get('/map-markers', publicRead, async (req, res) => {
  try {
    const since = new Date(Date.now() - MAP_MARKER_DAYS * 24 * 60 * 60 * 1000)
    const feedbacks = await Feedback.find({
      status: { $nin: ['resolved', 'done'] },
      createdAt: { $gte: since },
      'location.lat': { $ne: null },
      'location.lng': { $ne: null },
    })
      .select('location.lat location.lng categoryId createdAt status')
      .populate('categoryId', 'name icon')
      .sort({ createdAt: -1 })
      .limit(MAP_MARKER_LIMIT)
      .lean()

    const round = (v) => Math.round(v * 1000) / 1000 // 3 chữ số thập phân ≈ 110m

    const { displayCategoryName } = require('../../src/services/cgy1022Service')
    const markers = feedbacks.map((fb) => ({
      id: fb._id.toString().slice(-5).toUpperCase(),
      lat: round(fb.location.lat),
      lng: round(fb.location.lng),
      category: fb.categoryId?.name ? displayCategoryName(fb.categoryId.name) : 'Chưa phân loại',
      icon: fb.categoryId?.icon || '📋',
      createdAt: fb.createdAt,
      status: fb.status,
    }))

    res.json(markers)
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

module.exports = router
