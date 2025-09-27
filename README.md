# QR Ordering API (Standalone)

This repository is the **API** for your QR ordering project (multi-repo version).
It serves mock endpoints and provides **QR generation**.

## Endpoints
- `GET /health`
- `GET /menu`
- `POST /orders`  → mock creates a ticket immediately
- `GET /tables`
- `GET /summary`
- `POST /print`
- `POST /confirm`
- `GET /qr/:table.png`
- `GET /qr-sheet.pdf?count=24` or `?tables=T1,T2,T3`

## Environment
Create a `.env` (see `.env.example`):
```
CLIENT_URL=https://pwa-client.vercel.app
API_PUBLIC_URL=https://your-api.onrender.com
# HMAC_SECRET=change-me
```

## Run locally
```
npm install
npm start
# http://localhost:4000/health
```

## Docker
```
docker build -t qr-api .
docker run -it -p 4000:4000 --env-file=.env qr-api
```

## Deploy on Render
- New → Web Service → **Environment: Docker**
- Root directory = repository root
- Add env: `CLIENT_URL`, `API_PUBLIC_URL` (and optional `HMAC_SECRET`)
- Deploy

_Generated 2025-09-27_
