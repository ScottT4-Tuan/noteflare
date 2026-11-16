import { Hono, type Context } from 'hono'
import { d1Settings, type SettingsStore } from './setup'

/**
 * Google Calendar and Google Tasks, through this Worker.
 *
 * The owner connects a Google account once (OAuth 2.0 authorization code flow with PKCE).
 * The refresh token is encrypted with a key derived from GOOGLE_CLIENT_SECRET and kept in
 * the `settings` table; access tokens live only in memory. The app then calls
 * /api/google/calendar/* and /api/google/tasks/*, which this Worker forwards to Google with
 * the owner's access token. Unlike notes, this data is NOT end-to-end encrypted: it comes
 * from Google in plain form and passes through the Worker on its way to the browser.
 *
 * Setup: create an OAuth client (Web application) in Google Cloud with the redirect URI
 * https://<your host>/api/google/callback, then add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
 * as Worker secrets. Without both, the feature stays off.
 */

export interface GoogleEnv {
  DB: D1Database
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
}

type Vars = { user: string; via: 'session' | 'token' }
type GCtx = Context<{ Bindings: GoogleEnv; Variables: Vars }>

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/tasks',
]

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
export const UPSTREAM = {
  calendar: 'https://www.googleapis.com/calendar/v3/',
  tasks: 'https://tasks.googleapis.com/tasks/v1/',
} as const

const COOKIE = 'nf_google_oauth'
const COOKIE_PATH = '/api/google'
const MAX_BODY = 256 * 1024
const PROXY_METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE'])

export const isConfigured = (env: Pick<GoogleEnv, 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET'>) =>
  !!env.GOOGLE_CLIENT_ID?.trim() && !!env.GOOGLE_CLIENT_SECRET?.trim()

const settingsKey = (user: string) => `google:${user.toLowerCase()}`
export const redirectUri = (url: string) => `${new URL(url).origin}/api/google/callback`

// ---------- stored account (encrypted refresh token) ----------

interface StoredAccount {
  v: 1
  iv: string
  ct: string
  email: string | null
  scope: string
  at: number
}

const enc = new TextEncoder()
const dec = new TextDecoder()

function b64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}
function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
const b64url = (bytes: Uint8Array) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

async function tokenKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('noteflare'), info: enc.encode('google-refresh-token/v1') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** Encrypt a refresh token for one user (the email is bound in as associated data). */
export async function sealToken(secret: string, user: string, token: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(user.toLowerCase()) },
    await tokenKey(secret),
    enc.encode(token),
  )
  return { iv: b64(iv), ct: b64(new Uint8Array(ct)) }
}

export async function openToken(secret: string, user: string, sealed: { iv: string; ct: string }) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(sealed.iv), additionalData: enc.encode(user.toLowerCase()) },
    await tokenKey(secret),
    unb64(sealed.ct),
  )
  return dec.decode(pt)
}

async function loadAccount(store: SettingsStore, user: string): Promise<StoredAccount | null> {
  const raw = (await store.get([settingsKey(user)]))[settingsKey(user)]
  if (!raw) return null
  try {
    const a = JSON.parse(raw) as StoredAccount
    return a?.v === 1 && a.iv && a.ct ? a : null
  } catch {
    return null
  }
}

// ---------- access tokens ----------

/** Access tokens per user, for as long as this isolate lives. */
const accessCache = new Map<string, { token: string; exp: number }>()
export const clearGoogleCache = () => accessCache.clear()

class ReauthError extends Error {}

async function refreshAccess(env: GoogleEnv, user: string): Promise<string> {
  const store = d1Settings(env.DB)
  const account = await loadAccount(store, user)
  if (!account) throw new ReauthError('not_connected')
  let refresh: string
  try {
    refresh = await openToken(env.GOOGLE_CLIENT_SECRET!, user, account)
  } catch {
    // The client secret changed: the stored token can't be read any more.
    await store.delete(settingsKey(user))
    throw new ReauthError('undecryptable')
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      refresh_token: refresh,
      grant_type: 'refresh_token',
    }),
  })
  const body = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number; error?: string } | null
  if (!res.ok || !body?.access_token) {
    // invalid_grant: revoked, expired (7 days for apps in "Testing"), or the password changed.
    if (body?.error === 'invalid_grant') {
      await store.delete(settingsKey(user))
      throw new ReauthError('invalid_grant')
    }
    throw new Error(`Google token refresh failed: ${res.status} ${body?.error ?? ''}`)
  }
  accessCache.set(user, { token: body.access_token, exp: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000 })
  return body.access_token
}

async function accessToken(env: GoogleEnv, user: string, force = false) {
  const hit = accessCache.get(user)
  if (!force && hit && hit.exp > Date.now()) return hit.token
  return refreshAccess(env, user)
}

// ---------- helpers ----------

function getCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return v.join('=')
  }
  return null
}

/** Email from Google's id_token. It comes straight from Google's token endpoint over TLS. */
function idTokenEmail(idToken?: string): string | null {
  try {
    const part = idToken?.split('.')[1]
    if (!part) return null
    const json = JSON.parse(dec.decode(unb64(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='))))
    return typeof json.email === 'string' ? json.email : null
  } catch {
    return null
  }
}

/**
 * The part of a proxied path after /calendar/ or /tasks/, if it is safe to forward:
 * URL-path characters only (ids arrive percent-encoded) and no dot segments.
 */
export function upstreamPath(pathname: string): { service: keyof typeof UPSTREAM; rest: string } | null {
  const m = /\/google\/(calendar|tasks)\/(.+)$/.exec(pathname)
  if (!m) return null
  const rest = m[2]
  if (!/^[A-Za-z0-9@._~%+=\-/]+$/.test(rest)) return null
  for (const segment of rest.split('/')) {
    let s: string
    try {
      s = decodeURIComponent(segment)
    } catch {
      return null
    }
    // The URL parser treats %2e%2e like "..", so look at the decoded segment.
    if (!s || s === '.' || s === '..' || s.includes('\\')) return null
  }
  return { service: m[1] as keyof typeof UPSTREAM, rest }
}

/** A tiny page that tells the app the result and closes the popup (or goes home). */
function resultPage(ok: boolean, message: string) {
  const payload = JSON.stringify({ type: 'google', ok, message }).replace(/</g, '\\u003c')
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>NoteFlare</title>
<body style="font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;color:#555">
<p>${ok ? 'Google connected. You can close this window.' : 'Google was not connected: ' + message.replace(/[<>&"]/g, '')}</p>
<script>try{new BroadcastChannel('noteflare-google').postMessage(${payload})}catch(e){}
try{localStorage.setItem('noteflare:google-result',JSON.stringify(Object.assign(${payload},{at:Date.now()})))}catch(e){}
setTimeout(function(){window.close();setTimeout(function(){location.replace('/')},400)},${ok ? 300 : 2500})</script></body>`
  return new Response(html, {
    status: ok ? 200 : 400,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
      'Set-Cookie': `${COOKIE}=; Path=${COOKIE_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    },
  })
}

const notConfigured = (c: GCtx) =>
  c.json({ error: 'google_not_configured', message: 'Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET as Worker secrets.' }, 501)

// ---------- routes (mounted at /api/google, web app sessions only) ----------

export const google = new Hono<{ Bindings: GoogleEnv; Variables: Vars }>()

google.use('*', async (c, next) => {
  if (c.get('via') !== 'session') return c.json({ error: 'forbidden', message: 'Only available from the NoteFlare web app.' }, 403)
  await next()
})

google.get('/status', async (c) => {
  if (!isConfigured(c.env)) return c.json({ configured: false, connected: false, redirectUri: redirectUri(c.req.url) })
  const account = await loadAccount(d1Settings(c.env.DB), c.get('user'))
  return c.json({ configured: true, connected: !!account, email: account?.email ?? null, redirectUri: redirectUri(c.req.url) })
})

google.get('/connect', async (c) => {
  if (!isConfigured(c.env)) return notConfigured(c)
  const state = b64url(crypto.getRandomValues(new Uint8Array(24)))
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(verifier))))
  const url = new URL(AUTH_URL)
  url.search = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(c.req.url),
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    // Always ask, so Google returns a refresh token even when the account was connected before.
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    login_hint: c.get('user'),
  }).toString()
  return new Response(null, {
    status: 302,
    headers: {
      Location: url.toString(),
      'Cache-Control': 'no-store',
      'Set-Cookie': `${COOKIE}=${state}.${verifier}; Path=${COOKIE_PATH}; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
    },
  })
})

google.get('/callback', async (c) => {
  if (!isConfigured(c.env)) return notConfigured(c)
  const err = c.req.query('error')
  if (err) return resultPage(false, err === 'access_denied' ? 'access denied' : err)
  const [state, verifier] = (getCookie(c.req.header('Cookie'), COOKIE) ?? '').split('.')
  const code = c.req.query('code')
  if (!state || !verifier || !code || c.req.query('state') !== state) return resultPage(false, 'the sign-in expired, try again')

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: c.env.GOOGLE_CLIENT_ID!,
      client_secret: c.env.GOOGLE_CLIENT_SECRET!,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri(c.req.url),
    }),
  })
  const body = (await res.json().catch(() => null)) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    scope?: string
    id_token?: string
    error?: string
  } | null
  if (!res.ok || !body?.access_token) return resultPage(false, body?.error ?? `token exchange failed (${res.status})`)
  if (!body.refresh_token) return resultPage(false, 'Google did not return a refresh token, try again')

  const missing = GOOGLE_SCOPES.filter((s) => s.startsWith('https://') && !(body.scope ?? '').split(' ').includes(s))
  if (missing.length) return resultPage(false, 'tick every permission on the Google consent screen')

  const user = c.get('user')
  const sealed = await sealToken(c.env.GOOGLE_CLIENT_SECRET!, user, body.refresh_token)
  const account: StoredAccount = { v: 1, ...sealed, email: idTokenEmail(body.id_token), scope: body.scope ?? '', at: Date.now() }
  await d1Settings(c.env.DB).set({ [settingsKey(user)]: JSON.stringify(account) })
  accessCache.set(user, { token: body.access_token, exp: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000 })
  return resultPage(true, account.email ?? '')
})

google.post('/disconnect', async (c) => {
  const user = c.get('user')
  const store = d1Settings(c.env.DB)
  const account = await loadAccount(store, user)
  if (account && isConfigured(c.env)) {
    try {
      const token = await openToken(c.env.GOOGLE_CLIENT_SECRET!, user, account)
      await fetch(REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }),
      })
    } catch {
      /* forget it locally anyway */
    }
  }
  await store.delete(settingsKey(user))
  accessCache.delete(user)
  return c.json({ ok: true })
})

/** Forward /api/google/{calendar,tasks}/<path> to the Google API with the owner's token. */
const proxy = async (c: GCtx) => {
  if (!isConfigured(c.env)) return notConfigured(c)
  const method = c.req.method
  if (!PROXY_METHODS.has(method)) return c.json({ error: 'method_not_allowed' }, 405)
  const url = new URL(c.req.url)
  const target = upstreamPath(url.pathname)
  if (!target) return c.json({ error: 'bad_request' }, 400)

  let body: string | undefined
  if (method !== 'GET' && method !== 'DELETE') {
    if (Number(c.req.header('Content-Length') ?? 0) > MAX_BODY) return c.json({ error: 'too_large' }, 413)
    body = await c.req.text()
    if (body.length > MAX_BODY) return c.json({ error: 'too_large' }, 413)
  }

  const user = c.get('user')
  const send = (token: string) =>
    fetch(UPSTREAM[target.service] + target.rest + url.search, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body,
    })

  let res: Response
  try {
    res = await send(await accessToken(c.env, user))
    if (res.status === 401) res = await send(await accessToken(c.env, user, true))
  } catch (e) {
    if (e instanceof ReauthError) return c.json({ error: 'google_reauth', reason: e.message }, 401)
    throw e
  }
  if (res.status === 204) return c.body(null, 204)
  const text = await res.text()
  return new Response(text, { status: res.status, headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/json', 'Cache-Control': 'no-store' } })
}

google.all('/calendar/*', proxy)
google.all('/tasks/*', proxy)
