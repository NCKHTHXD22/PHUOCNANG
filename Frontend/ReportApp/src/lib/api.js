import axios from 'axios'

export const api = axios.create({
  baseURL: (import.meta.env.VITE_API_URL || '') + '/api/public',
})

// Gửi access token Zalo qua header Authorization, không đặt trên URL: URL bị ghi vào log máy chủ
// và gửi kèm khi chuyển trang, nên token dễ bị lộ.
export function authHeader(accessToken) {
  return { headers: { Authorization: `Bearer ${accessToken}` } }
}

export const ZALO_APP_ID = import.meta.env.VITE_ZALO_APP_ID || ''
export const ORG_NAME = import.meta.env.VITE_ORG_NAME || 'UBND xã Phước Năng'

const STATE_KEY = 'pn_oauth_state'

export function buildZaloLoginUrl() {
  const redirectUri = window.location.origin + window.location.pathname
  // state chống CSRF: lưu lại để đối chiếu khi Zalo redirect về
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36)
  try { sessionStorage.setItem(STATE_KEY, state) } catch { /* trình duyệt chặn storage */ }
  const params = new URLSearchParams({
    app_id: ZALO_APP_ID,
    redirect_uri: redirectUri,
    state,
    scope: 'phone',
  })
  return `https://oauth.zaloapp.com/v4/permission?${params.toString()}`
}

// true nếu state Zalo trả về khớp state đã lưu (hoặc trình duyệt không cho dùng storage)
export function checkOAuthState(state) {
  try {
    const saved = sessionStorage.getItem(STATE_KEY)
    sessionStorage.removeItem(STATE_KEY)
    return !saved || saved === state
  } catch {
    return true
  }
}

// Lưu phiên đăng nhập trong tab hiện tại để tải lại trang không phải đăng nhập Zalo lại.
// sessionStorage — tự xoá khi đóng tab.
const AUTH_KEY = 'pn_auth'

export function loadAuth() {
  try {
    const raw = sessionStorage.getItem(AUTH_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function saveAuth(auth) {
  try {
    if (auth) sessionStorage.setItem(AUTH_KEY, JSON.stringify(auth))
    else sessionStorage.removeItem(AUTH_KEY)
  } catch { /* bỏ qua */ }
}
