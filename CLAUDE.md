# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Zalo OA feedback system for UBND xã Phước Năng (Đà Nẵng). Citizens submit feedback through a web form (ReportApp) opened from the OA menu; it is synced to the city's Cổng góp ý 1022 and staff process it in a web admin. Cloned from TIENICHOAZALO_ANHAI and trimmed to feedback only (no news auto-posting, no broadcast messaging, no legacy EJS admin, no chatbot conversation flow).

## Commands

```bash
cd Backend && npm run dev                # nodemon server.js — port 3001
cd Backend && npm run probe:1022         # read-only check of 1022 credentials
cd Frontend/Web && npm run dev           # web admin, base /app/ — port 5173
cd Frontend/ReportApp && npm run dev     # citizen form, base /report/ — port 5174
npm run build                            # in each Frontend app → dist/ served by Express
```

## Architecture

```
Citizen → OA menu / #phananh → webhookHandler → feedbackService.promptReportApp (link button)
       → ReportApp (/report) → Zalo OAuth login → POST /api/public/zalo-login
            → Citizen model upsert; returns consent {granted, phone}
            → first time: PhoneConsentDialog → POST /api/public/phone-consent (saves phone)
       → POST /api/public/feedbacks (Bearer = citizen Zalo token)
            → images → src/utils/mediaStorage.js (disk, served at /uploads)
            → feedbackService.createFeedbackEntry → cgy1022RetryService.syncFeedbackById (1022)
            → Zalo text to citizen + group message to category's zaloGroupId
cgy1022StatusService (every 5 min) → 1022 "Đã xử lý" → notify citizen + group, status=resolved
Admin (/app, JWT) → /api/* → assign → draft → approve/reject → reply to citizen via OA
```

| Path | Purpose |
|------|---------|
| `Backend/src/config/index.js` | Single CONFIG object — all env vars (ORG_NAME, DATA_DIR, UPLOAD_DIR, JWT_SECRET, CGY1022_*) |
| `Backend/src/utils/localStore.js` | JSON-file key/value store in `DATA_DIR` (replaces Upstash Redis) |
| `Backend/src/utils/mediaStorage.js` | Saves uploads to `UPLOAD_DIR`, validates image magic bytes; `resolveLocalPath()` maps `/uploads` URLs back to disk |
| `Backend/src/utils/zaloToken.js` | OA token lifecycle; persisted in `DATA_DIR/zalo-token.json`; refreshes on boot and ~2h before expiry |
| `Backend/src/models/Citizen.js` | Citizen by Zalo OAuth id + phone consent |
| `Backend/api/routes/public.js` | ReportApp API (login, phone consent, create feedback, my-feedbacks, live 1022 status) |
| `Backend/api/routes/feedbacks.js` | Admin workflow (assign, draft, approve, reject, attachments) |
| `Backend/src/services/cgy1022*.js` | 1022 push, retry sweep, status poll |
| `Frontend/ReportApp/src/components/PhoneConsentDialog.jsx` | Phone-use permission prompt |

## Key rules

- **Phone consent**: `POST /api/public/feedbacks` takes the phone only from the `Citizen` record with `phoneConsent: true` — never from the request body. Without consent it returns 403 `PHONE_CONSENT_REQUIRED`.
- **Single process only**: Zalo refresh tokens are single-use; never run the backend in PM2 cluster mode or two servers against the same OA.
- **PUBLIC_URL is required in production**: image URLs sent to 1022 and Zalo groups must be absolute.
- **Two Zalo user-id namespaces**: ReportApp uses the OAuth (Social API) id; webhooks use the OA follower id. `Feedback.userId` from ReportApp is the OAuth id, so lookup happens in ReportApp, not in chat.
- `shouldShowPhone()`/`getLinhVucId()` must receive the raw category name; `displayCategoryName()` is display-only.
- Web admin is built with Vite `base: '/app/'` and `BrowserRouter basename` — use `import.meta.env.BASE_URL` for public assets and hard redirects.
- `/admin/set-tokens` is disabled unless `TOKEN_SETUP_KEY` is set.

## Feedback workflow

```
pending → [officer drafts] → draft → [leader approves] → resolved (sent to citizen)
                                   → [leader rejects]  → pending
1022 marks "Đã xử lý" → resolved automatically (cgy1022StatusService)
```

Roles: `superadmin` (all), `dept_leader` (own `categoryIds`, approve/reject), `officer`/`staff` (assigned only, draft).

## Deployment

VPS + PM2 (`phuocnang-backend`) + Nginx; Express serves `/app`, `/report`, `/uploads`. See `Document/DEPLOY.md`. `Backend/.env.example` documents every variable.
