import { useEffect, useRef } from 'react'

/**
 * Call `refresh` every `ms` while the page is visible and online, and right away when the
 * app comes back to the screen (tab switch, phone unlocked, window focused, network back).
 * Nothing runs while `paused` (e.g. a dialog is open, or a change is on its way to the server).
 */
export function useAutoRefresh(refresh: () => void, ms: number, paused = false) {
  const fn = useRef(refresh)
  fn.current = refresh
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  useEffect(() => {
    let last = Date.now()
    const run = (force = false) => {
      if (pausedRef.current || document.visibilityState !== 'visible' || navigator.onLine === false) return
      // Focus and visibility often fire together: don't refresh twice in a row.
      if (!force && Date.now() - last < 2000) return
      last = Date.now()
      fn.current()
    }
    const timer = window.setInterval(() => run(true), ms)
    const onShow = () => run()
    document.addEventListener('visibilitychange', onShow)
    window.addEventListener('focus', onShow)
    window.addEventListener('online', onShow)
    window.addEventListener('pageshow', onShow)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onShow)
      window.removeEventListener('focus', onShow)
      window.removeEventListener('online', onShow)
      window.removeEventListener('pageshow', onShow)
    }
  }, [ms])
}
