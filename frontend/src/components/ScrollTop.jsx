// A round "back to the top" button that appears once the page is scrolled past 10 %.
import { useEffect, useState } from 'react'

export default function ScrollTop() {
  const [show, setShow] = useState(false)
  useEffect(() => {
    const check = () => {
      const room = document.documentElement.scrollHeight - window.innerHeight
      setShow(room > 0 && window.scrollY > room * 0.1)
    }
    check()
    window.addEventListener('scroll', check, { passive: true })
    window.addEventListener('resize', check)
    return () => { window.removeEventListener('scroll', check); window.removeEventListener('resize', check) }
  }, [])
  const toTop = () => {
    const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    window.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' })
  }
  return (
    <button type="button" className={`scroll-top ${show ? 'show' : ''}`} onClick={toTop} aria-label="Back to the top"
      tabIndex={show ? 0 : -1} aria-hidden={!show} data-testid="scroll-top">
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path fill="currentColor" d="M12 4.2c.9 0 1.7.5 2.1 1.3l5.2 10.1c.6 1.2-.1 2.6-1.4 2.6-.4 0-.7-.1-1-.3-1.5-.9-3.2-1.3-4.9-1.3s-3.4.4-4.9 1.3c-.3.2-.6.3-1 .3-1.3 0-2-1.4-1.4-2.6L9.9 5.5c.4-.8 1.2-1.3 2.1-1.3z" />
      </svg>
    </button>
  )
}
