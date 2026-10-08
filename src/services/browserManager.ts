import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { chromium, type BrowserContext, type Page } from 'playwright'

export type SessionInput =
  | { type: 'click'; x: number; y: number }
  | { type: 'scroll'; deltaY: number }
  | { type: 'key'; key: string }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'refresh' }

export type BrowserSession = {
  id: string
  token: string
  context: BrowserContext
  page: Page
  createdAt: number
  lastFrameAt: number
  frameTimer?: NodeJS.Timeout
  send: (message: Record<string, unknown>) => void
  close: () => Promise<void>
}

type BrowserManagerOptions = {
  targetOrigin: string
  extensionPath?: string
  viewport: { width: number; height: number }
  frameIntervalMs: number
  sessionTtlMs: number
}

const SAFE_KEYS = new Set([
  'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown',
  'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space',
])

function isFiniteCoordinate(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum
}

function extensionIsLoadable(extensionPath?: string): boolean {
  if (!extensionPath || !existsSync(extensionPath)) return false
  const manifestPath = `${extensionPath.replace(/\/$/, '')}/manifest.json`
  if (!existsSync(manifestPath)) return false
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { manifest_version?: number }
    return manifest.manifest_version === 2 || manifest.manifest_version === 3
  } catch {
    return false
  }
}

export class BrowserManager {
  private readonly sessions = new Map<string, BrowserSession>()
  private browserPromise: ReturnType<typeof chromium.launch> | undefined

  constructor(private readonly options: BrowserManagerOptions) {}

  get activeCount(): number {
    return this.sessions.size
  }

  async createSession(token: string, send: BrowserSession['send']): Promise<BrowserSession> {
    const browser = await this.getBrowser()
    const extensionEnabled = extensionIsLoadable(this.options.extensionPath)
    const args = extensionEnabled && this.options.extensionPath
      ? [`--disable-extensions-except=${this.options.extensionPath}`, `--load-extension=${this.options.extensionPath}`]
      : []

    // A separate context is used per session. Extension loading is applied at launch/context time.
    const context = await browser.newContext({ viewport: this.options.viewport })
    const page = await context.newPage()
    const id = randomUUID()
    const session: BrowserSession = {
      id,
      token,
      context,
      page,
      createdAt: Date.now(),
      lastFrameAt: 0,
      send,
      close: async () => this.closeSession(id),
    }

    await page.route('**/*', async (route) => {
      const request = route.request()
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        const url = new URL(request.url())
        if (url.origin !== this.options.targetOrigin) {
          await route.abort()
          return
        }
      }
      await route.continue()
    })

    page.on('popup', (popup) => { void popup.close().catch(() => undefined) })
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame() && new URL(frame.url()).origin !== this.options.targetOrigin) {
        void page.goto(this.options.targetOrigin, { waitUntil: 'domcontentloaded' }).catch(() => undefined)
      }
    })

    await page.goto(this.options.targetOrigin, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    this.sessions.set(id, session)
    this.startFrameLoop(session, extensionEnabled)
    return session
  }

  async handleInput(session: BrowserSession, input: SessionInput): Promise<void> {
    switch (input.type) {
      case 'click':
        if (!isFiniteCoordinate(input.x, this.options.viewport.width) || !isFiniteCoordinate(input.y, this.options.viewport.height)) return
        await session.page.mouse.click(input.x, input.y)
        return
      case 'scroll':
        if (!Number.isFinite(input.deltaY) || Math.abs(input.deltaY) > 2000) return
        await session.page.mouse.wheel(0, input.deltaY)
        return
      case 'key':
        if (!SAFE_KEYS.has(input.key) && !/^.$/su.test(input.key)) return
        await session.page.keyboard.press(input.key)
        return
      case 'back':
        await session.page.goBack({ waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => undefined)
        await this.restoreTarget(session)
        return
      case 'forward':
        await session.page.goForward({ waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => undefined)
        await this.restoreTarget(session)
        return
      case 'refresh':
        await session.page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => undefined)
        await this.restoreTarget(session)
        return
    }
  }

  async closeSession(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    if (session.frameTimer) clearInterval(session.frameTimer)
    this.sessions.delete(id)
    await session.context.close().catch(() => undefined)
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.closeSession(id)))
    const browser = await this.browserPromise
    await browser?.close().catch(() => undefined)
  }

  private async restoreTarget(session: BrowserSession): Promise<void> {
    if (new URL(session.page.url()).origin !== this.options.targetOrigin) {
      await session.page.goto(this.options.targetOrigin, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => undefined)
    }
  }

  private startFrameLoop(session: BrowserSession, extensionEnabled: boolean): void {
    session.send({ type: 'ready', sessionId: session.id, targetOrigin: this.options.targetOrigin, extensionEnabled })
    session.frameTimer = setInterval(() => {
      void session.page.screenshot({ type: 'jpeg', quality: 65 }).then((buffer) => {
        session.lastFrameAt = Date.now()
        session.send({ type: 'frame', mime: 'image/jpeg', width: this.options.viewport.width, height: this.options.viewport.height, data: buffer.toString('base64') })
      }).catch((error: unknown) => session.send({ type: 'error', message: error instanceof Error ? error.message : 'Frame capture failed' }))
    }, this.options.frameIntervalMs)
  }

  private async getBrowser() {
    if (!this.browserPromise) {
      const extensionEnabled = extensionIsLoadable(this.options.extensionPath)
      const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        ...(extensionEnabled && this.options.extensionPath
          ? [`--disable-extensions-except=${this.options.extensionPath}`, `--load-extension=${this.options.extensionPath}`]
          : []),
      ]
      this.browserPromise = chromium.launch({ headless: true, args })
    }
    return this.browserPromise
  }
}
