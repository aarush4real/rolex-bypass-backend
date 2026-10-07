import 'dotenv/config'
import http from 'node:http'
import crypto from 'node:crypto'
import cors from 'cors'
import express from 'express'
import { WebSocketServer, type WebSocket } from 'ws'
import { BrowserManager, type BrowserSession, type SessionInput } from './services/browserManager.js'

const port = Number(process.env.PORT || 10000)
const frontendOrigin = process.env.FRONTEND_ORIGIN || 'http://localhost:5173'
const targetOrigin = new URL(process.env.TARGET_ORIGIN || 'https://rolexcoderz.in').origin
const sessionSecret = process.env.SESSION_SECRET || 'local-development-only-change-me'
const maxSessions = Math.max(1, Number(process.env.MAX_SESSIONS || 1))
const sessionTtlMs = Math.max(60_000, Number(process.env.SESSION_TTL_MS || 1_800_000))
const viewport = { width: Number(process.env.VIEWPORT_WIDTH || 1280), height: Number(process.env.VIEWPORT_HEIGHT || 720) }

const app = express()
app.disable('x-powered-by')
app.use(cors({ origin: frontendOrigin, methods: ['GET', 'POST'], credentials: false }))
app.use(express.json({ limit: '32kb' }))

const manager = new BrowserManager({
  targetOrigin,
  extensionPath: process.env.EXTENSION_PATH || undefined,
  viewport,
  frameIntervalMs: Math.max(250, Number(process.env.FRAME_INTERVAL_MS || 500)),
  sessionTtlMs,
})

const issued = new Map<string, { token: string; expiresAt: number }>()

function sign(value: string): string {
  return crypto.createHmac('sha256', sessionSecret).update(value).digest('hex')
}

function issueToken(): { token: string; expiresAt: number } {
  const nonce = crypto.randomBytes(24).toString('hex')
  const expiresAt = Date.now() + sessionTtlMs
  const token = `${nonce}.${expiresAt}.${sign(`${nonce}.${expiresAt}`)}`
  issued.set(token, { token, expiresAt })
  return { token, expiresAt }
}

function isValidToken(token: string | undefined): boolean {
  const record = token ? issued.get(token) : undefined
  return Boolean(record && record.expiresAt > Date.now())
}

function parseInput(raw: unknown): SessionInput | null {
  if (!raw || typeof raw !== 'object' || !('type' in raw)) return null
  const value = raw as Record<string, unknown>
  switch (value.type) {
    case 'click': return typeof value.x === 'number' && typeof value.y === 'number' ? { type: 'click', x: value.x, y: value.y } : null
    case 'scroll': return typeof value.deltaY === 'number' ? { type: 'scroll', deltaY: value.deltaY } : null
    case 'key': return typeof value.key === 'string' ? { type: 'key', key: value.key } : null
    case 'back': return { type: 'back' }
    case 'forward': return { type: 'forward' }
    case 'refresh': return { type: 'refresh' }
    default: return null
  }
}

app.get('/health', (_request, response) => {
  response.json({ ok: true, service: 'virtual-web-session-backend', activeSessions: manager.activeCount })
})

app.post('/session', (_request, response) => {
  if (manager.activeCount >= maxSessions) {
    response.status(429).json({ error: 'session_limit_reached' })
    return
  }
  const result = issueToken()
  response.status(201).json({ token: result.token, expiresAt: result.expiresAt, wsPath: '/ws' })
})

const server = http.createServer(app)
const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 })

server.on('upgrade', (request, socket, head) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
    const origin = request.headers.origin
    if (url.pathname !== '/ws' || !isValidToken(url.searchParams.get('token') || undefined) || (origin && origin !== frontendOrigin)) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request, url.searchParams.get('token')))
  } catch {
    socket.destroy()
  }
})

wss.on('connection', async (ws: WebSocket, _request: http.IncomingMessage, token: string) => {
  let session: BrowserSession | undefined
  const send = (message: Record<string, unknown>) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message)) }
  try {
    session = await manager.createSession(token, send)
    const ttlTimer = setTimeout(() => { send({ type: 'closed', reason: 'session_ttl_expired' }); void ws.close() }, sessionTtlMs)
    ws.on('message', (payload) => {
      try {
        const input = parseInput(JSON.parse(payload.toString()))
        if (input && session) void manager.handleInput(session, input)
      } catch { send({ type: 'error', message: 'Invalid event payload' }) }
    })
    ws.on('close', () => { clearTimeout(ttlTimer); if (session) void manager.closeSession(session.id) })
    ws.on('error', () => { clearTimeout(ttlTimer); if (session) void manager.closeSession(session.id) })
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : 'Could not create browser session' })
    ws.close()
  }
})

server.listen(port, '0.0.0.0', () => {
  console.log(`Virtual Web Session backend listening on 0.0.0.0:${port}`)
  console.log(`Target origin locked to ${targetOrigin}`)
})

const shutdown = async () => { await manager.closeAll(); server.close(() => process.exit(0)) }
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
