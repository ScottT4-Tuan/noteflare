import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../worker/index'
import { clearGoogleCache, openToken, sealToken, upstreamPath } from '../worker/google'
import { eventDays, orderTasks, taskDueDate, toTaskDue, type GTask } from '../src/lib/google'

const SECRET = 'test-client-secret'
const ME = 'me@example.com'

/** Just enough D1 for the `settings` table. */
function fakeDB() {
  const rows = new Map<string, string>()
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    all: async () => ({
      results: sql.startsWith('SELECT key, value FROM settings')
        ? (args as string[]).filter((k) => rows.has(k)).map((k) => ({ key: k, value: rows.get(k)! }))
        : [],
    }),
    first: async () => null,
    run: async () => {
      if (sql.startsWith('DELETE FROM settings')) rows.delete(args[0] as string)
      return { meta: { changes: 1 } }
    },
    _apply: () => {
      if (sql.startsWith('INSERT INTO settings')) rows.set(args[0] as string, args[1] as string)
    },
  })
  return {
    rows,
    prepare: (sql: string) => stmt(sql),
    batch: async (list: { _apply: () => void }[]) => list.map((s) => (s._apply(), { meta: { changes: 1 } })),
  }
}

const env = (db: ReturnType<typeof fakeDB>, configured = true, user = ME) =>
  ({
    ACCESS_TEAM_DOMAIN: '',
    ACCESS_AUD: '',
    DEV_USER_EMAIL: user,
    DB: db,
    ...(configured ? { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: SECRET } : {}),
  }) as never

const call = (e: never, path: string, init?: RequestInit) =>
  worker.fetch(new Request(`http://localhost/api/google${path}`, init) as never, e, {} as never)

describe('refresh token sealing', () => {
  it('round-trips, and only for the same user and secret', async () => {
    const sealed = await sealToken(SECRET, ME, '1//refresh-token')
    expect(sealed.ct).not.toContain('refresh')
    expect(await openToken(SECRET, 'ME@example.com', sealed)).toBe('1//refresh-token')
    await expect(openToken(SECRET, 'other@example.com', sealed)).rejects.toThrow()
    await expect(openToken('another-secret', ME, sealed)).rejects.toThrow()
  })
})

describe('upstreamPath', () => {
  it('maps calendar and tasks paths', () => {
    expect(upstreamPath('/api/google/calendar/users/me/calendarList')).toEqual({ service: 'calendar', rest: 'users/me/calendarList' })
    expect(upstreamPath('/api/google/tasks/lists/abc%3D%3D/tasks')).toEqual({ service: 'tasks', rest: 'lists/abc%3D%3D/tasks' })
    expect(upstreamPath('/api/google/calendar/calendars/me%40example.com/events')?.rest).toBe('calendars/me%40example.com/events')
  })
  it('refuses dot segments, encoded ones included, and odd characters', () => {
    expect(upstreamPath('/api/google/calendar/../oauth2')).toBeNull()
    expect(upstreamPath('/api/google/calendar/a/%2e%2e/b')).toBeNull()
    expect(upstreamPath('/api/google/calendar/a//b')).toBeNull()
    expect(upstreamPath('/api/google/calendar/a%5cb')).toBeNull()
    expect(upstreamPath('/api/google/calendar/a%zz')).toBeNull()
    expect(upstreamPath('/api/google/drive/files')).toBeNull()
  })
})

describe('google routes', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    clearGoogleCache()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('reports not configured without the secrets', async () => {
    const res = await call(env(fakeDB(), false), '/status')
    expect(await res.json()).toEqual({ configured: false, connected: false, redirectUri: 'http://localhost/api/google/callback' })
    expect((await call(env(fakeDB(), false), '/calendar/users/me/calendarList')).status).toBe(501)
  })

  it('stays locked without a session, and is closed to API tokens', async () => {
    expect((await call(env(fakeDB(), true, ''), '/status')).status).toBe(401)
    const res = await worker.fetch(
      new Request('http://localhost/api/v1/google/status', { headers: { Authorization: 'Bearer nf_x' } }) as never,
      env(fakeDB()),
      {} as never,
    )
    expect(res.status).toBe(401)
  })

  it('runs the OAuth flow with PKCE and stores an encrypted refresh token', async () => {
    const db = fakeDB()
    const start = await call(env(db), '/connect')
    expect(start.status).toBe(302)
    const auth = new URL(start.headers.get('Location')!)
    expect(auth.origin + auth.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(auth.searchParams.get('redirect_uri')).toBe('http://localhost/api/google/callback')
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256')
    expect(auth.searchParams.get('access_type')).toBe('offline')
    const cookie = start.headers.get('Set-Cookie')!.split(';')[0]
    const state = auth.searchParams.get('state')!

    // A wrong state is refused before anything is sent to Google.
    const bad = await call(env(db), `/callback?code=abc&state=nope`, { headers: { Cookie: cookie } })
    expect(bad.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()

    const payload = btoa(JSON.stringify({ email: 'me@gmail.com' })).replace(/=+$/, '')
    fetchMock.mockResolvedValueOnce(
      Response.json({
        access_token: 'ya29.access',
        refresh_token: '1//refresh',
        expires_in: 3599,
        id_token: `h.${payload}.s`,
        scope: 'openid email https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/tasks',
      }),
    )
    const done = await call(env(db), `/callback?code=abc&state=${state}`, { headers: { Cookie: cookie } })
    expect(done.status).toBe(200)
    const sent = fetchMock.mock.calls[0]
    expect(sent[0]).toBe('https://oauth2.googleapis.com/token')
    const form = new URLSearchParams(String(sent[1].body))
    expect(form.get('code_verifier')).toBe(cookie.split('.').pop())
    expect(form.get('grant_type')).toBe('authorization_code')

    const stored = db.rows.get(`google:${ME}`)!
    expect(stored).toBeTruthy()
    expect(stored).not.toContain('1//refresh')
    expect(await (await call(env(db), '/status')).json()).toMatchObject({ configured: true, connected: true, email: 'me@gmail.com' })
  })

  it('refuses a consent without every permission', async () => {
    const db = fakeDB()
    const start = await call(env(db), '/connect')
    const cookie = start.headers.get('Set-Cookie')!.split(';')[0]
    const state = new URL(start.headers.get('Location')!).searchParams.get('state')
    fetchMock.mockResolvedValueOnce(Response.json({ access_token: 'a', refresh_token: 'r', scope: 'openid email https://www.googleapis.com/auth/tasks' }))
    expect((await call(env(db), `/callback?code=abc&state=${state}`, { headers: { Cookie: cookie } })).status).toBe(400)
    expect(db.rows.size).toBe(0)
  })

  async function connected() {
    const db = fakeDB()
    const sealed = await sealToken(SECRET, ME, '1//refresh')
    db.rows.set(`google:${ME}`, JSON.stringify({ v: 1, ...sealed, email: 'me@gmail.com', scope: '', at: 1 }))
    return db
  }

  it('forwards calls with a refreshed access token, and retries once on 401', async () => {
    const db = await connected()
    fetchMock
      .mockResolvedValueOnce(Response.json({ access_token: 'old', expires_in: 3600 }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(Response.json({ access_token: 'new', expires_in: 3600 }))
      .mockResolvedValueOnce(Response.json({ items: [{ id: 'primary' }] }))
    const res = await call(env(db), '/calendar/users/me/calendarList?maxResults=250')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ items: [{ id: 'primary' }] })
    const upstream = fetchMock.mock.calls[3]
    expect(upstream[0]).toBe('https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250')
    expect(upstream[1].headers.Authorization).toBe('Bearer new')
    expect(new URLSearchParams(String(fetchMock.mock.calls[0][1].body)).get('refresh_token')).toBe('1//refresh')

    // The access token is reused for the next call.
    fetchMock.mockResolvedValueOnce(Response.json({ id: 't1', title: 'Buy milk' }))
    const created = await call(env(db), '/tasks/lists/L1/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Buy milk' }),
    })
    expect(created.status).toBe(200)
    expect(fetchMock.mock.calls[4][0]).toBe('https://tasks.googleapis.com/tasks/v1/lists/L1/tasks')
    expect(fetchMock.mock.calls[4][1]).toMatchObject({ method: 'POST', body: '{"title":"Buy milk"}' })
  })

  it('asks to reconnect when Google revoked the refresh token, and forgets it', async () => {
    const db = await connected()
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'invalid_grant' }, { status: 400 }))
    const res = await call(env(db), '/tasks/users/@me/lists')
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'google_reauth' })
    expect(db.rows.size).toBe(0)
  })

  it('disconnects: revokes at Google and forgets the token', async () => {
    const db = await connected()
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }))
    const res = await call(env(db), '/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(200)
    expect(fetchMock.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/revoke')
    expect(db.rows.size).toBe(0)
  })
})

describe('calendar and task helpers', () => {
  it('spreads events over the days they cover', () => {
    expect(eventDays({ id: 'a', start: { date: '2026-11-16' }, end: { date: '2026-11-19' } })).toEqual(['2026-11-16', '2026-11-17', '2026-11-18'])
    expect(eventDays({ id: 'b', start: { date: '2026-11-16' }, end: { date: '2026-11-17' } })).toEqual(['2026-11-16'])
    const s = new Date(2026, 10, 16, 22, 0).toISOString()
    const e = new Date(2026, 10, 17, 0, 0).toISOString()
    expect(eventDays({ id: 'c', start: { dateTime: s }, end: { dateTime: e } })).toEqual(['2026-11-16'])
  })

  it('keeps due dates as plain dates', () => {
    expect(taskDueDate('2026-11-20T00:00:00.000Z')).toBe('2026-11-20')
    expect(toTaskDue('2026-11-20')).toBe('2026-11-20T00:00:00.000Z')
    expect(toTaskDue('')).toBeUndefined()
  })

  it('orders open tasks with subtasks under their parent, completed ones last', () => {
    const tasks: GTask[] = [
      { id: 'b', title: 'B', status: 'needsAction', position: '2' },
      { id: 'a', title: 'A', status: 'needsAction', position: '1' },
      { id: 'a2', title: 'A2', status: 'needsAction', position: '2', parent: 'a' },
      { id: 'a1', title: 'A1', status: 'needsAction', position: '1', parent: 'a' },
      { id: 'x', title: 'X', status: 'completed', completed: '2026-11-01T00:00:00Z' },
      { id: 'y', title: 'Y', status: 'completed', completed: '2026-11-02T00:00:00Z' },
      { id: 'z', title: 'Z', status: 'needsAction', deleted: true },
    ]
    const { open, done } = orderTasks(tasks)
    expect(open.map((o) => `${o.task.id}:${o.depth}`)).toEqual(['a:0', 'a1:1', 'a2:1', 'b:0'])
    expect(done.map((d) => d.id)).toEqual(['y', 'x'])
  })
})
