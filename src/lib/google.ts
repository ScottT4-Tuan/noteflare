import { ApiError } from './api'

/**
 * Google Calendar and Google Tasks, through the Worker (worker/google.ts).
 * Calls go to /api/google/{calendar,tasks}/…, which the Worker forwards to Google with the
 * owner's access token. This data is not end-to-end encrypted like notes.
 */

export interface GoogleStatus {
  configured: boolean
  connected: boolean
  email?: string | null
  redirectUri: string
}

export interface GCalendar {
  id: string
  summary: string
  summaryOverride?: string
  backgroundColor?: string
  foregroundColor?: string
  primary?: boolean
  selected?: boolean
  hidden?: boolean
  accessRole: 'freeBusyReader' | 'reader' | 'writer' | 'owner'
  timeZone?: string
}

export interface GEventTime {
  date?: string
  dateTime?: string
  timeZone?: string
}

export interface GEvent {
  id: string
  status?: string
  summary?: string
  description?: string
  location?: string
  htmlLink?: string
  hangoutLink?: string
  start: GEventTime
  end: GEventTime
  recurringEventId?: string
  colorId?: string
  attendees?: { email: string; self?: boolean; responseStatus?: string }[]
}

export interface GTaskList {
  id: string
  title: string
  updated?: string
}

export interface GTask {
  id: string
  title?: string
  notes?: string
  status: 'needsAction' | 'completed'
  due?: string
  completed?: string | null
  parent?: string
  position?: string
  deleted?: boolean
  hidden?: boolean
  updated?: string
  webViewLink?: string
}

/** The Google account needs to be connected again (revoked, expired or never connected). */
export class GoogleReauthError extends Error {}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/google${path}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'manual',
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (res.type === 'opaqueredirect') throw new ApiError(401, null)
  if (res.status === 204) return undefined as T
  const body = await res.json().catch(() => null)
  if (res.status === 401 && (body as { error?: string } | null)?.error === 'google_reauth') throw new GoogleReauthError()
  if (!res.ok) throw new ApiError(res.status, body)
  return body as T
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) })
const enc = encodeURIComponent

/** Follow nextPageToken until every page is read (bounded, to stay friendly to quotas). */
async function allPages<T>(path: string, key = 'items', maxPages = 10): Promise<T[]> {
  const out: T[] = []
  let token: string | undefined
  for (let i = 0; i < maxPages; i++) {
    const sep = path.includes('?') ? '&' : '?'
    const page = await call<Record<string, unknown>>(token ? `${path}${sep}pageToken=${enc(token)}` : path)
    out.push(...(((page[key] as T[] | undefined) ?? []) as T[]))
    token = page.nextPageToken as string | undefined
    if (!token) break
  }
  return out
}

export const google = {
  status: () => call<GoogleStatus>('/status'),
  disconnect: () => call<{ ok: true }>('/disconnect', { method: 'POST', body: '{}' }),

  calendars: () => allPages<GCalendar>('/calendar/users/me/calendarList?maxResults=250'),
  events: (calendarId: string, timeMin: Date, timeMax: Date) =>
    allPages<GEvent>(
      `/calendar/calendars/${enc(calendarId)}/events?singleEvents=true&orderBy=startTime&maxResults=250&timeMin=${enc(timeMin.toISOString())}&timeMax=${enc(timeMax.toISOString())}`,
      'items',
      4,
    ),
  createEvent: (calendarId: string, event: Partial<GEvent>) =>
    call<GEvent>(`/calendar/calendars/${enc(calendarId)}/events`, json('POST', event)),
  updateEvent: (calendarId: string, eventId: string, patch: Partial<GEvent>) =>
    call<GEvent>(`/calendar/calendars/${enc(calendarId)}/events/${enc(eventId)}`, json('PATCH', patch)),
  deleteEvent: (calendarId: string, eventId: string) =>
    call<void>(`/calendar/calendars/${enc(calendarId)}/events/${enc(eventId)}`, { method: 'DELETE' }),

  taskLists: () => allPages<GTaskList>('/tasks/users/@me/lists?maxResults=100'),
  createTaskList: (title: string) => call<GTaskList>('/tasks/users/@me/lists', json('POST', { title })),
  tasks: (listId: string) =>
    allPages<GTask>(`/tasks/lists/${enc(listId)}/tasks?showCompleted=true&showHidden=true&maxResults=100`),
  createTask: (listId: string, task: Partial<GTask>, parent?: string) =>
    call<GTask>(`/tasks/lists/${enc(listId)}/tasks${parent ? `?parent=${enc(parent)}` : ''}`, json('POST', task)),
  updateTask: (listId: string, taskId: string, patch: Partial<GTask>) =>
    call<GTask>(`/tasks/lists/${enc(listId)}/tasks/${enc(taskId)}`, json('PATCH', patch)),
  deleteTask: (listId: string, taskId: string) =>
    call<void>(`/tasks/lists/${enc(listId)}/tasks/${enc(taskId)}`, { method: 'DELETE' }),
}

/**
 * Open Google's consent screen in a popup and resolve when the callback page reports back
 * (BroadcastChannel, or localStorage where a channel can't reach, e.g. some installed apps).
 */
export function connectGoogle(): Promise<{ ok: boolean; message: string }> {
  const w = 520
  const h = 680
  const left = Math.max(0, (window.screenX ?? 0) + (window.outerWidth - w) / 2)
  const top = Math.max(0, (window.screenY ?? 0) + (window.outerHeight - h) / 2)
  const popup = window.open('/api/google/connect', 'noteflare-google', `popup,width=${w},height=${h},left=${left},top=${top}`)
  if (!popup) {
    // Popups blocked: go there in this tab; the callback page comes back to the app.
    location.href = '/api/google/connect'
    return new Promise(() => {})
  }
  return new Promise((resolve) => {
    let done = false
    const started = Date.now()
    const channel = 'BroadcastChannel' in window ? new BroadcastChannel('noteflare-google') : null
    const finish = (r: { ok: boolean; message: string }) => {
      if (done) return
      done = true
      channel?.close()
      window.removeEventListener('storage', onStorage)
      window.clearInterval(poll)
      resolve(r)
    }
    channel?.addEventListener('message', (e) => e.data?.type === 'google' && finish(e.data))
    const onStorage = (e: StorageEvent) => {
      if (e.key !== 'noteflare:google-result' || !e.newValue) return
      try {
        const r = JSON.parse(e.newValue)
        if (r.at >= started) finish(r)
      } catch {
        /* ignore */
      }
    }
    window.addEventListener('storage', onStorage)
    // COOP cuts the link to the popup once it reaches Google, so `closed` may never be seen;
    // give up quietly after 10 minutes (the sign-in cookie lasts as long).
    const poll = window.setInterval(() => {
      if (Date.now() - started > 600_000) finish({ ok: false, message: 'timeout' })
    }, 2000)
  })
}

// ---------- dates ----------

const pad = (n: number) => String(n).padStart(2, '0')
/** "2026-11-17" for a local date. */
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
/** "09:30" for a local time. */
export const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
/** A local Date from "2026-11-17" and optionally "09:30". */
export const fromLocal = (date: string, time = '00:00') => {
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  return new Date(y, m - 1, d, hh || 0, mm || 0)
}
export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes())
export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
/** Monday-based start of the week. */
export const startOfWeek = (d: Date) => addDays(startOfDay(d), -((d.getDay() + 6) % 7))
export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

/** When an event starts and ends, as local Dates. All-day ends are exclusive (the next day). */
export function eventRange(e: GEvent): { start: Date; end: Date; allDay: boolean } {
  if (e.start.date) {
    const start = fromLocal(e.start.date)
    const end = e.end?.date ? fromLocal(e.end.date) : addDays(start, 1)
    return { start, end, allDay: true }
  }
  const start = new Date(e.start.dateTime!)
  const end = e.end?.dateTime ? new Date(e.end.dateTime) : start
  return { start, end, allDay: false }
}

/** The local days ("YYYY-MM-DD") an event covers, so multi-day events show on each day. */
export function eventDays(e: GEvent): string[] {
  const { start, end, allDay } = eventRange(e)
  const days: string[] = []
  let d = startOfDay(start)
  // A timed event ending exactly at midnight doesn't cover the next day.
  const last = allDay ? addDays(startOfDay(end), -1) : startOfDay(new Date(Math.max(start.getTime(), end.getTime() - 1)))
  for (let i = 0; d <= last && i < 62; i++, d = addDays(d, 1)) days.push(ymd(d))
  return days.length ? days : [ymd(start)]
}

/** Google Tasks keeps only the date of `due` (as midnight UTC). */
export const taskDueDate = (due?: string) => (due ? due.slice(0, 10) : '')
export const toTaskDue = (date: string) => (date ? `${date}T00:00:00.000Z` : undefined)

/** Incomplete tasks in Google's order with their subtasks under them; then the completed ones. */
export function orderTasks(tasks: GTask[]): { open: { task: GTask; depth: number }[]; done: GTask[] } {
  const live = tasks.filter((t) => !t.deleted)
  const byPos = (a: GTask, b: GTask) => (a.position ?? '').localeCompare(b.position ?? '')
  const ids = new Set(live.map((t) => t.id))
  const open = live.filter((t) => t.status !== 'completed')
  const roots = open.filter((t) => !t.parent || !ids.has(t.parent)).sort(byPos)
  const out: { task: GTask; depth: number }[] = []
  for (const r of roots) {
    out.push({ task: r, depth: 0 })
    for (const c of open.filter((t) => t.parent === r.id).sort(byPos)) out.push({ task: c, depth: 1 })
  }
  const done = live
    .filter((t) => t.status === 'completed')
    .sort((a, b) => (b.completed ?? '').localeCompare(a.completed ?? ''))
  return { open: out, done }
}
