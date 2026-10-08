# Virtual Web Session Backend

Dockerized Node.js backend for a contained browser-session prototype.

## Important scope

This service is a starter for authorized browser automation and remote rendering. It does **not** download or include any third-party Chrome extension. If you have the right to use an unpacked extension, place its files in `extension/` and set `EXTENSION_PATH`; otherwise leave extension loading disabled.

The service:

- exposes `GET /health` for Render;
- exposes `POST /session` to create a short-lived session token;
- accepts WebSocket connections at `/ws?token=...`;
- opens a Playwright Chromium context at the fixed target origin;
- streams periodic JPEG screenshots as base64 JSON messages;
- accepts controlled click, scroll, keyboard, back, forward, and refresh events;
- blocks top-level navigation away from the configured target origin;
- does not expose a URL-entry feature.

This is a prototype. Before public use, add authentication, rate limiting, per-user quotas, audit logging, CSRF/origin validation, stronger token storage, and a production-grade frame transport.

## Local setup

```bash
cp .env.example .env
npm install
npm run dev
```

In another terminal:

```bash
curl http://localhost:10000/health
```

Expected response:

```json
{"ok":true,"service":"virtual-web-session-backend"}
```

## Docker setup

```bash
docker build -t virtual-web-session-backend .
docker run --rm -p 10000:10000 --env-file .env virtual-web-session-backend
```

## Render setup

Create a **Web Service** from this GitHub repository, choose **Docker**, and set the health-check path to `/health`.

Environment variables:

```env
NODE_ENV=production
PORT=10000
FRONTEND_ORIGIN=https://websession-capkpwps.manus.space
TARGET_ORIGIN=https://rolexcoderz.in
SESSION_SECRET=generate-a-long-random-value
EXTENSION_PATH=
```

Render Free is suitable only for a small demo. Chromium can exceed its memory limit. Start with one concurrent session and upgrade the service if the browser crashes.

## WebSocket protocol

Client to server examples:

```json
{"type":"click","x":420,"y":280}
{"type":"scroll","deltaY":600}
{"type":"key","key":"Enter"}
{"type":"back"}
{"type":"forward"}
{"type":"refresh"}
```

Server to client frame message:

```json
{"type":"frame","mime":"image/jpeg","width":1280,"height":720,"data":"<base64>"}
```

The frame loop is intentionally simple. For production, replace repeated base64 screenshots with a more efficient streaming protocol and implement client-side coordinate scaling carefully.

## Extension handling

Do not scrape, download, or redistribute an extension from an unverified source. If you are authorized to use an unpacked extension, copy its extracted files into this repository or mount them into the container, then set:

```env
EXTENSION_PATH=/app/extension
```

The service only loads the extension when the directory exists and contains a manifest. It will otherwise run without one.

## If the frontend returns to the landing page

This means the WebSocket closed during session startup. Check Render logs for the browser launch error. The Dockerfile uses the Playwright image and the backend includes `--no-sandbox` and `--disable-setuid-sandbox`, which are required when Chromium runs as the container user. Also make sure `FRONTEND_ORIGIN` exactly matches the Vercel URL, with no trailing slash.
