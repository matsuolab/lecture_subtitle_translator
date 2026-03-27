import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ThemeProvider } from '@/context/ThemeContext'
import { LocaleProvider } from '@/context/LocaleContext'
import { GlossaryProvider } from '@/context/GlossaryContext'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LocaleProvider>
      <ThemeProvider>
        <GlossaryProvider>
          <App />
        </GlossaryProvider>
      </ThemeProvider>
    </LocaleProvider>
  </StrictMode>,
)
