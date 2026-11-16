import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import {
  CalendarDays,
  CalendarPlus,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleCheck,
  ExternalLink,
  ListChecks,
  LoaderCircle,
  MapPin,
  Plus,
  RefreshCw,
  StickyNote,
  Trash2,
  Unplug,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { ApiError } from '@/lib/api'
import { dateLocale, useI18n } from '@/i18n'
import {
  addDays,
  connectGoogle,
  eventDays,
  eventRange,
  fromLocal,
  google,
  GoogleReauthError,
  hm,
  localTimeZone,
  orderTasks,
  startOfDay,
  startOfWeek,
  taskDueDate,
  toTaskDue,
  ymd,
  type GCalendar,
  type GEvent,
  type GoogleStatus,
  type GTask,
  type GTaskList,
} from '@/lib/google'

export type GoogleKind = 'calendar' | 'tasks'

interface Props {
  kind: GoogleKind
  /** Text from the search box: filters events and tasks. */
  query: string
  /** Turn an event or a task into a NoteFlare note (encrypted like any other). */
  onMakeNote: (title: string, body: string) => void
}

export function GooglePanel({ kind, query, onMakeNote }: Props) {
  const { t } = useI18n()
  const [status, setStatus] = useState<GoogleStatus | null>(null)
  const [failed, setFailed] = useState(false)
  const [connecting, setConnecting] = useState(false)

  const load = useCallback(() => {
    setFailed(false)
    google.status().then(setStatus, () => setFailed(true))
  }, [])
  useEffect(load, [load])

  /** Any call that finds the Google sign-in gone sends the panel back to "Connect". */
  const onError = useCallback(
    (e: unknown) => {
      if (e instanceof GoogleReauthError) {
        setStatus((s) => (s ? { ...s, connected: false } : s))
        toast.error(t('g.reauth'))
      } else {
        // Show what Google said (e.g. "Google Tasks API has not been used in project … or it is disabled").
        const g = e instanceof ApiError ? (e.body as { error?: { message?: string; status?: string } | string } | null)?.error : null
        const detail = typeof g === 'string' ? g : g?.message
        toast.error(t('g.failed'), detail ? { description: detail.slice(0, 300), duration: 15000 } : undefined)
        console.error(e)
      }
    },
    [t],
  )

  const connect = async () => {
    setConnecting(true)
    const r = await connectGoogle()
    setConnecting(false)
    if (r.ok) {
      toast.success(t('g.connected'))
      load()
    } else if (r.message !== 'timeout') toast.error(t('g.connectFailed', { msg: r.message }))
  }

  const disconnect = async () => {
    if (!window.confirm(t('g.disconnectConfirm'))) return
    await google.disconnect().catch(() => {})
    setStatus((s) => (s ? { ...s, connected: false, email: null } : s))
  }

  if (failed) return <Notice>{t('g.statusFailed')}</Notice>
  if (!status) return <Notice><LoaderCircle className="size-5 animate-spin" /></Notice>
  if (!status.configured) return <SetupGuide redirectUri={status.redirectUri} />
  if (!status.connected)
    return (
      <div className="mx-auto mt-16 flex max-w-md flex-col items-center gap-4 text-center">
        {kind === 'calendar' ? <CalendarDays className="size-10 text-muted-foreground" /> : <ListChecks className="size-10 text-muted-foreground" />}
        <h2 className="text-lg font-semibold">{kind === 'calendar' ? t('g.calendar') : t('g.tasks')}</h2>
        <p className="text-sm text-muted-foreground">{t('g.connectBody')}</p>
        <Button onClick={() => void connect()} disabled={connecting}>
          {connecting ? <LoaderCircle className="animate-spin" /> : <GoogleMark />} {t('g.connect')}
        </Button>
        <p className="text-xs text-muted-foreground">{t('g.privacy')}</p>
      </div>
    )

  const account = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="text-muted-foreground">
          <GoogleMark /> <span className="max-w-[12rem] truncate max-sm:hidden">{status.email ?? 'Google'}</span>
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="truncate">{status.email}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => void connect()}>
          <RefreshCw /> {t('g.reconnect')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void disconnect()}>
          <Unplug /> {t('g.disconnect')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return kind === 'calendar' ? (
    <CalendarView query={query} account={account} onError={onError} onMakeNote={onMakeNote} />
  ) : (
    <TasksView query={query} account={account} onError={onError} onMakeNote={onMakeNote} />
  )
}

interface ViewProps {
  query: string
  account: ReactNode
  onError: (e: unknown) => void
  onMakeNote: (title: string, body: string) => void
}

// =====================================================================================
// Calendar
// =====================================================================================

type CalMode = 'agenda' | 'month'
const CAL_MODE_KEY = 'noteflare:calMode'
const CAL_HIDDEN_KEY = 'noteflare:calHidden'

function readJSON<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}
function writeJSON(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* per-device preference only */
  }
}

interface CalEvent extends GEvent {
  calendarId: string
  color: string
  canEdit: boolean
}

const writable = (c: GCalendar) => c.accessRole === 'owner' || c.accessRole === 'writer'

function CalendarView({ query, account, onError, onMakeNote }: ViewProps) {
  const { t } = useI18n()
  const [mode, setModeState] = useState<CalMode>(() => readJSON<CalMode>(CAL_MODE_KEY, 'agenda'))
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()))
  const [calendars, setCalendars] = useState<GCalendar[] | null>(null)
  const [hidden, setHiddenState] = useState<string[]>(() => readJSON<string[]>(CAL_HIDDEN_KEY, []))
  const [events, setEvents] = useState<CalEvent[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState<{ event: CalEvent | null; day?: string } | null>(null)

  const setMode = (m: CalMode) => {
    setModeState(m)
    writeJSON(CAL_MODE_KEY, m)
  }
  const toggleCalendar = (id: string) => {
    const next = hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id]
    setHiddenState(next)
    writeJSON(CAL_HIDDEN_KEY, next)
  }

  // What is on screen: two weeks from the anchor's Monday, or the whole month grid.
  const range = useMemo(() => {
    if (mode === 'agenda') {
      const from = startOfWeek(anchor)
      return { from, to: addDays(from, 14) }
    }
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
    const from = startOfWeek(first)
    return { from, to: addDays(from, 42) }
  }, [mode, anchor])

  useEffect(() => {
    google.calendars().then(
      (list) => setCalendars(list.filter((c) => !c.hidden).sort((a, b) => Number(!!b.primary) - Number(!!a.primary))),
      onError,
    )
  }, [onError])

  const shown = useMemo(() => (calendars ?? []).filter((c) => !hidden.includes(c.id)), [calendars, hidden])

  const reload = useCallback(async () => {
    if (!calendars) return
    setLoading(true)
    const results = await Promise.allSettled(shown.map((c) => google.events(c.id, range.from, range.to)))
    const all: CalEvent[] = []
    results.forEach((r, i) => {
      const c = shown[i]
      if (r.status === 'fulfilled')
        for (const e of r.value)
          if (e.status !== 'cancelled') all.push({ ...e, calendarId: c.id, color: c.backgroundColor ?? 'var(--primary)', canEdit: writable(c) })
    })
    const firstError = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
    if (firstError) onError(firstError.reason)
    all.sort((a, b) => eventRange(a).start.getTime() - eventRange(b).start.getTime())
    setEvents(all)
    setLoading(false)
  }, [calendars, shown, range, onError])
  useEffect(() => void reload(), [reload])

  const q = query.trim().toLocaleLowerCase()
  const byDay = useMemo(() => {
    const map = new Map<string, CalEvent[]>()
    for (const e of events ?? []) {
      if (q && !`${e.summary ?? ''}\n${e.location ?? ''}\n${e.description ?? ''}`.toLocaleLowerCase().includes(q)) continue
      for (const d of eventDays(e)) map.set(d, [...(map.get(d) ?? []), e])
    }
    // All-day first, then by start time.
    for (const list of map.values()) list.sort((a, b) => Number(!b.start.date) - Number(!a.start.date) || eventRange(a).start.getTime() - eventRange(b).start.getTime())
    return map
  }, [events, q])

  const step = (dir: number) =>
    setAnchor((a) => (mode === 'agenda' ? addDays(a, dir * 14) : new Date(a.getFullYear(), a.getMonth() + dir, 1)))
  const title =
    mode === 'month'
      ? anchor.toLocaleDateString(dateLocale(), { month: 'long', year: 'numeric' })
      : `${range.from.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' })} – ${addDays(range.to, -1).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', year: 'numeric' })}`

  const writableCalendars = (calendars ?? []).filter(writable)

  return (
    <div className={cn('mx-auto grid w-full gap-5', mode === 'agenda' && 'max-w-3xl')}>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setAnchor(startOfDay(new Date()))}>
          {t('g.today')}
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label={t('g.prev')} onClick={() => step(-1)}>
          <ChevronLeft />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label={t('g.next')} onClick={() => step(1)}>
          <ChevronRight />
        </Button>
        <h2 className="mr-auto text-base font-semibold first-letter:uppercase">{title}</h2>
        {loading && <LoaderCircle className="size-4 animate-spin text-muted-foreground" />}
        <Segmented
          label={t('g.view')}
          value={mode}
          onChange={setMode}
          options={[
            { value: 'agenda', label: t('g.agenda') },
            { value: 'month', label: t('g.month') },
          ]}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm">
              <CalendarDays /> <span className="max-sm:hidden">{t('g.calendars')}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-80 w-64 overflow-y-auto">
            {(calendars ?? []).map((c) => (
              <DropdownMenuItem key={c.id} onSelect={(e) => (e.preventDefault(), toggleCalendar(c.id))}>
                <span
                  className="grid size-4 shrink-0 place-items-center rounded-sm border-2"
                  style={{ borderColor: c.backgroundColor, background: hidden.includes(c.id) ? 'transparent' : c.backgroundColor }}
                />
                <span className="truncate">{c.summaryOverride ?? c.summary}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {account}
        <Button size="sm" onClick={() => setEditing({ event: null, day: ymd(anchor) })} disabled={!writableCalendars.length}>
          <CalendarPlus /> {t('g.newEvent')}
        </Button>
      </div>

      {!events ? (
        <Notice>
          <LoaderCircle className="size-5 animate-spin" />
        </Notice>
      ) : mode === 'agenda' ? (
        <Agenda from={range.from} days={14} byDay={byDay} onOpen={(e) => setEditing({ event: e })} onNew={(day) => setEditing({ event: null, day })} />
      ) : (
        <MonthGrid from={range.from} month={anchor.getMonth()} byDay={byDay} onOpen={(e) => setEditing({ event: e })} onNew={(day) => setEditing({ event: null, day })} />
      )}

      <EventDialog
        open={!!editing}
        state={editing}
        calendars={writableCalendars}
        onClose={() => setEditing(null)}
        onSaved={() => (setEditing(null), void reload())}
        onError={onError}
        onMakeNote={onMakeNote}
      />
    </div>
  )
}

function timeLabel(e: GEvent, day: string, t: (k: 'g.allDay') => string) {
  const { start, end, allDay } = eventRange(e)
  if (allDay) return t('g.allDay')
  const s = ymd(start) === day ? hm(start) : '00:00'
  const en = ymd(end) === day ? hm(end) : '24:00'
  return `${s} – ${en}`
}

function Agenda({ from, days, byDay, onOpen, onNew }: { from: Date; days: number; byDay: Map<string, CalEvent[]>; onOpen: (e: CalEvent) => void; onNew: (day: string) => void }) {
  const { t } = useI18n()
  const today = ymd(new Date())
  const list = Array.from({ length: days }, (_, i) => addDays(from, i))
  return (
    <ol className="grid w-full gap-1">
      {list.map((d) => {
        const key = ymd(d)
        const items = byDay.get(key) ?? []
        return (
          <li key={key} className={cn('group grid grid-cols-[4.5rem_1fr] gap-3 rounded-xl px-2 py-2', key === today && 'bg-primary/10')}>
            <button type="button" onClick={() => onNew(key)} className="flex flex-col items-start rounded-md text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" title={t('g.newEvent')}>
              <span className={cn('text-2xl leading-none font-semibold tabular-nums', key === today && 'text-link')}>{d.getDate()}</span>
              <span className="mt-1 text-xs text-muted-foreground first-letter:uppercase">{d.toLocaleDateString(dateLocale(), { weekday: 'short' })}</span>
            </button>
            <div className="grid min-w-0 content-start gap-1.5">
              {items.length ? (
                items.map((e) => <EventChip key={`${e.calendarId}:${e.id}`} event={e} day={key} onOpen={onOpen} />)
              ) : (
                <span className="py-1.5 text-sm text-muted-foreground/60">—</span>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function EventChip({ event, day, onOpen, compact }: { event: CalEvent; day: string; onOpen: (e: CalEvent) => void; compact?: boolean }) {
  const { t } = useI18n()
  return (
    <button
      type="button"
      onClick={(ev) => (ev.stopPropagation(), onOpen(event))}
      className={cn(
        'flex min-w-0 items-center gap-2 rounded-lg text-left outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
        compact ? 'px-1 py-0.5 text-xs' : 'border bg-surface px-3 py-2 text-sm',
      )}
      title={event.summary}
    >
      <span className={cn('shrink-0 rounded-full', compact ? 'size-1.5' : 'h-8 w-1')} style={{ background: event.color }} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{event.summary || t('g.noTitle')}</span>
        {!compact && (
          <span className="flex items-center gap-2 truncate text-xs text-muted-foreground">
            {timeLabel(event, day, t)}
            {event.location && (
              <span className="flex min-w-0 items-center gap-1 truncate">
                <MapPin className="size-3 shrink-0" />
                <span className="truncate">{event.location}</span>
              </span>
            )}
          </span>
        )}
      </span>
    </button>
  )
}

function MonthGrid({ from, month, byDay, onOpen, onNew }: { from: Date; month: number; byDay: Map<string, CalEvent[]>; onOpen: (e: CalEvent) => void; onNew: (day: string) => void }) {
  const { t } = useI18n()
  const today = ymd(new Date())
  const cells = Array.from({ length: 42 }, (_, i) => addDays(from, i))
  const weekdays = cells.slice(0, 7).map((d) => d.toLocaleDateString(dateLocale(), { weekday: 'short' }))
  return (
    <div className="overflow-hidden rounded-xl border">
      <div className="grid grid-cols-7 border-b bg-muted/60 text-center text-xs font-medium text-muted-foreground">
        {weekdays.map((w) => (
          <div key={w} className="py-2 first-letter:uppercase">{w}</div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((d, i) => {
          const key = ymd(d)
          const items = byDay.get(key) ?? []
          return (
            <div
              key={key}
              role="button"
              tabIndex={0}
              aria-label={`${t('g.newEvent')} ${d.toLocaleDateString(dateLocale())}`}
              onClick={() => onNew(key)}
              onKeyDown={(e) => e.key === 'Enter' && onNew(key)}
              className={cn(
                'min-h-24 min-w-0 cursor-pointer p-1 outline-none hover:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 max-sm:min-h-16',
                i % 7 && 'border-l',
                i >= 7 && 'border-t',
                d.getMonth() !== month && 'bg-muted/30 text-muted-foreground',
              )}
            >
              <div className={cn('mb-0.5 grid size-6 place-items-center rounded-full text-xs tabular-nums', key === today && 'bg-primary font-semibold text-primary-foreground')}>
                {d.getDate()}
              </div>
              <div className="grid gap-px">
                {items.slice(0, 3).map((e) => (
                  <EventChip key={`${e.calendarId}:${e.id}`} event={e} day={key} onOpen={onOpen} compact />
                ))}
                {items.length > 3 && <span className="px-1 text-[11px] text-muted-foreground">+{items.length - 3}</span>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

interface EventForm {
  calendarId: string
  summary: string
  allDay: boolean
  startDate: string
  startTime: string
  endDate: string
  endTime: string
  location: string
  description: string
}

function formFor(state: { event: CalEvent | null; day?: string }, calendars: GCalendar[]): EventForm {
  const e = state.event
  if (!e) {
    const now = new Date()
    const nextHour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1)
    const day = state.day ?? ymd(now)
    const startTime = hm(nextHour)
    return {
      calendarId: (calendars.find((c) => c.primary) ?? calendars[0])?.id ?? '',
      summary: '',
      allDay: false,
      startDate: day,
      startTime,
      endDate: day,
      endTime: hm(new Date(nextHour.getTime() + 3600_000)),
      location: '',
      description: '',
    }
  }
  const { start, end, allDay } = eventRange(e)
  const shownEnd = allDay ? addDays(end, -1) : end
  return {
    calendarId: e.calendarId,
    summary: e.summary ?? '',
    allDay,
    startDate: ymd(start),
    startTime: hm(start),
    endDate: ymd(shownEnd),
    endTime: hm(end),
    location: e.location ?? '',
    description: e.description ?? '',
  }
}

function EventDialog({
  open,
  state,
  calendars,
  onClose,
  onSaved,
  onError,
  onMakeNote,
}: {
  open: boolean
  state: { event: CalEvent | null; day?: string } | null
  calendars: GCalendar[]
  onClose: () => void
  onSaved: () => void
  onError: (e: unknown) => void
  onMakeNote: (title: string, body: string) => void
}) {
  const { t } = useI18n()
  const [form, setForm] = useState<EventForm | null>(null)
  const [busy, setBusy] = useState(false)
  // While the dialog animates closed, keep showing what it showed (state is already null).
  const [shown, setShown] = useState(state)
  if (state && state !== shown) {
    setShown(state)
    setForm(formFor(state, calendars))
  }
  const event = shown?.event ?? null
  const readOnly = !!event && !event.canEdit
  const set = <K extends keyof EventForm>(k: K, v: EventForm[K]) => setForm((f) => (f ? { ...f, [k]: v } : f))

  const submit = async (ev: FormEvent) => {
    ev.preventDefault()
    if (!form || readOnly) return
    const start = form.allDay ? null : fromLocal(form.startDate, form.startTime)
    let end = form.allDay ? null : fromLocal(form.endDate || form.startDate, form.endTime)
    if (start && end && end <= start) end = new Date(start.getTime() + 3600_000)
    const endDate = form.endDate && form.endDate >= form.startDate ? form.endDate : form.startDate
    const tz = localTimeZone()
    const body: Partial<GEvent> = {
      summary: form.summary.trim(),
      location: form.location.trim(),
      description: form.description,
      start: form.allDay ? { date: form.startDate, dateTime: undefined } : { dateTime: start!.toISOString(), timeZone: tz },
      end: form.allDay ? { date: ymd(addDays(fromLocal(endDate), 1)) } : { dateTime: end!.toISOString(), timeZone: tz },
    }
    // PATCH merges fields: clear the other kind of time when switching all-day on or off.
    if (event) {
      body.start = form.allDay ? { date: form.startDate, dateTime: null as never } : { ...body.start, date: null as never }
      body.end = form.allDay ? { ...body.end, dateTime: null as never } : { ...body.end, date: null as never }
    }
    setBusy(true)
    try {
      if (!event) await google.createEvent(form.calendarId, body)
      else if (event.calendarId === form.calendarId) await google.updateEvent(event.calendarId, event.id, body)
      else {
        // Moving to another calendar: create there, then remove the original.
        await google.createEvent(form.calendarId, body)
        await google.deleteEvent(event.calendarId, event.id)
      }
      toast.success(event ? t('g.eventSaved') : t('g.eventCreated'))
      onSaved()
    } catch (e) {
      onError(e)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!event || !window.confirm(event.recurringEventId ? t('g.deleteOccurrence') : t('g.deleteEventConfirm'))) return
    setBusy(true)
    try {
      await google.deleteEvent(event.calendarId, event.id)
      toast(t('g.eventDeleted'))
      onSaved()
    } catch (e) {
      onError(e)
    } finally {
      setBusy(false)
    }
  }

  const makeNote = () => {
    if (!event || !form) return
    const { start, end, allDay } = eventRange(event)
    const when = allDay
      ? start.toLocaleDateString(dateLocale(), { dateStyle: 'full' })
      : `${hm(start)} – ${hm(end)}, ${start.toLocaleDateString(dateLocale(), { dateStyle: 'full' })}`
    const lines = [`📅 ${when}`]
    if (event.location) lines.push(`📍 ${event.location}`)
    if (event.hangoutLink) lines.push(`🎥 ${event.hangoutLink}`)
    if (event.description) lines.push('', stripHtml(event.description))
    if (event.htmlLink) lines.push('', `[${t('g.openInGoogle')}](${event.htmlLink})`)
    onClose()
    onMakeNote(event.summary ?? '', lines.join('\n'))
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{event ? (readOnly ? event.summary || t('g.noTitle') : t('g.editEvent')) : t('g.newEvent')}</DialogTitle>
          <DialogDescription className={cn(!readOnly && 'sr-only')}>{readOnly ? t('g.readOnlyCalendar') : t('g.eventHint')}</DialogDescription>
        </DialogHeader>
        {form && (
          <form onSubmit={submit} className="grid gap-3">
            <fieldset disabled={readOnly || busy} className="grid gap-3">
              <Input autoFocus={!event} placeholder={t('g.eventTitle')} aria-label={t('g.eventTitle')} value={form.summary} onChange={(e) => set('summary', e.target.value)} />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={form.allDay} onChange={(e) => set('allDay', e.target.checked)} />
                {t('g.allDay')}
              </label>
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <Input type="date" aria-label={t('g.start')} value={form.startDate} onChange={(e) => (set('startDate', e.target.value), form.endDate < e.target.value && set('endDate', e.target.value))} required />
                {!form.allDay && <Input type="time" aria-label={t('g.startTime')} value={form.startTime} onChange={(e) => set('startTime', e.target.value)} required />}
                <Input type="date" aria-label={t('g.end')} value={form.endDate} min={form.startDate} onChange={(e) => set('endDate', e.target.value)} />
                {!form.allDay && <Input type="time" aria-label={t('g.endTime')} value={form.endTime} onChange={(e) => set('endTime', e.target.value)} />}
              </div>
              <Input placeholder={t('g.location')} aria-label={t('g.location')} value={form.location} onChange={(e) => set('location', e.target.value)} />
              <Textarea placeholder={t('g.description')} aria-label={t('g.description')} value={readOnly ? stripHtml(form.description) : form.description} onChange={(e) => set('description', e.target.value)} className="max-h-60" />
              {!readOnly && calendars.length > 1 && (
                <select
                  aria-label={t('g.calendar')}
                  value={form.calendarId}
                  onChange={(e) => set('calendarId', e.target.value)}
                  className="h-9 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  {calendars.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.summaryOverride ?? c.summary}
                    </option>
                  ))}
                </select>
              )}
            </fieldset>
            <DialogFooter className="mt-2 flex-wrap gap-2 sm:justify-between">
              <div className="flex gap-2">
                {event && (
                  <Button type="button" variant="ghost" size="icon" aria-label={t('g.toNote')} title={t('g.toNote')} onClick={makeNote}>
                    <StickyNote />
                  </Button>
                )}
                {event?.htmlLink && (
                  <Button type="button" variant="ghost" size="icon" asChild>
                    <a href={event.htmlLink} target="_blank" rel="noopener noreferrer" aria-label={t('g.openInGoogle')} title={t('g.openInGoogle')}>
                      <ExternalLink />
                    </a>
                  </Button>
                )}
                {event && !readOnly && (
                  <Button type="button" variant="ghost" size="icon" aria-label={t('g.delete')} title={t('g.delete')} onClick={() => void remove()} disabled={busy}>
                    <Trash2 />
                  </Button>
                )}
              </div>
              {!readOnly && (
                <Button type="submit" disabled={busy}>
                  {busy && <LoaderCircle className="animate-spin" />} {t('g.save')}
                </Button>
              )}
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Google event descriptions may hold HTML; notes and the read-only view want plain text. */
function stripHtml(s: string) {
  if (!/<[a-z][\s\S]*>/i.test(s)) return s
  const doc = new DOMParser().parseFromString(s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n'), 'text/html')
  return (doc.body.textContent ?? '').trim()
}

// =====================================================================================
// Tasks
// =====================================================================================

const TASK_LIST_KEY = 'noteflare:taskList'

function TasksView({ query, account, onError, onMakeNote }: ViewProps) {
  const { t } = useI18n()
  const [lists, setLists] = useState<GTaskList[] | null>(null)
  const [listId, setListIdState] = useState<string>(() => readJSON<string>(TASK_LIST_KEY, ''))
  const [tasks, setTasks] = useState<GTask[] | null>(null)
  const [title, setTitle] = useState('')
  const [showDone, setShowDone] = useState(false)
  const [editing, setEditing] = useState<GTask | null>(null)

  const setListId = (id: string) => {
    setListIdState(id)
    writeJSON(TASK_LIST_KEY, id)
  }

  useEffect(() => {
    google.taskLists().then((l) => {
      setLists(l)
      setListIdState((cur) => (l.some((x) => x.id === cur) ? cur : (l[0]?.id ?? '')))
    }, onError)
  }, [onError])

  const reload = useCallback(() => {
    if (!listId) return
    google.tasks(listId).then(setTasks, onError)
  }, [listId, onError])
  useEffect(() => {
    setTasks(null)
    reload()
  }, [reload])

  const q = query.trim().toLocaleLowerCase()
  const { open, done } = useMemo(() => {
    const filtered = (tasks ?? []).filter((x) => !q || `${x.title ?? ''}\n${x.notes ?? ''}`.toLocaleLowerCase().includes(q))
    return orderTasks(filtered)
  }, [tasks, q])

  const replace = (task: GTask) => setTasks((cur) => cur?.map((x) => (x.id === task.id ? task : x)) ?? cur)

  const add = async (e: FormEvent) => {
    e.preventDefault()
    const text = title.trim()
    if (!text || !listId) return
    setTitle('')
    try {
      const created = await google.createTask(listId, { title: text })
      setTasks((cur) => [created, ...(cur ?? [])])
    } catch (err) {
      setTitle(text)
      onError(err)
    }
  }

  const toggle = async (task: GTask) => {
    const completed = task.status !== 'completed'
    replace({ ...task, status: completed ? 'completed' : 'needsAction', completed: completed ? new Date().toISOString() : null })
    try {
      replace(await google.updateTask(listId, task.id, completed ? { status: 'completed' } : { status: 'needsAction', completed: null }))
      if (completed)
        toast(t('g.taskDone'), {
          action: { label: t('common.undo'), onClick: () => void toggle({ ...task, status: 'completed' }) },
        })
    } catch (err) {
      replace(task)
      onError(err)
    }
  }

  const newList = async () => {
    const name = window.prompt(t('g.newListPrompt'))?.trim()
    if (!name) return
    try {
      const l = await google.createTaskList(name)
      setLists((cur) => [...(cur ?? []), l])
      setListId(l.id)
    } catch (err) {
      onError(err)
    }
  }

  const clearDone = async () => {
    if (!done.length || !window.confirm(t('g.clearDoneConfirm', { n: done.length }))) return
    const ids = new Set(done.map((x) => x.id))
    setTasks((cur) => cur?.filter((x) => !ids.has(x.id)) ?? cur)
    const results = await Promise.allSettled(done.map((x) => google.deleteTask(listId, x.id)))
    if (results.some((r) => r.status === 'rejected')) reload()
  }

  const current = lists?.find((l) => l.id === listId)

  return (
    <div className="mx-auto grid w-full max-w-2xl gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="mr-auto max-w-full">
              <ListChecks /> <span className="truncate">{current?.title ?? t('g.tasks')}</span> <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
            {(lists ?? []).map((l) => (
              <DropdownMenuItem key={l.id} onSelect={() => setListId(l.id)}>
                <span className="grid size-4 place-items-center">{l.id === listId && <CircleCheck />}</span>
                <span className="truncate">{l.title}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void newList()}>
              <Plus /> {t('g.newList')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="ghost" size="icon-sm" aria-label={t('g.refresh')} onClick={reload}>
          <RefreshCw />
        </Button>
        {account}
      </div>

      <form onSubmit={add} className="flex items-center gap-2 rounded-2xl border bg-surface px-3 py-1.5 focus-within:shadow-[0_0_0_1.5px_var(--ring)]">
        <Plus className="size-5 shrink-0 text-muted-foreground" />
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('g.addTask')}
          aria-label={t('g.addTask')}
          enterKeyHint="done"
          disabled={!listId}
          className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </form>

      {!tasks ? (
        <Notice>
          <LoaderCircle className="size-5 animate-spin" />
        </Notice>
      ) : (
        <>
          {open.length ? (
            <ul className="grid gap-1">
              {open.map(({ task, depth }) => (
                <TaskRow key={task.id} task={task} depth={depth} onToggle={toggle} onOpen={setEditing} />
              ))}
            </ul>
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">{q ? t('nb.emptySearch', { q: query }) : t('g.noTasks')}</p>
          )}
          {done.length > 0 && (
            <section>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowDone((s) => !s)}
                  className="flex items-center gap-1.5 rounded-md px-1 py-1 text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  aria-expanded={showDone}
                >
                  <ChevronDown className={cn('size-4 transition-transform', !showDone && '-rotate-90')} />
                  {t('g.completed', { n: done.length })}
                </button>
                {showDone && (
                  <Button variant="ghost" size="sm" className="ml-auto text-muted-foreground" onClick={() => void clearDone()}>
                    <Trash2 /> {t('g.clearDone')}
                  </Button>
                )}
              </div>
              {showDone && (
                <ul className="mt-1 grid gap-1">
                  {done.map((task) => (
                    <TaskRow key={task.id} task={task} depth={0} onToggle={toggle} onOpen={setEditing} />
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}

      <TaskDialog
        task={editing}
        listId={listId}
        onClose={() => setEditing(null)}
        onSaved={(task) => (replace(task), setEditing(null))}
        onDeleted={(id) => (setTasks((cur) => cur?.filter((x) => x.id !== id && x.parent !== id) ?? cur), setEditing(null))}
        onAddSubtask={async (parent, text) => {
          try {
            const created = await google.createTask(listId, { title: text }, parent.id)
            setTasks((cur) => [...(cur ?? []), created])
          } catch (err) {
            onError(err)
          }
        }}
        onError={onError}
        onMakeNote={onMakeNote}
      />
    </div>
  )
}

function dueLabel(due: string | undefined, t: (k: 'g.today' | 'g.tomorrow' | 'g.overdue') => string) {
  const d = taskDueDate(due)
  if (!d) return null
  const today = ymd(new Date())
  const tomorrow = ymd(addDays(new Date(), 1))
  const text = d === today ? t('g.today') : d === tomorrow ? t('g.tomorrow') : fromLocal(d).toLocaleDateString(dateLocale(), { weekday: 'short', day: 'numeric', month: 'short' })
  return { text, overdue: d < today }
}

function TaskRow({ task, depth, onToggle, onOpen }: { task: GTask; depth: number; onToggle: (t: GTask) => void; onOpen: (t: GTask) => void }) {
  const { t } = useI18n()
  const done = task.status === 'completed'
  const due = dueLabel(task.due, t)
  return (
    <li className={cn('group flex items-start gap-2 rounded-xl px-2 py-1.5 hover:bg-accent/60', depth && 'ml-8')}>
      <button
        type="button"
        role="checkbox"
        aria-checked={done}
        aria-label={task.title || t('g.noTitle')}
        onClick={() => onToggle(task)}
        className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground outline-none hover:text-link focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {done ? <CircleCheck className="size-5 text-link" /> : <Circle className="size-5" />}
      </button>
      <button type="button" onClick={() => onOpen(task)} className="min-w-0 flex-1 rounded-md py-1 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <span className={cn('block text-sm break-words', done && 'text-muted-foreground line-through')}>{task.title || t('g.noTitle')}</span>
        {task.notes && <span className="line-clamp-2 text-xs text-muted-foreground">{task.notes}</span>}
        {due && !done && (
          <span className={cn('mt-1 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs', due.overdue ? 'border-destructive/40 text-destructive' : 'text-muted-foreground')}>
            <CalendarDays className="size-3" /> {due.text}
          </span>
        )}
      </button>
    </li>
  )
}

function TaskDialog({
  task: taskProp,
  listId,
  onClose,
  onSaved,
  onDeleted,
  onAddSubtask,
  onError,
  onMakeNote,
}: {
  task: GTask | null
  listId: string
  onClose: () => void
  onSaved: (t: GTask) => void
  onDeleted: (id: string) => void
  onAddSubtask: (parent: GTask, title: string) => Promise<void>
  onError: (e: unknown) => void
  onMakeNote: (title: string, body: string) => void
}) {
  const { t } = useI18n()
  const [last, setLast] = useState(taskProp)
  if (taskProp && taskProp !== last) setLast(taskProp)
  const task = taskProp ?? last
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [due, setDue] = useState('')
  const [sub, setSub] = useState('')
  const [busy, setBusy] = useState(false)
  const [forId, setForId] = useState<string | null>(null)
  if (task && task.id !== forId) {
    setForId(task.id)
    setTitle(task?.title ?? '')
    setNotes(task?.notes ?? '')
    setDue(taskDueDate(task?.due))
    setSub('')
  }

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!task) return
    setBusy(true)
    try {
      onSaved(await google.updateTask(listId, task.id, { title: title.trim(), notes, due: toTaskDue(due) ?? (null as never) }))
    } catch (err) {
      onError(err)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!task) return
    setBusy(true)
    try {
      await google.deleteTask(listId, task.id)
      toast(t('g.taskDeleted'))
      onDeleted(task.id)
    } catch (err) {
      onError(err)
    } finally {
      setBusy(false)
    }
  }

  const addSub = async () => {
    const text = sub.trim()
    if (!task || !text) return
    setSub('')
    await onAddSubtask(task, text)
    toast(t('g.subtaskAdded'))
  }

  const makeNote = () => {
    if (!task) return
    const lines: string[] = []
    if (due) lines.push(`📅 ${fromLocal(due).toLocaleDateString(dateLocale(), { dateStyle: 'full' })}`)
    lines.push(`- [${task.status === 'completed' ? 'x' : ' '}] ${title || task.title || ''}`)
    if (notes) lines.push('', notes)
    onClose()
    onMakeNote(title || task.title || '', lines.join('\n'))
  }

  return (
    <Dialog open={!!taskProp} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('g.editTask')}</DialogTitle>
          <DialogDescription className="sr-only">{t('g.editTask')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="grid gap-3">
          <fieldset disabled={busy} className="grid gap-3">
            <Input aria-label={t('g.taskTitle')} placeholder={t('g.taskTitle')} value={title} onChange={(e) => setTitle(e.target.value)} />
            <Textarea aria-label={t('g.details')} placeholder={t('g.details')} value={notes} onChange={(e) => setNotes(e.target.value)} className="max-h-60" />
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">{t('g.due')}</span>
              <div className="flex gap-2">
                <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
                {due && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setDue('')}>
                    {t('g.clear')}
                  </Button>
                )}
              </div>
            </label>
            {!task?.parent && (
              <div className="flex gap-2">
                <Input
                  aria-label={t('g.addSubtask')}
                  placeholder={t('g.addSubtask')}
                  value={sub}
                  onChange={(e) => setSub(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), void addSub())}
                />
                <Button type="button" variant="outline" size="icon" aria-label={t('g.addSubtask')} onClick={() => void addSub()} disabled={!sub.trim()}>
                  <Plus />
                </Button>
              </div>
            )}
          </fieldset>
          <DialogFooter className="mt-2 flex-wrap gap-2 sm:justify-between">
            <div className="flex gap-2">
              <Button type="button" variant="ghost" size="icon" aria-label={t('g.toNote')} title={t('g.toNote')} onClick={makeNote}>
                <StickyNote />
              </Button>
              {task?.webViewLink && (
                <Button type="button" variant="ghost" size="icon" asChild>
                  <a href={task.webViewLink} target="_blank" rel="noopener noreferrer" aria-label={t('g.openInGoogle')} title={t('g.openInGoogle')}>
                    <ExternalLink />
                  </a>
                </Button>
              )}
              <Button type="button" variant="ghost" size="icon" aria-label={t('g.delete')} title={t('g.delete')} onClick={() => void remove()} disabled={busy}>
                <Trash2 />
              </Button>
            </div>
            <Button type="submit" disabled={busy}>
              {busy && <LoaderCircle className="animate-spin" />} {t('g.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// =====================================================================================
// Shared bits
// =====================================================================================

function Notice({ children }: { children: ReactNode }) {
  return <div className="mt-20 flex justify-center text-center text-sm text-muted-foreground">{children}</div>
}

function SetupGuide({ redirectUri }: { redirectUri: string }) {
  const { t } = useI18n()
  return (
    <div className="mx-auto mt-10 grid max-w-xl gap-3 rounded-2xl border bg-surface p-6 text-sm">
      <h2 className="text-base font-semibold">{t('g.setupTitle')}</h2>
      <p className="text-muted-foreground">{t('g.setupBody')}</p>
      <ol className="grid list-decimal gap-1.5 pl-5">
        <li>{t('g.setup1')}</li>
        <li>{t('g.setup2')}</li>
        <li>
          {t('g.setup3')} <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-all select-all">{redirectUri}</code>
        </li>
        <li>{t('g.setup4')}</li>
      </ol>
    </div>
  )
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-4">
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.7v3h3.9c2.3-2.1 3.5-5.2 3.5-8.9Z" />
      <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6h-4a12 12 0 0 0 0 10.8l4-3.1Z" />
      <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8L20 3.2A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9Z" />
    </svg>
  )
}
