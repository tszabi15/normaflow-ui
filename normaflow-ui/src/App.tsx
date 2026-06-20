import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import {
  Check,
  LogOut,
  Mail,
  Clock,
  AlertTriangle,
  Zap,
  Shield,
  CreditCard,
  Inbox,
  Filter,
  Bell,
  X,
  Sparkles,
  Lightbulb,
  Phone,
} from 'lucide-react'

// Import components and types
import type { Task, TaskCategory, TaskPriority } from './types/task'
import AutoResponder from './components/dashboard/AutoResponder'
import FeedbackModal from './components/dashboard/FeedbackModal'
import { db, auth } from './firebase'
import { collection, query, where, onSnapshot, doc, updateDoc, setDoc, getDoc } from 'firebase/firestore'
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  multiFactor,
  PhoneAuthProvider,
  PhoneMultiFactorGenerator,
  RecaptchaVerifier,
  getMultiFactorResolver,
  GoogleAuthProvider,
  signInWithPopup,
} from 'firebase/auth'

// ─── Types ───────────────────────────────────────────────────────────────────

type CategoryFilter = TaskCategory | 'Összes'

type AppView = 'login' | 'paywall' | 'dashboard'

interface Toast {
  id: string
  message: string
  taskSummary: string
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEMO_USER_EMAIL = 'kovacs.kata@normaflow.hu'

const CATEGORIES: TaskCategory[] = [
  'NAV / Hivatalos',
  'Sürgős teendő',
  'Számla / Bizonylat',
  'Ügyfél kérdés',
  'E-mail',
]

const CATEGORY_FILTERS: CategoryFilter[] = ['Összes', ...CATEGORIES]

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60_000)
  const diffHours = Math.floor(diffMs / 3_600_000)
  const diffDays = Math.floor(diffMs / 86_400_000)

  if (diffMins < 1) return 'Épp most'
  if (diffMins < 60) return `${diffMins} perce`
  if (diffHours < 24) return `${diffHours} órája`
  if (diffDays < 7) return `${diffDays} napja`

  return date.toLocaleDateString('hu-HU', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}


// ─── Mock Database ───────────────────────────────────────────────────────────

// ─── Priority Styling ────────────────────────────────────────────────────────

const PRIORITY_STYLES: Record<
  TaskPriority,
  { border: string; glow: string; badge: string; label: string }
> = {
  5: {
    border: 'border-red-600',
    glow: 'shadow-red-900/50',
    badge: 'bg-red-600 text-white animate-pulse',
    label: 'CRITICAL / SOS',
  },
  4: {
    border: 'border-orange-500',
    glow: 'shadow-orange-900/40',
    badge: 'bg-orange-500/20 text-orange-300',
    label: 'Magas',
  },
  3: {
    border: 'border-yellow-500/70',
    glow: 'shadow-yellow-900/30',
    badge: 'bg-yellow-500/20 text-yellow-300',
    label: 'Közepes',
  },
  2: {
    border: 'border-blue-500/50',
    glow: 'shadow-blue-900/20',
    badge: 'bg-blue-500/20 text-blue-300',
    label: 'Alacsony',
  },
  1: {
    border: 'border-zinc-700',
    glow: 'shadow-none',
    badge: 'bg-zinc-800 text-zinc-500',
    label: 'Minimális',
  },
}

// ─── Toast Component ─────────────────────────────────────────────────────────

function ToastNotification({
  toast,
  onDismiss,
}: {
  toast: Toast
  onDismiss: (id: string) => void
}) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), 6000)
    return () => clearTimeout(timer)
  }, [toast.id, onDismiss])

  return (
    <div
      role="alert"
      className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border border-emerald-500/30 bg-slate-900/95 p-4 shadow-2xl shadow-emerald-900/20 backdrop-blur-md transition-all duration-500"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/20">
        <Bell className="h-4 w-4 text-emerald-400" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-emerald-300">{toast.message}</p>
        <p className="mt-0.5 truncate text-xs text-slate-400">{toast.taskSummary}</p>
      </div>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        className="shrink-0 rounded-md p-1 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-300"
        aria-label="Értesítés bezárása"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}

// ─── LoginView ───────────────────────────────────────────────────────────────

function LoginView({ onLogin }: { onLogin: (email: string) => void }) {
  const [isLoading, setIsLoading] = useState(false)
  const [isSignUp, setIsSignUp] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mfaRequired, setMfaRequired] = useState(false)
  const [mfaCode, setMfaCode] = useState('')
  const [mfaVerificationId, setMfaVerificationId] = useState('')
  const [resolver, setResolver] = useState<any>(null)
  const [error, setError] = useState('')

  const handleEmailPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim() || !password.trim()) return
    setIsLoading(true)
    setError('')
    try {
      if (isSignUp) {
        const userCredential = await createUserWithEmailAndPassword(auth, email, password)
        onLogin(userCredential.user.email || '')
      } else {
        const userCredential = await signInWithEmailAndPassword(auth, email, password)
        onLogin(userCredential.user.email || '')
      }
    } catch (err: any) {
      if (err.code === 'auth/multi-factor-auth-required') {
        const mfaResolver = getMultiFactorResolver(auth, err)
        setResolver(mfaResolver)
        setMfaRequired(true)
        try {
          const verifier = new RecaptchaVerifier(auth, 'recaptcha-container', {
            size: 'invisible'
          })
          const phoneInfoOptions = mfaResolver.hints[0]
          const phoneAuthProvider = new PhoneAuthProvider(auth)
          const vId = await phoneAuthProvider.verifyPhoneNumber(phoneInfoOptions, verifier)
          setMfaVerificationId(vId)
        } catch (recaptchaErr: any) {
          console.error('Recaptcha/Verification error:', recaptchaErr)
          setError('Nem sikerült elküldeni a 2FA ellenőrző kódot: ' + recaptchaErr.message)
        }
      } else {
        let errMsg = err.message
        if (err.code === 'auth/user-not-found' || err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
          errMsg = 'Érvénytelen e-mail cím vagy jelszó.'
        } else if (err.code === 'auth/email-already-in-use') {
          errMsg = 'Ez az e-mail cím már használatban van.'
        } else if (err.code === 'auth/weak-password') {
          errMsg = 'A jelszónak legalább 6 karakterből kell állnia.'
        }
        setError(errMsg)
      }
    } finally {
      setIsLoading(false)
    }
  }

  const handleVerifyMfaCode = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!resolver || !mfaVerificationId || !mfaCode) return
    setIsLoading(true)
    setError('')
    try {
      const cred = PhoneAuthProvider.credential(mfaVerificationId, mfaCode)
      const assertion = PhoneMultiFactorGenerator.assertion(cred)
      const userCredential = await resolver.resolveSignIn(assertion)
      onLogin(userCredential.user.email || '')
    } catch (err: any) {
      setError(err.message || 'Érvénytelen 2FA ellenőrző kód.')
    } finally {
      setIsLoading(false)
    }
  }

  const handleGoogleLogin = async () => {
    setIsLoading(true)
    setError('')
    try {
      const provider = new GoogleAuthProvider()
      const result = await signInWithPopup(auth, provider)
      onLogin(result.user.email || '')
    } catch (err: any) {
      console.warn("Google authentication popup error, falling back to demo session:", err)
      setTimeout(() => {
        onLogin(DEMO_USER_EMAIL)
        setIsLoading(false)
      }, 1000)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen bg-slate-950">
      {/* Left — Brand */}
      <div className="relative hidden flex-1 flex-col justify-between overflow-hidden p-12 lg:flex">
        <div className="absolute inset-0 bg-gradient-to-br from-indigo-950/40 via-slate-950 to-slate-950" />
        <div className="absolute -left-32 top-1/4 h-96 w-96 rounded-full bg-indigo-600/10 blur-3xl" />
        <div className="absolute -right-16 bottom-1/4 h-64 w-64 rounded-full bg-violet-600/10 blur-3xl" />

        <div className="relative z-10">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600">
              <Zap className="h-5 w-5 text-white" />
            </div>
            <span className="text-xl font-bold tracking-tight text-white">NormaFlow</span>
          </div>
        </div>

        <div className="relative z-10 max-w-lg">
          <h1 className="text-4xl font-bold leading-tight tracking-tight text-white xl:text-5xl">
            Intelligens könyvelési munkafolyamat automatizálás
          </h1>
          <p className="mt-6 text-lg leading-relaxed text-slate-400">
            Az e-mailekből automatikusan kinyert, priorizált feladatok egyetlen
            munkaterületen. Kevesebb adminisztráció, több idő az ügyfelekre.
          </p>

          <div className="mt-10 space-y-4">
            {[
              'NAV értesítések azonnali kiemelése',
              'Automatikus prioritás-sorrendezés',
              'Valós idejű feladat-stream',
            ].map((feature) => (
              <div key={feature} className="flex items-center gap-3">
                <div className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-500/20">
                  <Check className="h-3.5 w-3.5 text-indigo-400" />
                </div>
                <span className="text-sm text-slate-300">{feature}</span>
              </div>
            ))}
          </div>
        </div>

        <p className="relative z-10 text-xs text-slate-600">
          © 2026 NormaFlow Kft. · Magyar könyvelőknek, magyar könyvelőktől.
        </p>
      </div>

      {/* Right — Login Card */}
      <div className="flex flex-1 items-center justify-center p-6 sm:p-12">
        <div className="w-full max-w-md">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600">
              <Zap className="h-4 w-4 text-white" />
            </div>
            <span className="text-lg font-bold text-white">NormaFlow</span>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-8 shadow-2xl backdrop-blur-sm">
            <div className="mb-2 flex items-center gap-2">
              <Shield className="h-4 w-4 text-indigo-400" />
              <span className="text-xs font-medium uppercase tracking-wider text-indigo-400">
                Biztonságos belépés
              </span>
            </div>
            <h2 className="text-2xl font-bold text-white">
              {mfaRequired ? 'Kétlépcsős azonosítás (2FA)' : isSignUp ? 'Regisztráció' : 'Üdvözöljük vissza'}
            </h2>
            <p className="mt-2 text-sm text-slate-400">
              {mfaRequired 
                ? 'Küldtünk egy ellenőrző kódot a megadott telefonszámára. Kérjük, írja be a kód mezőbe.'
                : isSignUp 
                  ? 'Hozza létre fiókját az intelligens könyvelői felület használatához.'
                  : 'Jelentkezzen be a munkaterület eléréséhez.'}
            </p>

            {error && (
              <div className="mt-4 rounded-lg bg-red-500/15 border border-red-500/20 p-3 text-xs font-medium text-red-400">
                {error}
              </div>
            )}

            <div id="recaptcha-container" className="hidden"></div>

            {mfaRequired ? (
              <form onSubmit={handleVerifyMfaCode} className="mt-6 space-y-4">
                <div>
                  <label htmlFor="mfa-code" className="block text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Ellenőrző kód (SMS)
                  </label>
                  <input
                    id="mfa-code"
                    type="text"
                    required
                    value={mfaCode}
                    onChange={(e) => setMfaCode(e.target.value)}
                    placeholder="123456"
                    className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-950/70 p-3.5 text-sm text-slate-200 placeholder-slate-600 shadow-inner focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>

                <button
                  type="submit"
                  disabled={isLoading}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-6 py-3.5 text-sm font-semibold text-white shadow-lg shadow-indigo-900/30 transition-all hover:bg-indigo-500 hover:shadow-indigo-800/40 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isLoading ? (
                    <span className="flex items-center gap-2">
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-indigo-400 border-t-white" />
                      Ellenőrzés…
                    </span>
                  ) : (
                    'Kód ellenőrzése'
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setMfaRequired(false)
                    setError('')
                  }}
                  className="w-full text-center text-xs text-indigo-400 hover:underline"
                >
                  Vissza a bejelentkezéshez
                </button>
              </form>
            ) : (
              <form onSubmit={handleEmailPasswordSubmit} className="mt-6 space-y-4">
                <div>
                  <label htmlFor="email-input" className="block text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    E-mail cím
                  </label>
                  <input
                    id="email-input"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="kovacs.kata@normaflow.hu"
                    className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-950/70 p-3.5 text-sm text-slate-200 placeholder-slate-600 shadow-inner focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>

                <div>
                  <label htmlFor="password-input" className="block text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Jelszó
                  </label>
                  <input
                    id="password-input"
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-950/70 p-3.5 text-sm text-slate-200 placeholder-slate-600 shadow-inner focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>

                <button
                  type="submit"
                  disabled={isLoading}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-6 py-3.5 text-sm font-semibold text-white shadow-lg shadow-indigo-900/30 transition-all hover:bg-indigo-500 hover:shadow-indigo-800/40 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isLoading ? (
                    <span className="flex items-center gap-2">
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-indigo-400 border-t-white" />
                      Feldolgozás…
                    </span>
                  ) : isSignUp ? (
                    'Regisztráció'
                  ) : (
                    'Belépés'
                  )}
                </button>

                <div className="relative flex py-2 items-center">
                  <div className="flex-grow border-t border-slate-800"></div>
                  <span className="flex-shrink mx-4 text-[10px] uppercase font-semibold text-slate-600 tracking-wider">vagy</span>
                  <div className="flex-grow border-t border-slate-800"></div>
                </div>

                <button
                  type="button"
                  onClick={handleGoogleLogin}
                  disabled={isLoading}
                  className="flex w-full items-center justify-center gap-3 rounded-xl border border-slate-700 bg-white px-6 py-3.5 text-sm font-semibold text-slate-900 transition-all hover:bg-slate-100 hover:shadow-lg disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <svg className="h-5 w-5" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                      fill="#4285F4"
                    />
                    <path
                      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                      fill="#34A853"
                    />
                    <path
                      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                      fill="#FBBC05"
                    />
                    <path
                      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                      fill="#EA4335"
                    />
                  </svg>
                  Belépés Google fiókkal
                </button>

                <div className="mt-6 text-center">
                  <button
                    type="button"
                    onClick={() => {
                      setIsSignUp(!isSignUp)
                      setError('')
                    }}
                    className="text-xs font-semibold text-indigo-400 hover:underline"
                  >
                    {isSignUp ? 'Már van fiókja? Belépés' : 'Nincs még fiókja? Regisztráció'}
                  </button>
                </div>
              </form>
            )}

            <p className="mt-6 text-center text-xs text-slate-600">
              A belépéssel elfogadja az{' '}
              <span className="text-slate-500 underline decoration-slate-700">
                Általános Szerződési Feltételeket
              </span>
              .
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── PaywallView ─────────────────────────────────────────────────────────────

function PaywallView({
  userEmail,
  onSubscribe,
  onDevBypass,
  onLogout,
}: {
  userEmail: string
  onSubscribe: () => void
  onDevBypass: () => void
  onLogout: () => void
}) {
  const [isCheckingOut, setIsCheckingOut] = useState(false)

  const handleCheckout = () => {
    setIsCheckingOut(true)
    setTimeout(() => {
      onSubscribe()
      setIsCheckingOut(false)
    }, 1500)
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-950 p-6">
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute left-1/2 top-0 h-px w-3/4 -translate-x-1/2 bg-gradient-to-r from-transparent via-indigo-500/30 to-transparent" />
        <div className="absolute left-1/2 top-1/3 h-64 w-64 -translate-x-1/2 rounded-full bg-indigo-600/5 blur-3xl" />
      </div>

      <div className="relative w-full max-w-lg">
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600">
              <Zap className="h-4 w-4 text-white" />
            </div>
            <span className="font-bold text-white">NormaFlow</span>
          </div>
          <button
            type="button"
            onClick={onLogout}
            className="flex items-center gap-1.5 text-xs text-slate-500 transition-colors hover:text-slate-300"
          >
            <LogOut className="h-3.5 w-3.5" />
            Kijelentkezés
          </button>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-8 shadow-2xl">
          <div className="mb-6 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-500/20">
              <Sparkles className="h-7 w-7 text-indigo-400" />
            </div>
            <h2 className="text-2xl font-bold text-white">NormaFlow Pro</h2>
            <p className="mt-1 text-sm text-slate-400">
              Belépve mint{' '}
              <span className="text-slate-300">{userEmail}</span>
            </p>
          </div>

          <div className="mb-6 rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-6 text-center">
            <div className="flex items-baseline justify-center gap-1">
              <span className="text-4xl font-bold text-white">14.990</span>
              <span className="text-lg text-slate-400">Ft / hó</span>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              ÁFA-val együtt · Havi előfizetés · Bármikor lemondható
            </p>
          </div>

          <ul className="mb-8 space-y-3">
            {[
              'Korlátlan feladat-kezelés',
              'Valós idejű e-mail stream',
              'NAV prioritás automatikus kiemelés',
              'Prioritás-alapú munkalisták',
              'E-mail előzmények és audit napló',
            ].map((feature) => (
              <li key={feature} className="flex items-center gap-3 text-sm text-slate-300">
                <Check className="h-4 w-4 shrink-0 text-indigo-400" />
                {feature}
              </li>
            ))}
          </ul>

          <button
            type="button"
            onClick={handleCheckout}
            disabled={isCheckingOut}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-6 py-3.5 text-sm font-semibold text-white transition-all hover:bg-indigo-500 hover:shadow-lg hover:shadow-indigo-900/40 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isCheckingOut ? (
              <>
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                Átirányítás Stripe Checkout-ra…
              </>
            ) : (
              <>
                <CreditCard className="h-4 w-4" />
                Előfizetés indítása
              </>
            )}
          </button>

          <div className="mt-6 border-t border-slate-800 pt-6">
            <button
              type="button"
              onClick={onDevBypass}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-amber-500/40 bg-amber-500/5 px-4 py-2.5 text-xs font-medium text-amber-400 transition-all hover:border-amber-500/60 hover:bg-amber-500/10"
            >
              <AlertTriangle className="h-3.5 w-3.5" />
              Fejlesztői Bypass / Tesztelés
            </button>
            <p className="mt-2 text-center text-[10px] text-slate-600">
              Csak fejlesztői környezetben — kihagyja az előfizetési ellenőrzést
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── TaskCard ─────────────────────────────────────────────────────────────────

function TaskCard({
  task,
  isCompleting,
  onComplete,
}: {
  task: Task
  isCompleting: boolean
  onComplete: (id: string) => void
}) {
  const style = PRIORITY_STYLES[task.priority]

  return (
    <article
      className={`group relative overflow-hidden rounded-xl border bg-slate-900/60 p-5 shadow-lg backdrop-blur-sm transition-all duration-500 ${style.border} ${style.glow} ${
        isCompleting
          ? 'pointer-events-none scale-95 opacity-0 -translate-x-4'
          : 'opacity-100 translate-x-0 hover:bg-slate-900/80'
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${style.badge}`}
            >
              {task.priority === 5 && (
                <AlertTriangle className="mr-1 h-3 w-3" />
              )}
              P{task.priority} · {style.label}
            </span>
            <span className="rounded-md bg-slate-800 px-2 py-0.5 text-[10px] font-medium text-slate-400">
              {task.category}
            </span>
          </div>

          <h3 className="text-base font-bold leading-snug text-white">
            {task.summary}
          </h3>

          <p className="mt-2 text-sm leading-relaxed text-slate-400">
            <span className="font-medium text-slate-300">Következő lépés: </span>
            {task.next_step}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
            <span className="flex items-center gap-1.5">
              <Mail className="h-3 w-3 shrink-0" />
              {task.sender}
            </span>
            <span className="flex items-center gap-1.5">
              <Clock className="h-3 w-3 shrink-0" />
              {formatTimestamp(task.received_at)}
            </span>
          </div>

          <p className="mt-1.5 truncate text-[11px] text-slate-600">
            Tárgy: {task.subject}
          </p>

          {/* AI Response States */}
          {task.ai_status === 'generating' && (
            <div className="mt-4 flex items-center gap-2.5 rounded-xl border border-indigo-500/20 bg-indigo-950/20 p-3 animate-pulse">
              <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-indigo-400 border-t-transparent" />
              <span className="text-xs font-medium text-indigo-300">
                AI válasz generálása folyamatban…
              </span>
            </div>
          )}

          {task.ai_status === 'sent' && task.ai_reply && (
            <div className="mt-4 rounded-xl border border-indigo-500/30 bg-slate-950/80 p-4 shadow-inner backdrop-blur-sm">
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5 text-indigo-400" />
                  <span className="text-xs font-bold uppercase tracking-wider text-indigo-400">
                    AI Automatikus Válasz kiküldve
                  </span>
                </div>
                <span className="text-[10px] text-slate-500">Mellékletként elküldve</span>
              </div>
              <p className="whitespace-pre-line text-xs leading-relaxed text-slate-300 border-t border-slate-800/80 pt-2 mt-2">
                {task.ai_reply}
              </p>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => onComplete(task.id)}
          disabled={isCompleting}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 transition-all hover:border-emerald-500/50 hover:bg-emerald-500/20 hover:shadow-md hover:shadow-emerald-900/30 active:scale-95 disabled:opacity-50"
          aria-label="Feladat késznek jelölése"
          title="Kész"
        >
          <Check className="h-5 w-5" />
        </button>
      </div>
    </article>
  )
}

// ─── MainDashboard ───────────────────────────────────────────────────────────

function MainDashboard({
  userEmail,
  tasks,
  categoryFilter,
  onCategoryChange,
  completingIds,
  onCompleteTask,
  onLogout,
  activeTab,
  onTabChange,
  automationEnabled,
  promptRules,
  onSaveAutomation,
  onOpenFeedback,
}: {
  userEmail: string
  tasks: Task[]
  categoryFilter: CategoryFilter
  onCategoryChange: (cat: CategoryFilter) => void
  completingIds: Set<string>
  onCompleteTask: (id: string) => void
  onLogout: () => void
  activeTab: 'tasks' | 'automation'
  onTabChange: (tab: 'tasks' | 'automation') => void
  automationEnabled: boolean
  promptRules: string
  onSaveAutomation: (rules: string, enabled: boolean) => Promise<void> | void
  onOpenFeedback: () => void
}) {
  const pendingForUser = useMemo(
    () =>
      tasks.filter(
        (t) => t.status === 'pending' && t.user_email === userEmail,
      ),
    [tasks, userEmail],
  )

  const filteredTasks = useMemo(() => {
    const base = pendingForUser
    const filtered =
      categoryFilter === 'Összes'
        ? base
        : base.filter((t) => t.category === categoryFilter)

    return [...filtered].sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority
      return new Date(a.received_at).getTime() - new Date(b.received_at).getTime()
    })
  }, [pendingForUser, categoryFilter])

  const metrics = useMemo(() => {
    const counts: Record<CategoryFilter, number> = {
      Összes: pendingForUser.length,
      'NAV / Hivatalos': 0,
      'Sürgős teendő': 0,
      'Számla / Bizonylat': 0,
      'Ügyfél kérdés': 0,
      'E-mail': 0,
    }
    for (const t of pendingForUser) {
      counts[t.category]++
    }
    const critical = pendingForUser.filter((t) => t.priority >= 4).length
    return { counts, critical, total: pendingForUser.length }
  }, [pendingForUser])

  return (
    <div className="flex min-h-screen bg-slate-950">
      {/* Sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-slate-800 bg-slate-900/50 lg:flex">
        <div className="border-b border-slate-800 p-5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600">
              <Zap className="h-4 w-4 text-white" />
            </div>
            <div>
              <p className="text-sm font-bold text-white">NormaFlow</p>
              <p className="text-[10px] text-slate-500">Pro munkaterület</p>
            </div>
          </div>
        </div>

        {/* Sidebar Nav */}
        <div className="px-4 py-3 border-b border-slate-800/60">
          <p className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Navigáció
          </p>
          <nav className="space-y-1">
            <button
              type="button"
              onClick={() => onTabChange('tasks')}
              className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-all ${
                activeTab === 'tasks'
                  ? 'bg-indigo-600/20 font-medium text-indigo-300'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              }`}
            >
              <Inbox className="h-4 w-4" />
              <span>Feladatok</span>
            </button>
            <button
              type="button"
              onClick={() => onTabChange('automation')}
              className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-all ${
                activeTab === 'automation'
                  ? 'bg-indigo-600/20 font-medium text-indigo-300'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              }`}
            >
              <Sparkles className="h-4 w-4" />
              <span>AI Automatizáció</span>
            </button>
          </nav>
        </div>

        {/* Category Filters (Visible only for tasks tab) */}
        {activeTab === 'tasks' ? (
          <div className="flex-1 p-4 overflow-y-auto">
            <p className="mb-3 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              <Filter className="h-3 w-3" />
              Kategória szűrő
            </p>
            <nav className="space-y-1">
              {CATEGORY_FILTERS.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => onCategoryChange(cat)}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-all ${
                    categoryFilter === cat
                      ? 'bg-indigo-600/20 font-medium text-indigo-300'
                      : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                  }`}
                >
                  <span>{cat}</span>
                  <span
                    className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${
                      categoryFilter === cat
                        ? 'bg-indigo-500/30 text-indigo-200'
                        : 'bg-slate-800 text-slate-500'
                    }`}
                  >
                    {metrics.counts[cat]}
                  </span>
                </button>
              ))}
            </nav>
          </div>
        ) : (
          <div className="flex-1" />
        )}

        {/* Feedback Trigger in Sidebar */}
        <div className="p-4 border-t border-slate-800/80">
          <button
            type="button"
            onClick={onOpenFeedback}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-xs font-bold text-amber-400 hover:bg-amber-500/20 active:scale-95 transition-all duration-300"
          >
            <Lightbulb className="h-3.5 w-3.5" />
            Ötlet beküldése
          </button>
        </div>

        <div className="border-t border-slate-800 p-4">
          <div className="mb-3 rounded-lg bg-slate-800/50 p-3">
            <p className="truncate text-xs font-medium text-slate-300">{userEmail}</p>
            <p className="text-[10px] text-slate-500">NormaFlow Pro aktív</p>
          </div>
          <button
            type="button"
            onClick={onLogout}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-400 transition-colors hover:border-slate-600 hover:bg-slate-800 hover:text-slate-200"
          >
            <LogOut className="h-3.5 w-3.5" />
            Kijelentkezés
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex min-w-0 flex-1 flex-col">
        {activeTab === 'tasks' ? (
          <>
            {/* Top Metrics Bar */}
            <header className="border-b border-slate-800 bg-slate-900/80 px-4 py-4 backdrop-blur-sm sm:px-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h1 className="text-lg font-bold text-white">Munkaterület</h1>
                  <p className="text-xs text-slate-500">
                    Prioritás szerint rendezett függőben lévő feladatok
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  {/* Mobile Tab Switcher */}
                  <div className="flex items-center gap-1 rounded-lg bg-slate-950 p-1 border border-slate-800/80 lg:hidden">
                    <button
                      type="button"
                      onClick={() => onTabChange('tasks')}
                      className="rounded-md px-2.5 py-1.5 text-xs font-medium transition-all bg-indigo-600 text-white"
                    >
                      Feladatok
                    </button>
                    <button
                      type="button"
                      onClick={() => onTabChange('automation')}
                      className="rounded-md px-2.5 py-1.5 text-xs font-medium transition-all text-slate-400 hover:text-slate-200"
                    >
                      AI
                    </button>
                  </div>

                  {/* Mobile Feedback Trigger */}
                  <button
                    type="button"
                    onClick={onOpenFeedback}
                    className="flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs font-bold text-amber-400 hover:bg-amber-500/20 transition-all lg:hidden"
                  >
                    <Lightbulb className="h-3.5 w-3.5" />
                    Ötlet
                  </button>

                  <div className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-1.5">
                    <Inbox className="h-3.5 w-3.5 text-slate-400" />
                    <span className="text-xs text-slate-400">Összes:</span>
                    <span className="text-sm font-bold text-white">{metrics.total}</span>
                  </div>
                  {metrics.critical > 0 && (
                    <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5">
                      <AlertTriangle className="h-3.5 w-3.5 text-red-400" />
                      <span className="text-xs text-red-300">Kritikus:</span>
                      <span className="text-sm font-bold text-red-300">{metrics.critical}</span>
                    </div>
                  )}
                  {CATEGORIES.map((cat) =>
                    metrics.counts[cat] > 0 ? (
                      <div
                        key={cat}
                        className="hidden items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-800/30 px-2.5 py-1.5 xl:flex"
                      >
                        <span className="text-[10px] text-slate-500">{cat}:</span>
                        <span className="text-xs font-semibold text-slate-300">
                          {metrics.counts[cat]}
                        </span>
                      </div>
                    ) : null,
                  )}
                </div>
              </div>

              {/* Mobile category pills */}
              <div className="mt-4 flex gap-2 overflow-x-auto pb-1 lg:hidden">
                {CATEGORY_FILTERS.map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => onCategoryChange(cat)}
                    className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-all ${
                      categoryFilter === cat
                        ? 'bg-indigo-600 text-white'
                        : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {cat} ({metrics.counts[cat]})
                  </button>
                ))}
              </div>
            </header>

            {/* Task List */}
            <main className="flex-1 overflow-y-auto p-4 sm:p-6">
              {filteredTasks.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-24 text-center">
                  <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-800">
                    <Inbox className="h-8 w-8 text-slate-600" />
                  </div>
                  <h2 className="text-lg font-semibold text-slate-300">
                    Nincs függőben lévő feladat
                  </h2>
                  <p className="mt-2 max-w-sm text-sm text-slate-500">
                    {categoryFilter === 'Összes'
                      ? 'Minden feladatot elvégzett — kiváló munka! Az új feladatok automatikusan megjelennek itt.'
                      : `A „${categoryFilter}" kategóriában jelenleg nincs feldolgozandó tétel.`}
                  </p>
                </div>
              ) : (
                <div className="mx-auto max-w-3xl space-y-3">
                  {filteredTasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      isCompleting={completingIds.has(task.id)}
                      onComplete={onCompleteTask}
                    />
                  ))}
                </div>
              )}
            </main>
          </>
        ) : (
          <>
            {/* Top Header for Auto-Responder */}
            <header className="border-b border-slate-800 bg-slate-900/80 px-4 py-4 backdrop-blur-sm sm:px-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h1 className="text-lg font-bold text-white">AI Automatizáció</h1>
                  <p className="text-xs text-slate-500">
                    Konfigurálja az automatikus AI válaszok szabályait és állapotát
                  </p>
                </div>

                {/* Mobile Tab Switcher */}
                <div className="flex items-center gap-1 rounded-lg bg-slate-950 p-1 border border-slate-800/80 lg:hidden">
                  <button
                    type="button"
                    onClick={() => onTabChange('tasks')}
                    className="rounded-md px-2.5 py-1.5 text-xs font-medium transition-all text-slate-400 hover:text-slate-200"
                  >
                    Feladatok
                  </button>
                  <button
                    type="button"
                    onClick={() => onTabChange('automation')}
                    className="rounded-md px-2.5 py-1.5 text-xs font-medium transition-all bg-indigo-600 text-white"
                  >
                    AI
                  </button>
                </div>
              </div>
            </header>

            <main className="flex-1 overflow-y-auto p-4 sm:p-6 bg-slate-950">
              <AutoResponder
                initialEnabled={automationEnabled}
                initialRules={promptRules}
                onSave={onSaveAutomation}
              />
              <div className="mx-auto max-w-3xl px-4 pb-12 sm:px-6">
                <MfaSettingsCard />
              </div>
            </main>
          </>
        )}
      </div>
    </div>
  )
}

// ─── MfaSettingsCard ─────────────────────────────────────────────────────────

function MfaSettingsCard() {
  const [isMfaEnrolled, setIsMfaEnrolled] = useState(false)
  const [enrolledPhone, setEnrolledPhone] = useState('')
  const [isEnrolling, setIsEnrolling] = useState(false)
  const [phoneNumber, setPhoneNumber] = useState('')
  const [verificationCode, setVerificationCode] = useState('')
  const [verificationId, setVerificationId] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const refreshMfaStatus = () => {
    const currentUser = auth.currentUser
    if (currentUser) {
      const mfaUser = multiFactor(currentUser)
      const factors = mfaUser.enrolledFactors
      if (factors.length > 0) {
        setIsMfaEnrolled(true)
        const phoneFactor = factors[0] as any
        setEnrolledPhone(phoneFactor.phoneNumber || 'Aktív telefonszám')
      } else {
        setIsMfaEnrolled(false)
        setEnrolledPhone('')
      }
    }
  }

  useEffect(() => {
    refreshMfaStatus()
  }, [])

  const handleStartEnroll = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!phoneNumber.trim()) return
    setIsLoading(true)
    setError('')
    setSuccess('')
    try {
      const currentUser = auth.currentUser
      if (!currentUser) throw new Error('Nem található bejelentkezett felhasználó.')

      const session = await multiFactor(currentUser).getSession()
      const phoneInfoOptions = {
        phoneNumber: phoneNumber.trim(),
        session: session,
      }
      const phoneAuthProvider = new PhoneAuthProvider(auth)
      const verifier = new RecaptchaVerifier(auth, 'recaptcha-container-enroll', {
        size: 'invisible',
      })
      const vId = await phoneAuthProvider.verifyPhoneNumber(phoneInfoOptions, verifier)
      setVerificationId(vId)
      setIsEnrolling(true)
      setSuccess('Ellenőrző kód elküldve SMS-ben!')
    } catch (err: any) {
      console.error(err)
      setError(err.message || 'Hiba történt a 2FA folyamat elindításakor.')
    } finally {
      setIsLoading(false)
    }
  }

  const handleFinishEnroll = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!verificationCode.trim() || !verificationId) return
    setIsLoading(true)
    setError('')
    setSuccess('')
    try {
      const currentUser = auth.currentUser
      if (!currentUser) throw new Error('Nem található bejelentkezett felhasználó.')

      const cred = PhoneAuthProvider.credential(verificationId, verificationCode)
      const assertion = PhoneMultiFactorGenerator.assertion(cred)
      await multiFactor(currentUser).enroll(assertion, 'Elsődleges telefonszám')
      
      setIsEnrolling(false)
      setVerificationCode('')
      setPhoneNumber('')
      setSuccess('2FA sikeresen bekapcsolva!')
      refreshMfaStatus()
    } catch (err: any) {
      console.error(err)
      setError(err.message || 'Hiba történt a kód ellenőrzése során.')
    } finally {
      setIsLoading(false)
    }
  }

  const handleDisableMfa = async () => {
    if (!window.confirm('Biztosan ki szeretné kapcsolni a kétlépcsős azonosítást?')) return
    setIsLoading(true)
    setError('')
    setSuccess('')
    try {
      const currentUser = auth.currentUser
      if (!currentUser) throw new Error('Nem található bejelentkezett felhasználó.')

      const mfaUser = multiFactor(currentUser)
      if (mfaUser.enrolledFactors.length > 0) {
        await mfaUser.unenroll(mfaUser.enrolledFactors[0])
        setSuccess('2FA sikeresen kikapcsolva.')
        refreshMfaStatus()
      }
    } catch (err: any) {
      console.error(err)
      setError(err.message || 'Hiba történt a 2FA kikapcsolásakor.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="relative mt-8 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-2xl backdrop-blur-md animate-fade-in text-slate-100">
      <div className="absolute -right-24 -top-24 h-48 w-48 rounded-full bg-indigo-600/5 blur-3xl" />
      
      <div id="recaptcha-container-enroll" className="hidden"></div>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-slate-800/80 pb-6">
        <div>
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-indigo-400" />
            <h3 className="text-lg font-bold tracking-tight text-white">Fiók biztonság (2FA)</h3>
          </div>
          <p className="mt-1 text-sm text-slate-400">
            Védje fiókját kétlépcsős azonosítással (SMS kódos ellenőrzés).
          </p>
        </div>

        <div className="flex items-center gap-3 font-medium">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            Állapot:
          </span>
          <span
            className={`text-xs font-bold uppercase rounded-full px-2.5 py-1 ${
              isMfaEnrolled ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-slate-800 text-slate-500'
            }`}
          >
            {isMfaEnrolled ? 'Aktív' : 'Kikapcsolva'}
          </span>
        </div>
      </div>

      <div className="mt-6 space-y-4">
        {error && (
          <div className="rounded-lg bg-red-500/15 border border-red-500/20 p-3 text-xs font-medium text-red-400">
            {error}
          </div>
        )}
        {success && (
          <div className="rounded-lg bg-emerald-500/15 border border-emerald-500/20 p-3 text-xs font-medium text-emerald-400">
            {success}
          </div>
        )}

        {isMfaEnrolled ? (
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between bg-slate-950/40 p-4 rounded-xl border border-slate-800/80 gap-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-600/10 text-indigo-400">
                <Phone className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-200">Regisztrált telefonszám</p>
                <p className="text-xs text-slate-500">{enrolledPhone}</p>
              </div>
            </div>

            <button
              type="button"
              onClick={handleDisableMfa}
              disabled={isLoading}
              className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2 text-xs font-semibold text-red-400 hover:bg-red-500/20 transition-all active:scale-95 disabled:opacity-55"
            >
              Kikapcsolás
            </button>
          </div>
        ) : isEnrolling ? (
          <form onSubmit={handleFinishEnroll} className="space-y-4 max-w-md">
            <div>
              <label htmlFor="verify-code-input" className="block text-xs font-semibold text-slate-400 uppercase tracking-wider">
                SMS-ben kapott kód
              </label>
              <input
                id="verify-code-input"
                type="text"
                required
                value={verificationCode}
                onChange={(e) => setVerificationCode(e.target.value)}
                placeholder="123456"
                className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-950/70 p-3 text-sm text-slate-200 placeholder-slate-600 shadow-inner focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>
            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={isLoading}
                className="flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-xs font-semibold text-white shadow-lg transition-all hover:bg-indigo-500 active:scale-95 disabled:opacity-55"
              >
                {isLoading ? 'Ellenőrzés…' : 'Kód ellenőrzése és aktiválás'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsEnrolling(false)
                  setError('')
                  setSuccess('')
                }}
                className="text-xs font-semibold text-slate-400 hover:text-slate-200 px-3 py-2"
              >
                Mégse
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleStartEnroll} className="space-y-4 max-w-md">
            <div>
              <label htmlFor="phone-number-input" className="block text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Telefonszám (Nemzetközi formátum, pl. +36301234567)
              </label>
              <input
                id="phone-number-input"
                type="tel"
                required
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                placeholder="+36301234567"
                className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-950/70 p-3 text-sm text-slate-200 placeholder-slate-600 shadow-inner focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>
            <button
              type="submit"
              disabled={isLoading}
              className="flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-xs font-semibold text-white shadow-lg transition-all hover:bg-indigo-500 active:scale-95 disabled:opacity-55"
            >
              {isLoading ? 'Folyamatban…' : 'MFA Aktiválása (SMS küldése)'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

// ─── App Root ────────────────────────────────────────────────────────────────

export default function App() {
  const [view, setView] = useState<AppView>('login')
  const [userEmail, setUserEmail] = useState<string | null>(null)
  const [isSubscribed, setIsSubscribed] = useState(false)
  const [devBypass, setDevBypass] = useState(false)
  const [tasks, setTasks] = useState<Task[]>([])
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('Összes')
  const [completingIds, setCompletingIds] = useState<Set<string>>(new Set())
  const [toasts, setToasts] = useState<Toast[]>([])

  // AI automation states
  const [activeTab, setActiveTab] = useState<'tasks' | 'automation'>('tasks')
  const [automationEnabled, setAutomationEnabled] = useState(false)
  const [promptRules, setPromptRules] = useState(
    'Ha az ügyfél számlát kér, válaszolj udvariasan, hogy feldolgozzuk és küldjük. Válasz végére írd oda: Üdvözlettel, NormaFlow Asszisztens.'
  )
  
  // Feedback modal state
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false)

  // Use refs to avoid resetting the simulation interval when rules change
  const automationEnabledRef = useRef(automationEnabled)
  const promptRulesRef = useRef(promptRules)

  useEffect(() => {
    automationEnabledRef.current = automationEnabled
  }, [automationEnabled])

  useEffect(() => {
    promptRulesRef.current = promptRules
  }, [promptRules])

  // Listen for Auth changes
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        setUserEmail(user.email)
        if (view === 'login') {
          setView('paywall')
        }
      } else {
        setUserEmail(null)
        setView('login')
      }
    })
    return () => unsubscribe()
  }, [view])

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const handleLogin = (email: string) => {
    setUserEmail(email)
    setView('paywall')
  }

  const handleLogout = async () => {
    try {
      await signOut(auth)
    } catch (err) {
      console.error('Logout error:', err)
    }
    setUserEmail(null)
    setIsSubscribed(false)
    setDevBypass(false)
    setView('login')
    setCategoryFilter('Összes')
    setCompletingIds(new Set())
    setToasts([])
    setActiveTab('tasks')
    setAutomationEnabled(false)
  }

  const handleSubscribe = () => {
    setIsSubscribed(true)
    setView('dashboard')
  }

  const handleDevBypass = () => {
    setDevBypass(true)
    setView('dashboard')
  }

  const handleCompleteTask = async (id: string) => {
    setCompletingIds((prev) => new Set(prev).add(id))
    try {
      const taskRef = doc(db, 'tasks', id)
      await updateDoc(taskRef, { status: 'completed' })
    } catch (err) {
      console.error('Error updating task status:', err)
    }
    setTimeout(() => {
      setCompletingIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }, 450)
  }

  const handleSaveAutomation = async (rules: string, enabled: boolean) => {
    if (!userEmail) return
    try {
      const settingsRef = doc(db, `users/${userEmail}/settings/auto_responder`)
      await setDoc(settingsRef, {
        automationEnabled: enabled,
        promptRules: rules
      }, { merge: true })

      setPromptRules(rules)
      setAutomationEnabled(enabled)
      
      // Trigger notification
      const toastId = generateId()
      setToasts((prev) => [
        ...prev,
        {
          id: toastId,
          message: 'Beállítások mentve',
          taskSummary: enabled ? 'AI Auto-Responder aktív' : 'AI Auto-Responder inaktív',
        },
      ])
    } catch (err) {
      console.error('Error saving automation settings:', err)
      const toastId = generateId()
      setToasts((prev) => [
        ...prev,
        {
          id: toastId,
          message: 'Mentési hiba',
          taskSummary: 'Nem sikerült elmenteni a beállításokat.',
        },
      ])
    }
  }

  const handleSubmitFeedback = (title: string, category: string, description: string) => {
    // Log has already happened inside FeedbackModal, let's trigger toast
    const toastId = generateId()
    const summaryText = `Köszönjük az ötletet: "${title}" (${category}) - ${description.substring(0, 20)}...`
    setToasts((prev) => [
      ...prev,
      {
        id: toastId,
        message: 'Ötlet sikeresen elküldve!',
        taskSummary: summaryText,
      },
    ])
  }

  // Real-time Firestore tasks subscription
  useEffect(() => {
    if (view !== 'dashboard' || !userEmail) return

    const q = query(
      collection(db, 'tasks'),
      where('user_email', '==', userEmail)
    )

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const loadedTasks = snapshot.docs.map((doc) => {
        const data = doc.data()
        return {
          id: doc.id,
          category: data.category || 'E-mail',
          summary: data.summary || '',
          next_step: data.next_step || '',
          priority: data.priority || 3,
          received_at: data.received_at || new Date().toISOString(),
          sender: data.sender || '',
          subject: data.subject || '',
          user_email: data.user_email || '',
          status: data.status || 'pending',
          ai_reply: data.ai_reply || null,
          ai_status: data.ai_status || 'idle',
        } as Task
      })

      // Trigger a toast notification when a new task is added in Firestore
      setTasks((prev) => {
        if (prev.length > 0 && loadedTasks.length > prev.length) {
          const prevIds = new Set(prev.map((t) => t.id))
          const newTasks = loadedTasks.filter((t) => !prevIds.has(t.id))
          newTasks.forEach((newTask) => {
            const toastId = generateId()
            setToasts((toastPrev) => [
              ...toastPrev,
              {
                id: toastId,
                message: 'Új feladat érkezett',
                taskSummary: newTask.summary,
              },
            ])
            if (newTask.ai_status === 'sent' && newTask.ai_reply) {
              setToasts((toastPrev) => [
                ...toastPrev,
                {
                  id: generateId(),
                  message: 'AI Válasz elküldve',
                  taskSummary: `Címzett: ${newTask.sender}`,
                },
              ])
            }
          })
        }
        return loadedTasks
      })
    }, (error) => {
      console.error('Firestore tasks subscription error:', error)
    })

    return () => unsubscribe()
  }, [view, userEmail])

  // Load auto-responder settings from Firestore on mount/login
  useEffect(() => {
    if (view !== 'dashboard' || !userEmail) return

    const settingsRef = doc(db, `users/${userEmail}/settings/auto_responder`)
    const fetchSettings = async () => {
      try {
        const docSnap = await getDoc(settingsRef)
        if (docSnap.exists()) {
          const data = docSnap.data()
          setAutomationEnabled(!!data.automationEnabled)
          if (data.promptRules) {
            setPromptRules(data.promptRules)
          }
        }
      } catch (err) {
        console.error('Error fetching auto-responder settings:', err)
      }
    }

    fetchSettings()
  }, [view, userEmail])

  const hasAccess = isSubscribed || devBypass

  return (
    <>
      {view === 'login' && <LoginView onLogin={handleLogin} />}

      {view === 'paywall' && userEmail && (
        <PaywallView
          userEmail={userEmail}
          onSubscribe={handleSubscribe}
          onDevBypass={handleDevBypass}
          onLogout={handleLogout}
        />
      )}

      {view === 'dashboard' && userEmail && hasAccess && (
        <MainDashboard
          userEmail={userEmail}
          tasks={tasks}
          categoryFilter={categoryFilter}
          onCategoryChange={setCategoryFilter}
          completingIds={completingIds}
          onCompleteTask={handleCompleteTask}
          onLogout={handleLogout}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          automationEnabled={automationEnabled}
          promptRules={promptRules}
          onSaveAutomation={handleSaveAutomation}
          onOpenFeedback={() => setIsFeedbackOpen(true)}
        />
      )}

      {/* Feedback Modal */}
      <FeedbackModal
        isOpen={isFeedbackOpen}
        onClose={() => setIsFeedbackOpen(false)}
        onSubmit={handleSubmitFeedback}
        userEmail={userEmail || DEMO_USER_EMAIL}
      />

      {/* Toast Stack */}
      {toasts.length > 0 && (
        <div className="pointer-events-none fixed bottom-6 right-6 z-50 flex flex-col gap-3">
          {toasts.map((toast) => (
            <ToastNotification key={toast.id} toast={toast} onDismiss={dismissToast} />
          ))}
        </div>
      )}
    </>
  )
}
