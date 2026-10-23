import { useEffect, useState } from 'react'
import ZaloLoginGate from '@/pages/ZaloLoginGate'
import FeedbackForm from '@/pages/FeedbackForm'
import SuccessScreen from '@/pages/SuccessScreen'
import MyFeedbacksPage from '@/pages/MyFeedbacksPage'
import PhoneConsentDialog from '@/components/PhoneConsentDialog'
import { api, checkOAuthState, loadAuth, saveAuth } from '@/lib/api'

const VIEW_KEY = 'pn_view'

// Trang mở từ nút "Theo dõi phản ánh" của OA có ?view=history. Zalo OAuth redirect về
// không giữ query → lưu tạm vào sessionStorage để sau khi đăng nhập vẫn vào đúng trang.
function initialView() {
  const fromUrl = new URLSearchParams(window.location.search).get('view')
  try {
    if (fromUrl) sessionStorage.setItem(VIEW_KEY, fromUrl)
    const v = fromUrl || sessionStorage.getItem(VIEW_KEY)
    return v === 'history' ? 'history' : 'form'
  } catch {
    return fromUrl === 'history' ? 'history' : 'form'
  }
}

export default function App() {
  const [auth, setAuthState] = useState(loadAuth) // { accessToken, profile, consent }
  const [loadingLogin, setLoadingLogin] = useState(false)
  const [loginError, setLoginError] = useState('')
  const [submittedInfo, setSubmittedInfo] = useState(null)
  const [view, setView] = useState(initialView) // 'form' | 'history'
  const [showConsent, setShowConsent] = useState(false)

  function setAuth(next) {
    setAuthState(next)
    saveAuth(next)
  }

  // Đổi code OAuth Zalo lấy phiên đăng nhập
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    if (!code) return

    if (!checkOAuthState(params.get('state'))) {
      setLoginError('Phiên đăng nhập không hợp lệ, vui lòng thử lại')
      window.history.replaceState({}, '', window.location.pathname)
      return
    }

    setLoadingLogin(true)
    api.post('/zalo-login', { code })
      .then(res => {
        setAuth(res.data)
        // Lần đầu (chưa đồng ý) → hiện ngay thông báo xin phép sử dụng SĐT
        if (!res.data.consent?.granted) setShowConsent(true)
      })
      .catch(err => setLoginError(err.response?.data?.error || 'Đăng nhập Zalo thất bại, vui lòng thử lại'))
      .finally(() => {
        setLoadingLogin(false)
        window.history.replaceState({}, '', window.location.pathname)
      })
  }, [])

  // Token Zalo của người dân hết hạn (API trả 401) → về màn đăng nhập
  useEffect(() => {
    const id = api.interceptors.response.use(
      (r) => r,
      (error) => {
        if (error.response?.status === 401) {
          setAuth(null)
          setLoginError('Phiên đăng nhập Zalo đã hết hạn, vui lòng đăng nhập lại')
        }
        return Promise.reject(error)
      }
    )
    return () => api.interceptors.response.eject(id)
  }, [])

  function updateConsent(consent) {
    setAuth({ ...auth, consent })
    setShowConsent(false)
  }

  if (!auth) {
    return <ZaloLoginGate loading={loadingLogin} error={loginError} />
  }

  let page
  if (submittedInfo) {
    page = <SuccessScreen info={submittedInfo} onReset={() => setSubmittedInfo(null)} onShowHistory={() => { setSubmittedInfo(null); setView('history') }} />
  } else if (view === 'history') {
    page = <MyFeedbacksPage accessToken={auth.accessToken} onBack={() => { setView('form'); try { sessionStorage.removeItem(VIEW_KEY) } catch { /* bỏ qua */ } }} />
  } else {
    page = (
      <FeedbackForm
        profile={auth.profile}
        accessToken={auth.accessToken}
        consent={auth.consent}
        onRequestConsent={() => setShowConsent(true)}
        onConsentRequired={() => { updateConsent({ granted: false, phone: '', suggestedPhone: '' }); setShowConsent(true) }}
        onSuccess={setSubmittedInfo}
        onShowHistory={() => setView('history')}
      />
    )
  }

  return (
    <>
      {page}
      {showConsent && (
        <PhoneConsentDialog
          accessToken={auth.accessToken}
          consent={auth.consent}
          onGranted={updateConsent}
          onRevoked={updateConsent}
          onClose={() => setShowConsent(false)}
        />
      )}
    </>
  )
}
