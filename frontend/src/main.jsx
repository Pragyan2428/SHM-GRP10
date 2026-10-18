import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './styles.css'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)

// Let the intro animation (index.html) know the app has started so it can lift away after its
// minimum time. A timer rather than an animation frame, so background tabs are not held up.
setTimeout(() => window.shmIntro?.ready(), 0)
