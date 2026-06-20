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
  ShieldAlert,
  Trash2,
  Plus,
} from 'lucide-react'

// Import components and types
import type { Task, TaskCategory, TaskPriority } from './types/task'
import AutoResponder from './components/dashboard/AutoResponder'
import FeedbackModal from './components/dashboard/FeedbackModal'
import { db, auth } from './firebase'
import { collection, query, where, onSnapshot, doc, setDoc, getDoc, addDoc, deleteDoc, runTransaction } from 'firebase/firestore'
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
} from 'firebase/auth'

// ─── Types ───────────────────────────────────────────────────────────────────

type CategoryFilter = TaskCategory | 'Összes'

type SubscriptionTier = 'basic' | 'pro' | 'ultra'

interface Toast {
  id: string
  message: string
  taskSummary: string
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TIER_LIMITS: Record<SubscriptionTier, number> = {
  basic: 500,
  pro: 1500,
  ultra: 5000,
}

const PRICING_PLANS: {
  tier: SubscriptionTier
  name: string
  price: string
  emails: number
  features: string[]
  highlighted?: boolean
}[] = [
  {
    tier: 'basic',
    name: 'Basic',
    price: '9.990',
    emails: 500,
    features: ['500 e-mail / hó', 'AI feladat összegzés', 'Prioritás-sorrendezés', '30 napos kuka'],
  },
  {
    tier: 'pro',
    name: 'Pro',
    price: '19.990',
    emails: 1500,
    features: ['1500 e-mail / hó', 'AI auto-választervezet', 'Ügyfél fehérlista', 'Prioritás riasztások'],
    highlighted: true,
  },
  {
    tier: 'ultra',
    name: 'Ultra',
    price: '39.990',
    emails: 5000,
    features: ['5000 e-mail / hó', 'Teljes automatizáció', 'Dedikált támogatás', 'Audit napló'],
  },
]

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

async function ensureUserDocument(email: string): Promise<void> {
  const userRef = doc(db, 'users', email)
  const snap = await getDoc(userRef)
  if (!snap.exists()) {
    await setDoc(userRef, {
      email,
      subscriptionStatus: 'none',
      tier: 'basic',
      processedEmailsThisMonth: 0,
      createdAt: new Date().toISOString(),
    })
  }
}

// ─── LoginView ───────────────────────────────────────────────────────────────

function LoginView({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [isLoading, setIsLoading] = useState(false)
  const [isSignUp, setIsSignUp] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  const completeSignIn = async (signedInEmail: string) => {
    await ensureUserDocument(signedInEmail)
    onAuthenticated()
  }

  const handleEmailPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim() || !password.trim()) return
    setIsLoading(true)
    setError('')
    try {
      if (isSignUp) {
        const userCredential = await createUserWithEmailAndPassword(auth, email, password)
        await ensureUserDocument(userCredential.user.email || email)
        onAuthenticated()
      } else {
        const userCredential = await signInWithEmailAndPassword(auth, email, password)
        await completeSignIn(userCredential.user.email || email)
      }
    } catch (err: any) {
      let errMsg = err.message
      if (err.code === 'auth/user-not-found' || err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
        errMsg = 'Érvénytelen e-mail cím vagy jelszó.'
      } else if (err.code === 'auth/email-already-in-use') {
        errMsg = 'Ez az e-mail cím már használatban van.'
      } else if (err.code === 'auth/weak-password') {
        errMsg = 'A jelszónak legalább 6 karakterből kell állnia.'
      }
      setError(errMsg)
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
      await ensureUserDocument(result.user.email || '')
      onAuthenticated()
    } catch (err: any) {
      if (err.code === 'auth/popup-closed-by-user') {
        setError('A Google bejelentkezés megszakítva.')
      } else {
        setError(err.message || 'Google bejelentkezés sikertelen.')
      }
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
              {isSignUp ? 'Regisztráció' : 'Üdvözöljük vissza'}
            </h2>
            <p className="mt-2 text-sm text-slate-400">
              {isSignUp
                ? 'Hozza létre fiókját az intelligens könyvelői felület használatához.'
                : 'Jelentkezzen be a munkaterület eléréséhez.'}
            </p>

            {error && (
              <div className="mt-4 rounded-lg bg-red-500/15 border border-red-500/20 p-3 text-xs font-medium text-red-400">
                {error}
              </div>
            )}

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
  onSelectTier,
  onLogout,
}: {
  userEmail: string
  onSelectTier: (tier: SubscriptionTier) => Promise<void>
  onLogout: () => void
}) {
  const [checkingOutTier, setCheckingOutTier] = useState<SubscriptionTier | null>(null)
  const [error, setError] = useState('')

  const handleSelectPlan = async (tier: SubscriptionTier) => {
    setCheckingOutTier(tier)
    setError('')
    try {
      await onSelectTier(tier)
    } catch (err: any) {
      setError(err.message || 'Nem sikerült aktiválni az előfizetést.')
    } finally {
      setCheckingOutTier(null)
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-950 p-6">
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute left-1/2 top-0 h-px w-3/4 -translate-x-1/2 bg-gradient-to-r from-transparent via-indigo-500/30 to-transparent" />
        <div className="absolute left-1/2 top-1/3 h-64 w-64 -translate-x-1/2 rounded-full bg-indigo-600/5 blur-3xl" />
      </div>

      <div className="relative w-full max-w-5xl">
        <div className="mb-8 flex items-center justify-between">
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

        <div className="mb-10 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-500/20">
            <Sparkles className="h-7 w-7 text-indigo-400" />
          </div>
          <h2 className="text-3xl font-bold text-white">Válasszon csomagot</h2>
          <p className="mt-2 text-sm text-slate-400">
            Belépve mint <span className="text-slate-300">{userEmail}</span>
          </p>
          <p className="mt-3 text-sm text-slate-500">
            Az alkalmazás használatához aktív előfizetés szükséges.
          </p>
        </div>

        {error && (
          <div className="mb-6 rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-center text-sm text-red-400">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          {PRICING_PLANS.map((plan) => (
            <div
              key={plan.tier}
              className={`relative flex flex-col rounded-2xl border p-6 shadow-xl transition-all ${
                plan.highlighted
                  ? 'border-indigo-500/50 bg-gradient-to-b from-indigo-950/40 to-slate-900 ring-1 ring-indigo-500/30'
                  : 'border-slate-800 bg-slate-900/80'
              }`}
            >
              {plan.highlighted && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-indigo-600 px-3 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
                  Népszerű
                </span>
              )}
              <h3 className="text-xl font-bold text-white">{plan.name}</h3>
              <div className="mt-3 flex items-baseline gap-1">
                <span className="text-3xl font-bold text-white">{plan.price}</span>
                <span className="text-sm text-slate-400">Ft / hó</span>
              </div>
              <p className="mt-2 text-sm font-medium text-indigo-300">
                {plan.emails.toLocaleString('hu-HU')} e-mail / hó
              </p>

              <ul className="mt-6 flex-1 space-y-3">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2.5 text-sm text-slate-300">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-indigo-400" />
                    {feature}
                  </li>
                ))}
              </ul>

              <button
                type="button"
                onClick={() => handleSelectPlan(plan.tier)}
                disabled={checkingOutTier !== null}
                className={`mt-6 flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-60 ${
                  plan.highlighted
                    ? 'bg-indigo-600 text-white hover:bg-indigo-500 shadow-lg shadow-indigo-900/40'
                    : 'border border-slate-700 bg-slate-950 text-slate-200 hover:border-indigo-500/50 hover:bg-slate-900'
                }`}
              >
                {checkingOutTier === plan.tier ? (
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    Aktiválás…
                  </>
                ) : (
                  <>
                    <CreditCard className="h-4 w-4" />
                    {plan.name} csomag választása
                  </>
                )}
              </button>
            </div>
          ))}
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
  onWriteReply,
  onRestoreTask,
}: {
  task: Task
  isCompleting: boolean
  onComplete: (id: string) => void
  onWriteReply: (task: Task) => void
  onRestoreTask: (id: string) => void
}) {
  const [isExpanded, setIsExpanded] = useState(false)
  const style = PRIORITY_STYLES[task.priority]

  const getDaysRemaining = (archivedAtStr?: string): number => {
    if (!archivedAtStr) return 30
    const archivedDate = new Date(archivedAtStr)
    const expirationDate = new Date(archivedDate.getTime() + 30 * 24 * 60 * 60 * 1000)
    const today = new Date()
    const diffTime = expirationDate.getTime() - today.getTime()
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24))
    return Math.max(0, Math.min(30, diffDays))
  }

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
            {task.status === 'archived' && (
              <span className="inline-flex items-center rounded-md bg-rose-500/10 border border-rose-500/20 px-2 py-0.5 text-[10px] font-medium text-rose-400">
                {getDaysRemaining(task.archivedAt)} nap maradt a törlésig
              </span>
            )}
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

          {/* Accordion Expand Trigger */}
          <div className="mt-4 border-t border-slate-800/50 pt-3">
            <button
              type="button"
              onClick={() => setIsExpanded(!isExpanded)}
              className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-400 hover:text-indigo-300 transition-colors focus:outline-none"
            >
              <span>{isExpanded ? 'Részletek elrejtése' : 'Részletek megtekintése'}</span>
              <svg
                className={`h-4 w-4 transform transition-transform duration-200 ${isExpanded ? 'rotate-180' : 'rotate-0'}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          </div>
        </div>

        {task.status === 'archived' ? (
          <button
            type="button"
            onClick={() => onRestoreTask(task.id)}
            className="flex h-9 shrink-0 items-center justify-center rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-3 text-xs font-semibold text-indigo-300 transition-all hover:border-indigo-500/50 hover:bg-indigo-500/20 active:scale-95"
            aria-label="Feladat visszaállítása"
            title="Visszaállítás"
          >
            Visszaállítás
          </button>
        ) : (
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
        )}
      </div>

      {/* Accordion Collapsible Panel */}
      <div
        className={`transition-all duration-300 ease-in-out overflow-hidden ${
          isExpanded ? 'max-h-[800px] opacity-100 mt-4 border-t border-slate-800 pt-4' : 'max-h-0 opacity-0'
        }`}
      >
        <div className="space-y-4">
          {/* AI Summary */}
          {task.ai_summary ? (
            <div>
              <h4 className="text-[10px] font-bold uppercase tracking-wider text-indigo-400 mb-1">AI Feladat Összegzés</h4>
              <p className="text-xs text-slate-300 bg-slate-950/50 p-3 rounded-lg border border-slate-800/80 whitespace-pre-line leading-relaxed">
                {task.ai_summary}
              </p>
            </div>
          ) : (
            <div>
              <h4 className="text-[10px] font-bold uppercase tracking-wider text-indigo-400 mb-1">AI Feladat Összegzés</h4>
              <p className="text-xs text-slate-500 italic bg-slate-950/30 p-3 rounded-lg border border-slate-800/30">
                Nincs AI összegzés ehhez a feladathoz.
              </p>
            </div>
          )}

          {/* Original Message Text Content */}
          {task.textContent ? (
            <div>
              <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Eredeti Üzenet</h4>
              <pre className="max-h-48 overflow-y-auto text-[11px] text-slate-400 bg-slate-950/70 p-3 rounded-lg border border-slate-800/80 whitespace-pre-wrap font-mono leading-normal shadow-inner">
                {task.textContent}
              </pre>
            </div>
          ) : (
            <div>
              <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Eredeti Üzenet</h4>
              <p className="text-xs text-slate-500 italic bg-slate-950/30 p-3 rounded-lg border border-slate-800/30">
                Nincs elérhető eredeti üzenetszöveg.
              </p>
            </div>
          )}

          {/* Action Area: Write Reply & Complete or Restore */}
          <div className="flex justify-end gap-2.5 pt-2 border-t border-slate-800/40">
            {task.status === 'archived' ? (
              <button
                type="button"
                onClick={() => onRestoreTask(task.id)}
                className="inline-flex items-center gap-1.5 rounded-xl border border-indigo-500/30 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-300 font-semibold text-xs px-4 py-2 transition-all active:scale-95"
              >
                <span>Visszaállítás</span>
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => onComplete(task.id)}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 font-semibold text-xs px-4 py-2 transition-all active:scale-95"
                >
                  <Check className="h-3.5 w-3.5" />
                  <span>Feladat Elvégzése</span>
                </button>
                <button
                  type="button"
                  onClick={() => onWriteReply(task)}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs px-4 py-2 shadow-lg transition-all active:scale-95 hover:shadow-indigo-500/20"
                >
                  <Mail className="h-3.5 w-3.5" />
                  <span>Válasz írása</span>
                </button>
              </>
            )}
          </div>
        </div>
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
  processedEmailsThisMonth,
  tier,
  enforceWhitelist,
  onToggleWhitelist,
  onWriteReply,
  onRestoreTask,
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
  processedEmailsThisMonth: number
  tier: string
  enforceWhitelist: boolean
  onToggleWhitelist: (checked: boolean) => void
  onWriteReply: (task: Task) => void
  onRestoreTask: (id: string) => void
}) {
  const limit = TIER_LIMITS[tier as SubscriptionTier] ?? TIER_LIMITS.basic
  const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1)

  const [taskStatusFilter, setTaskStatusFilter] = useState<'active' | 'archived'>('active')
  const [searchQuery, setSearchQuery] = useState('')

  const tasksForUser = useMemo(
    () =>
      tasks.filter(
        (t) => t.user_email === userEmail,
      ),
    [tasks, userEmail],
  )

  const pendingForUser = useMemo(
    () =>
      tasksForUser.filter((t) => t.status === 'active'),
    [tasksForUser],
  )

  const filteredTasks = useMemo(() => {
    let base = tasksForUser.filter((t) => t.status === taskStatusFilter)

    if (categoryFilter !== 'Összes') {
      base = base.filter((t) => t.category === categoryFilter)
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      base = base.filter((t) => 
        (t.sender && t.sender.toLowerCase().includes(q)) ||
        (t.subject && t.subject.toLowerCase().includes(q)) ||
        (t.textContent && t.textContent.toLowerCase().includes(q)) ||
        (t.summary && t.summary.toLowerCase().includes(q)) ||
        (t.ai_summary && t.ai_summary.toLowerCase().includes(q))
      )
    }

    return [...base].sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority
      return new Date(a.received_at).getTime() - new Date(b.received_at).getTime()
    })
  }, [tasksForUser, taskStatusFilter, categoryFilter, searchQuery])

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

        {/* Utilization Bar */}
        <div className="px-4 py-4 border-b border-slate-800/60">
          <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">
            <span>Havi keret: {processedEmailsThisMonth} / {limit} ({tierLabel})</span>
            <span>{Math.min(100, Math.round((processedEmailsThisMonth / limit) * 100))}%</span>
          </div>
          <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                processedEmailsThisMonth >= limit ? 'bg-rose-500 shadow-lg shadow-rose-500/20' : 'bg-indigo-500 shadow-lg shadow-indigo-500/20'
              }`}
              style={{ width: `${Math.min(100, (processedEmailsThisMonth / limit) * 100)}%` }}
            />
          </div>
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
                  {/* Global Search Input */}
                  <div className="relative w-64">
                    <input
                      type="text"
                      placeholder="Keresés (feladó, tárgy, tartalom)..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full rounded-xl border border-slate-700 bg-slate-950/70 pl-9 pr-4 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 shadow-inner"
                    />
                    <svg
                      className="absolute left-3 top-2.5 h-3.5 w-3.5 text-slate-500"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                      />
                    </svg>
                  </div>
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

            {/* Secondary navigation for Active / Archived */}
            <div className="border-b border-slate-800 bg-slate-900/30 px-4 py-2 sm:px-6 flex items-center justify-between gap-4">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setTaskStatusFilter('active')}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
                    taskStatusFilter === 'active'
                      ? 'bg-indigo-600/15 text-indigo-300 border border-indigo-500/30'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/30'
                  }`}
                >
                  Aktív Feladatok
                </button>
                <button
                  type="button"
                  onClick={() => setTaskStatusFilter('archived')}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-all flex items-center gap-1.5 ${
                    taskStatusFilter === 'archived'
                      ? 'bg-indigo-600/15 text-indigo-300 border border-indigo-500/30'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/30'
                  }`}
                >
                  <Trash2 className="h-3.5 w-3.5 text-indigo-400" />
                  <span>Kuka</span>
                </button>
              </div>

              <div className="text-[10px] text-slate-500 font-medium hidden sm:block">
                {taskStatusFilter === 'archived'
                  ? 'A Kukában lévő elemek 30 nap után automatikusan törlődnek.'
                  : 'Feldolgozásra váró e-mailek prioritási sorrendben.'}
              </div>
            </div>

            {/* Task List */}
            <main className="flex-1 overflow-y-auto p-4 sm:p-6">
              {processedEmailsThisMonth >= limit && (
                <div className="mx-auto max-w-3xl mb-6 rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 flex gap-3 shadow-lg shadow-rose-950/20">
                  <AlertTriangle className="h-5 w-5 shrink-0 text-rose-400 mt-0.5" />
                  <div className="text-sm text-slate-300">
                    <span className="font-bold text-rose-300 block mb-1">
                      Elérte a havi limitet
                    </span>
                    <p className="leading-relaxed text-xs">
                      Elérte a csomagjában foglalt havi e-mail limitet. Az automatizáció szünetel. Váltson Pro vagy Ultra csomagra.
                    </p>
                  </div>
                </div>
              )}

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
                      onWriteReply={onWriteReply}
                      onRestoreTask={onRestoreTask}
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
                initialEnabled={automationEnabled && processedEmailsThisMonth < limit}
                initialRules={promptRules}
                onSave={onSaveAutomation}
                limitExceeded={processedEmailsThisMonth >= limit}
              />
              <div className="mx-auto max-w-3xl px-4 pb-12 sm:px-6 space-y-6">
                <WhitelistSettingsCard
                  userEmail={userEmail}
                  enforceWhitelist={enforceWhitelist}
                  onToggleWhitelist={onToggleWhitelist}
                />
                <EmailConfigCard userEmail={userEmail} />
              </div>
            </main>
          </>
        )}
      </div>
    </div>
  )
}

// ─── WhitelistSettingsCard ──────────────────────────────────────────────────

interface ClientRecord {
  id: string
  email: string
}

function WhitelistSettingsCard({
  userEmail,
  enforceWhitelist,
  onToggleWhitelist,
}: {
  userEmail: string
  enforceWhitelist: boolean
  onToggleWhitelist: (checked: boolean) => void
}) {
  const [clients, setClients] = useState<ClientRecord[]>([])
  const [newEmail, setNewEmail] = useState('')
  const [isAdding, setIsAdding] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!userEmail) return
    const clientsRef = collection(db, `users/${userEmail}/clients`)
    const unsubscribe = onSnapshot(clientsRef, (snap) => {
      const loaded: ClientRecord[] = []
      snap.forEach((doc) => {
        loaded.push({ id: doc.id, email: doc.data().email || '' })
      })
      // Sort alphabetically by email
      loaded.sort((a, b) => a.email.localeCompare(b.email))
      setClients(loaded)
    }, (err) => {
      console.error('Error fetching clients whitelist:', err)
    })
    return () => unsubscribe()
  }, [userEmail])

  const handleAddClient = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    const trimmed = newEmail.trim().toLowerCase()
    if (!trimmed) return
    if (!trimmed.includes('@')) {
      setError('Kérjük, érvényes e-mail címet adjon meg.')
      return
    }
    if (clients.some((c) => c.email.toLowerCase() === trimmed)) {
      setError('Ez az ügyfél már szerepel a fehérlistán.')
      return
    }

    setIsAdding(true)
    try {
      const clientsRef = collection(db, `users/${userEmail}/clients`)
      await addDoc(clientsRef, { email: trimmed })
      setNewEmail('')
    } catch (err) {
      console.error('Error adding client to whitelist:', err)
      setError('Nem sikerült hozzáadni az ügyfelet.')
    } finally {
      setIsAdding(false)
    }
  }

  const handleDeleteClient = async (id: string) => {
    try {
      const clientDocRef = doc(db, `users/${userEmail}/clients`, id)
      await deleteDoc(clientDocRef)
    } catch (err) {
      console.error('Error deleting client from whitelist:', err)
    }
  }

  return (
    <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-2xl backdrop-blur-md animate-fade-in text-slate-100">
      <div className="absolute -left-24 -top-24 h-48 w-48 rounded-full bg-violet-600/5 blur-3xl" />

      {/* Header & Toggle */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-slate-800/80 pb-6">
        <div>
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-indigo-400" />
            <h3 className="text-lg font-bold tracking-tight text-white">Ügyfél Ellenőrzés és Fehérlista</h3>
          </div>
          <p className="mt-1 text-sm text-slate-400">
            Szabályozza, hogy az AI auto-responder csak regisztrált ügyfeleknek válaszoljon-e.
          </p>
        </div>

        {/* Toggle Switch */}
        <div className="flex items-center gap-3">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            Szigorú fehérlista:
          </span>
          <button
            type="button"
            onClick={() => onToggleWhitelist(!enforceWhitelist)}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-slate-900 ${
              enforceWhitelist ? 'bg-indigo-600' : 'bg-slate-700'
            }`}
            aria-checked={enforceWhitelist}
            role="switch"
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                enforceWhitelist ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
          <span
            className={`text-xs font-bold uppercase ${
              enforceWhitelist ? 'text-indigo-400' : 'text-slate-500'
            }`}
          >
            {enforceWhitelist ? 'AKTÍV' : 'INAKTÍV'}
          </span>
        </div>
      </div>

      {/* Description Info Banner */}
      <div className="mt-4 rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-4 flex gap-3">
        <Mail className="h-5 w-5 shrink-0 text-indigo-400 mt-0.5" />
        <div className="text-xs text-slate-300 leading-relaxed">
          {enforceWhitelist ? (
            <p>
              <strong>Szigorú fehérlista aktív:</strong> Az AI csak akkor küld automatikus választervezetet, ha a feladó e-mail címe szerepel az alábbi listában. Bárki más által küldött levelet a rendszer feldolgozás nélkül átugrik.
            </p>
          ) : (
            <p>
              <strong>Fehérlista ellenőrzés kikapcsolva:</strong> Minden beérkező e-mailt feldolgoz az AI auto-responder, függetlenül attól, hogy a feladó szerepel-e a listában (kivéve a nyilvánvaló spam/hírlevél címeket).
            </p>
          )}
        </div>
      </div>

      {/* Customer Management Form */}
      <div className="mt-6">
        <h4 className="text-sm font-semibold text-slate-200 mb-3">Engedélyezett Ügyfelek Kezelése</h4>
        <form onSubmit={handleAddClient} className="flex gap-2">
          <input
            type="email"
            placeholder="ugyfel@cegnev.hu"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            disabled={isAdding}
            className="flex-1 rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-2 text-sm text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
          <button
            type="submit"
            disabled={isAdding || !newEmail.trim()}
            className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-lg transition-all hover:bg-indigo-500 active:scale-95 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            <span>Hozzáadás</span>
          </button>
        </form>
        {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}
      </div>

      {/* Clients List */}
      <div className="mt-4">
        <div className="max-h-60 overflow-y-auto rounded-xl border border-slate-800 bg-slate-950/40">
          {clients.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500">
              Nincsenek ügyfelek a fehérlistán.
            </div>
          ) : (
            <table className="w-full text-left text-xs text-slate-300">
              <thead>
                <tr className="border-b border-slate-800/80 bg-slate-900/30 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-2.5">E-mail cím</th>
                  <th className="px-4 py-2.5 text-right">Művelet</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {clients.map((client) => (
                  <tr key={client.id} className="hover:bg-slate-900/20">
                    <td className="px-4 py-2.5 font-medium">{client.email}</td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => handleDeleteClient(client.id)}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-slate-500 hover:bg-rose-500/10 hover:text-rose-400 transition-all"
                        title="Ügyfél törlése"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── EmailConfigCard ─────────────────────────────────────────────────────────

type EmailProvider = 'google' | 'outlook' | 'custom'

function EmailConfigCard({ userEmail }: { userEmail: string }) {
  const [provider, setProvider] = useState<EmailProvider>('google')
  const [configEmail, setConfigEmail] = useState('')
  const [configPassword, setConfigPassword] = useState('')
  const [imapHost, setImapHost] = useState('')
  const [imapPort, setImapPort] = useState('993')
  const [smtpHost, setSmtpHost] = useState('')
  const [smtpPort, setSmtpPort] = useState('587')
  const [isLoading, setIsLoading] = useState(false)
  const [isSyncing, setIsSyncing] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [isConnected, setIsConnected] = useState(false)
  const [connectedProvider, setConnectedProvider] = useState<EmailProvider | null>(null)

  // Load existing config on mount
  useEffect(() => {
    const loadConfig = async () => {
      try {
        const configRef = doc(db, `users/${userEmail}/tokens/email_config`)
        const snap = await getDoc(configRef)
        if (snap.exists()) {
          const data = snap.data()
          setProvider(data.provider || 'google')
          setConfigEmail(data.email || '')
          setImapHost(data.imapHost || '')
          setImapPort(String(data.imapPort || 993))
          setSmtpHost(data.smtpHost || '')
          setSmtpPort(String(data.smtpPort || 587))
          setIsConnected(true)
          setConnectedProvider(data.provider || 'google')
        }
      } catch (err) {
        console.error('Error loading email config:', err)
      }
    }
    loadConfig()
  }, [userEmail])

  // Pre-fill servers when provider changes
  const handleProviderChange = (p: EmailProvider) => {
    setProvider(p)
    setError('')
    setSuccess('')
    if (p === 'outlook') {
      setImapHost('imap-mail.outlook.com')
      setImapPort('993')
      setSmtpHost('smtp-mail.outlook.com')
      setSmtpPort('587')
    } else if (p === 'custom') {
      setImapHost('')
      setImapPort('993')
      setSmtpHost('')
      setSmtpPort('587')
    }
  }

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    setError('')
    setSuccess('')
    try {
      const payload: Record<string, any> = {
        provider,
        email: provider === 'google' ? userEmail : configEmail.trim(),
        connected_at: new Date().toISOString(),
      }
      if (provider !== 'google') {
        payload.password = configPassword
        payload.imapHost = imapHost.trim()
        payload.imapPort = parseInt(imapPort) || 993
        payload.smtpHost = smtpHost.trim()
        payload.smtpPort = parseInt(smtpPort) || 587
      }
      const configRef = doc(db, `users/${userEmail}/tokens/email_config`)
      await setDoc(configRef, payload, { merge: true })
      setIsConnected(true)
      setConnectedProvider(provider)
      setSuccess('E-mail fiók sikeresen összekapcsolva!')
    } catch (err: any) {
      setError(err.message || 'Hiba történt a konfiguráció mentése során.')
    } finally {
      setIsLoading(false)
    }
  }

  const handleManualSync = async () => {
    setIsSyncing(true)
    setError('')
    setSuccess('')
    try {
      const token = await auth.currentUser?.getIdToken(true)
      const res = await fetch('https://syncemailsnow-cdaanjspxq-uc.a.run.app', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token || ''}`,
        },
        body: JSON.stringify({}),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Szinkronizálási hiba.')
      setSuccess(data.message || 'Szinkronizálás kész.')
    } catch (err: any) {
      setError(err.message || 'Hiba a levelek szinkronizálásakor.')
    } finally {
      setIsSyncing(false)
    }
  }

  const PROVIDERS: { key: EmailProvider; label: string; desc: string }[] = [
    { key: 'google', label: 'Google', desc: 'Gmail webhook' },
    { key: 'outlook', label: 'Outlook', desc: 'Office 365 IMAP' },
    { key: 'custom', label: 'Egyéni', desc: 'IMAP / SMTP' },
  ]

  return (
    <div className="relative mt-8 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-2xl backdrop-blur-md animate-fade-in text-slate-100">
      <div className="absolute -left-24 -top-24 h-48 w-48 rounded-full bg-violet-600/5 blur-3xl" />

      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-slate-800/80 pb-6">
        <div>
          <div className="flex items-center gap-2">
            <Mail className="h-5 w-5 text-indigo-400" />
            <h3 className="text-lg font-bold tracking-tight text-white">Email Fiók Összekötése</h3>
          </div>
          <p className="mt-1 text-sm text-slate-400">
            Válasszon szolgáltatót a beérkező levelek automatikus feldolgozásához.
          </p>
        </div>

        {isConnected && connectedProvider && (
          <span className="text-xs font-bold uppercase rounded-full px-2.5 py-1 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            {connectedProvider === 'google' ? 'Google' : connectedProvider === 'outlook' ? 'Outlook' : 'Egyéni'} aktív
          </span>
        )}
      </div>

      <div className="mt-6 space-y-5">
        {error && (
          <div className="rounded-lg bg-red-500/15 border border-red-500/20 p-3 text-xs font-medium text-red-400">{error}</div>
        )}
        {success && (
          <div className="rounded-lg bg-emerald-500/15 border border-emerald-500/20 p-3 text-xs font-medium text-emerald-400">{success}</div>
        )}

        {/* Provider Selector */}
        <div className="flex gap-2">
          {PROVIDERS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => handleProviderChange(p.key)}
              className={`flex-1 rounded-xl border p-3 text-center transition-all ${
                provider === p.key
                  ? 'border-indigo-500/50 bg-indigo-500/10 text-white'
                  : 'border-slate-800 bg-slate-950/40 text-slate-400 hover:border-slate-700 hover:text-slate-300'
              }`}
            >
              <div className="text-sm font-semibold">{p.label}</div>
              <div className="text-[10px] mt-0.5 opacity-70">{p.desc}</div>
            </button>
          ))}
        </div>

        {/* Google Info */}
        {provider === 'google' && (
          <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
            <p className="text-sm text-slate-300">
              A Google integráció a meglévő webhook pipeline-on keresztül működik.
              Konfigurálás nem szükséges — a rendszer automatikusan fogadja a továbbított e-maileket.
            </p>
            <button
              type="button"
              onClick={handleSaveConfig}
              disabled={isLoading}
              className="mt-4 flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-xs font-semibold text-white shadow-lg transition-all hover:bg-indigo-500 active:scale-95 disabled:opacity-55"
            >
              {isLoading ? 'Mentés…' : 'Google konfiguráció mentése'}
            </button>
          </div>
        )}

        {/* Outlook / Custom Form */}
        {provider !== 'google' && (
          <form onSubmit={handleSaveConfig} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="cfg-email" className="block text-xs font-semibold text-slate-400 uppercase tracking-wider">E-mail cím</label>
                <input
                  id="cfg-email"
                  type="email"
                  required
                  value={configEmail}
                  onChange={(e) => setConfigEmail(e.target.value)}
                  placeholder="user@company.hu"
                  className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-950/70 p-3 text-sm text-slate-200 placeholder-slate-600 shadow-inner focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>
              <div>
                <label htmlFor="cfg-pass" className="block text-xs font-semibold text-slate-400 uppercase tracking-wider">Alkalmazás jelszó</label>
                <input
                  id="cfg-pass"
                  type="password"
                  required
                  value={configPassword}
                  onChange={(e) => setConfigPassword(e.target.value)}
                  placeholder="••••••••"
                  className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-950/70 p-3 text-sm text-slate-200 placeholder-slate-600 shadow-inner focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="cfg-imap-host" className="block text-xs font-semibold text-slate-400 uppercase tracking-wider">IMAP szerver</label>
                <input
                  id="cfg-imap-host"
                  type="text"
                  required
                  value={imapHost}
                  onChange={(e) => setImapHost(e.target.value)}
                  placeholder="imap.company.hu"
                  className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-950/70 p-3 text-sm text-slate-200 placeholder-slate-600 shadow-inner focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>
              <div>
                <label htmlFor="cfg-imap-port" className="block text-xs font-semibold text-slate-400 uppercase tracking-wider">IMAP port</label>
                <input
                  id="cfg-imap-port"
                  type="number"
                  required
                  value={imapPort}
                  onChange={(e) => setImapPort(e.target.value)}
                  className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-950/70 p-3 text-sm text-slate-200 placeholder-slate-600 shadow-inner focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="cfg-smtp-host" className="block text-xs font-semibold text-slate-400 uppercase tracking-wider">SMTP szerver</label>
                <input
                  id="cfg-smtp-host"
                  type="text"
                  required
                  value={smtpHost}
                  onChange={(e) => setSmtpHost(e.target.value)}
                  placeholder="smtp.company.hu"
                  className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-950/70 p-3 text-sm text-slate-200 placeholder-slate-600 shadow-inner focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>
              <div>
                <label htmlFor="cfg-smtp-port" className="block text-xs font-semibold text-slate-400 uppercase tracking-wider">SMTP port</label>
                <input
                  id="cfg-smtp-port"
                  type="number"
                  required
                  value={smtpPort}
                  onChange={(e) => setSmtpPort(e.target.value)}
                  className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-950/70 p-3 text-sm text-slate-200 placeholder-slate-600 shadow-inner focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-xs font-semibold text-white shadow-lg transition-all hover:bg-indigo-500 active:scale-95 disabled:opacity-55"
            >
              {isLoading ? 'Mentés…' : 'Konfiguráció mentése'}
            </button>
          </form>
        )}

        {/* Manual Sync Button */}
        {isConnected && connectedProvider && connectedProvider !== 'google' && (
          <div className="border-t border-slate-800/80 pt-5">
            <button
              type="button"
              onClick={handleManualSync}
              disabled={isSyncing}
              className="flex items-center gap-2 rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-5 py-2.5 text-xs font-semibold text-indigo-400 hover:bg-indigo-500/20 transition-all active:scale-95 disabled:opacity-55"
            >
              {isSyncing ? (
                <>
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-indigo-400/30 border-t-indigo-400" />
                  Szinkronizálás…
                </>
              ) : (
                <>
                  <Mail className="h-3.5 w-3.5" />
                  Levelek szinkronizálása
                </>
              )}
            </button>
            <p className="mt-1.5 text-[10px] text-slate-600">
              Az automatikus szinkronizáció 5 percenként fut a háttérben.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}



// ─── App Root ────────────────────────────────────────────────────────────────

export default function App() {
  const [authReady, setAuthReady] = useState(false)
  const [userEmail, setUserEmail] = useState<string | null>(null)
  const [subscriptionStatus, setSubscriptionStatus] = useState<string>('none')
  const [processedEmailsThisMonth, setProcessedEmailsThisMonth] = useState<number>(0)
  const [tier, setTier] = useState<string>('basic')
  const [tasks, setTasks] = useState<Task[]>([])
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('Összes')
  const [completingIds, setCompletingIds] = useState<Set<string>>(new Set())
  const [toasts, setToasts] = useState<Toast[]>([])

  const hasAccess = subscriptionStatus === 'active'
  const needsPaywall = subscriptionStatus === 'none' || subscriptionStatus === 'pending'

  // AI automation states
  const [activeTab, setActiveTab] = useState<'tasks' | 'automation'>('tasks')
  const [automationEnabled, setAutomationEnabled] = useState(false)
  const [promptRules, setPromptRules] = useState(
    'Ha az ügyfél számlát kér, válaszolj udvariasan, hogy feldolgozzuk és küldjük. Válasz végére írd oda: Üdvözlettel, NormaFlow Asszisztens.'
  )
  const [enforceWhitelist, setEnforceWhitelist] = useState(true)
  
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false)

  // Manual Reply states & actions
  const [replyTask, setReplyTask] = useState<Task | null>(null)
  const [replyRecipient, setReplyRecipient] = useState('')
  const [replySubject, setReplySubject] = useState('')
  const [replyBody, setReplyBody] = useState('')
  const [isImprovingDraft, setIsImprovingDraft] = useState(false)
  const [isSendingReply, setIsSendingReply] = useState(false)

  const handleWriteReply = (task: Task) => {
    setReplyTask(task)
    setReplyRecipient(task.sender)
    setReplySubject(task.subject.startsWith('Re:') ? task.subject : `Re: ${task.subject}`)
    setReplyBody(task.ai_reply || '')
  }

  const handleImproveDraft = async () => {
    if (!replyBody.trim()) return
    setIsImprovingDraft(true)
    try {
      const user = auth.currentUser
      if (!user) throw new Error('Nem bejelentkezett felhasználó')
      const token = await user.getIdToken()

      const response = await fetch('https://improveemaildraft-cdaanjspxq-uc.a.run.app', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ text: replyBody }),
      })

      if (!response.ok) {
        throw new Error('Hiba történt a feljavítás során')
      }

      const data = await response.json()
      if (data.text) {
        setReplyBody(data.text)
        const toastId = generateId()
        setToasts((prev) => [
          ...prev,
          {
            id: toastId,
            message: 'AI Válasz feljavítva!',
            taskSummary: 'A piszkozat sikeresen finomítva lett.',
          },
        ])
      }
    } catch (err: any) {
      console.error(err)
      alert('Nem sikerült feljavítani a piszkozatot: ' + err.message)
    } finally {
      setIsImprovingDraft(false)
    }
  }

  const handleSendManualReply = async () => {
    if (!replyTask) return
    if (!replyRecipient.trim() || !replySubject.trim() || !replyBody.trim()) {
      alert('Minden mezőt ki kell tölteni a küldéshez.')
      return
    }
    setIsSendingReply(true)
    try {
      const user = auth.currentUser
      if (!user) throw new Error('Nem bejelentkezett felhasználó')
      const token = await user.getIdToken()

      const response = await fetch('https://sendmanualemail-cdaanjspxq-uc.a.run.app', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          taskId: replyTask.id,
          recipient: replyRecipient,
          subject: replySubject,
          body: replyBody,
        }),
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.message || 'Sikertelen e-mail küldés.')
      }

      setReplyTask(null)

      const toastId = generateId()
      setToasts((prev) => [
        ...prev,
        {
          id: toastId,
          message: 'E-mail elküldve',
          taskSummary: `Sikeres válasz a következőnek: ${replyRecipient}`,
        },
      ])
    } catch (err: any) {
      console.error(err)
      alert('Hiba az e-mail küldése során: ' + err.message)
    } finally {
      setIsSendingReply(false)
    }
  }

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
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        setUserEmail(user.email)
      } else {
        setUserEmail(null)
      }
      setAuthReady(true)
    })
    return () => unsubscribe()
  }, [])

  // Listen for user subscriptionStatus in Firestore in real time
  useEffect(() => {
    if (!userEmail) {
      setSubscriptionStatus('none')
      return
    }

    const userRef = doc(db, 'users', userEmail)
    const unsubscribe = onSnapshot(userRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data()
        setSubscriptionStatus(data?.subscriptionStatus ?? 'none')
        setProcessedEmailsThisMonth(data?.processedEmailsThisMonth ?? 0)
        setTier(data?.tier ?? 'basic')
      } else {
        setSubscriptionStatus('none')
        setProcessedEmailsThisMonth(0)
        setTier('basic')
      }
    }, (error) => {
      console.error('Error fetching subscription status:', error)
      setSubscriptionStatus('none')
      setProcessedEmailsThisMonth(0)
      setTier('basic')
    })

    return () => unsubscribe()
  }, [userEmail])

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const handleLogout = async () => {
    try {
      await signOut(auth)
    } catch (err) {
      console.error('Logout error:', err)
    }
    setUserEmail(null)
    setSubscriptionStatus('none')
    setCategoryFilter('Összes')
    setCompletingIds(new Set())
    setToasts([])
    setActiveTab('tasks')
    setAutomationEnabled(false)
  }

  const handleSelectTier = async (selectedTier: SubscriptionTier) => {
    if (!userEmail) return
    const userRef = doc(db, 'users', userEmail)
    await runTransaction(db, async (transaction) => {
      const snap = await transaction.get(userRef)
      if (!snap.exists()) {
        transaction.set(userRef, {
          email: userEmail,
          subscriptionStatus: 'active',
          tier: selectedTier,
          processedEmailsThisMonth: 0,
          createdAt: new Date().toISOString(),
        })
      } else {
        transaction.update(userRef, {
          subscriptionStatus: 'active',
          tier: selectedTier,
        })
      }
    })
  }

  const handleCompleteTask = async (id: string) => {
    setCompletingIds((prev) => new Set(prev).add(id))
    try {
      const user = auth.currentUser
      if (!user) throw new Error('Nem bejelentkezett felhasználó')
      const token = await user.getIdToken()

      const response = await fetch('https://archivetask-cdaanjspxq-uc.a.run.app', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ taskId: id }),
      })

      if (!response.ok) {
        throw new Error('Sikertelen feladat archiválás.')
      }

      // Trigger notification
      const toastId = generateId()
      setToasts((prev) => [
        ...prev,
        {
          id: toastId,
          message: 'Feladat archiválva',
          taskSummary: 'A feladat átkerült a Kukába.',
        },
      ])
    } catch (err: any) {
      console.error('Error archiving task:', err)
      alert('Hiba az archiválás során: ' + err.message)
    }
    setTimeout(() => {
      setCompletingIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }, 450)
  }

  const handleRestoreTask = async (id: string) => {
    try {
      const user = auth.currentUser
      if (!user) throw new Error('Nem bejelentkezett felhasználó')
      const token = await user.getIdToken()

      const response = await fetch('https://restoretask-cdaanjspxq-uc.a.run.app', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ taskId: id }),
      })

      if (!response.ok) {
        throw new Error('Sikertelen feladat visszaállítás.')
      }

      // Trigger notification
      const toastId = generateId()
      setToasts((prev) => [
        ...prev,
        {
          id: toastId,
          message: 'Feladat visszaállítva',
          taskSummary: 'A feladat sikeresen visszakerült az aktív táblára.',
        },
      ])
    } catch (err: any) {
      console.error('Error restoring task:', err)
      alert('Hiba a visszaállítás során: ' + err.message)
    }
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

  const handleToggleWhitelist = async (checked: boolean) => {
    if (!userEmail) return
    try {
      const settingsRef = doc(db, `users/${userEmail}/settings/auto_responder`)
      await setDoc(settingsRef, {
        enforceWhitelist: checked
      }, { merge: true })

      setEnforceWhitelist(checked)

      // Trigger notification
      const toastId = generateId()
      setToasts((prev) => [
        ...prev,
        {
          id: toastId,
          message: 'Fehérlista módosítva',
          taskSummary: checked ? 'Szigorú fehérlista aktív' : 'Bárki küldhet e-mailt',
        },
      ])
    } catch (err) {
      console.error('Error updating enforceWhitelist:', err)
      const toastId = generateId()
      setToasts((prev) => [
        ...prev,
        {
          id: toastId,
          message: 'Mentési hiba',
          taskSummary: 'Nem sikerült elmenteni a fehérlista beállítást.',
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
    if (!hasAccess || !userEmail) return

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
          status: data.status === 'pending' ? 'active' : (data.status || 'active'),
          ai_reply: data.ai_reply || null,
          ai_status: data.ai_status || 'idle',
          ai_summary: data.ai_summary || '',
          textContent: data.textContent || '',
          archivedAt: data.archivedAt ? (typeof data.archivedAt.toDate === 'function' ? data.archivedAt.toDate().toISOString() : data.archivedAt) : null,
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
  }, [hasAccess, userEmail])

  // Load auto-responder settings from Firestore on mount/login
  useEffect(() => {
    if (!hasAccess || !userEmail) return

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
          setEnforceWhitelist(data.enforceWhitelist !== false)
        }
      } catch (err) {
        console.error('Error fetching auto-responder settings:', err)
      }
    }

    fetchSettings()
  }, [hasAccess, userEmail])

  return (
    <>
      {!authReady && (
        <div className="flex min-h-screen items-center justify-center bg-slate-950">
          <span className="h-8 w-8 animate-spin rounded-full border-2 border-indigo-400 border-t-transparent" />
        </div>
      )}

      {authReady && !userEmail && (
        <LoginView onAuthenticated={() => {}} />
      )}

      {authReady && userEmail && needsPaywall && (
        <PaywallView
          userEmail={userEmail}
          onSelectTier={handleSelectTier}
          onLogout={handleLogout}
        />
      )}

      {authReady && userEmail && hasAccess && (
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
          processedEmailsThisMonth={processedEmailsThisMonth}
          tier={tier}
          enforceWhitelist={enforceWhitelist}
          onToggleWhitelist={handleToggleWhitelist}
          onWriteReply={handleWriteReply}
          onRestoreTask={handleRestoreTask}
        />
      )}

      {/* Feedback Modal */}
      <FeedbackModal
        isOpen={isFeedbackOpen}
        onClose={() => setIsFeedbackOpen(false)}
        onSubmit={handleSubmitFeedback}
        userEmail={userEmail || ''}
      />

      {/* Manual Reply Modal */}
      {replyTask && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-2xl overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/90 shadow-2xl backdrop-blur-md transition-all duration-300">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
              <div className="flex items-center gap-2">
                <Mail className="h-5 w-5 text-indigo-400" />
                <h3 className="text-base font-bold text-white">Manuális válasz küldése</h3>
              </div>
              <button
                type="button"
                onClick={() => setReplyTask(null)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="space-y-4 p-6">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">Címzett</label>
                <input
                  type="email"
                  value={replyRecipient}
                  onChange={(e) => setReplyRecipient(e.target.value)}
                  className="mt-1.5 w-full rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-sm text-slate-200 shadow-inner focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  placeholder="ugyfel@ceg.hu"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">Tárgy</label>
                <input
                  type="text"
                  value={replySubject}
                  onChange={(e) => setReplySubject(e.target.value)}
                  className="mt-1.5 w-full rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-sm text-slate-200 shadow-inner focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  placeholder="Válasz"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">Válaszüzenet</label>
                  
                  <button
                    type="button"
                    onClick={handleImproveDraft}
                    disabled={isImprovingDraft || !replyBody.trim()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-500/30 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-300 font-semibold text-xs px-2.5 py-1.5 shadow transition-all active:scale-95 disabled:opacity-50 disabled:pointer-events-none"
                  >
                    {isImprovingDraft ? (
                      <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-indigo-400 border-t-transparent" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5 text-indigo-400 animate-pulse" />
                    )}
                    <span>AI Válasz Feljavítása</span>
                  </button>
                </div>
                
                <textarea
                  value={replyBody}
                  onChange={(e) => setReplyBody(e.target.value)}
                  rows={8}
                  className="w-full rounded-xl border border-slate-800 bg-slate-950/50 p-4 text-sm text-slate-200 shadow-inner focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-none leading-relaxed"
                  placeholder="Írja ide a válaszát..."
                />
              </div>
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-end gap-3 border-t border-slate-800 px-6 py-4 bg-slate-950/40">
              <button
                type="button"
                onClick={() => setReplyTask(null)}
                disabled={isSendingReply}
                className="rounded-xl border border-slate-800 bg-slate-900/60 hover:bg-slate-800 px-5 py-2.5 text-xs font-semibold text-slate-300 transition-all active:scale-95 disabled:opacity-50"
              >
                Mégse
              </button>
              
              <button
                type="button"
                onClick={handleSendManualReply}
                disabled={isSendingReply || !replyBody.trim() || !replyRecipient.trim() || !replySubject.trim()}
                className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs px-5 py-2.5 shadow-lg transition-all active:scale-95 disabled:opacity-50"
              >
                {isSendingReply ? (
                  <>
                    <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    <span>Küldés folyamatban…</span>
                  </>
                ) : (
                  <>
                    <Check className="h-4 w-4" />
                    <span>Küldés</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

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
