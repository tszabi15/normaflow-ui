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
} from 'lucide-react'

// Import components and types
import type { Task, TaskCategory, TaskPriority } from './types/task'
import AutoResponder from './components/dashboard/AutoResponder'
import FeedbackModal from './components/dashboard/FeedbackModal'

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
const STREAM_INTERVAL_MS = 15_000

const CATEGORIES: TaskCategory[] = [
  'NAV / Hivatalos',
  'Sürgős teendő',
  'Számla / Bizonylat',
  'Ügyfél kérdés',
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

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString()
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}

// ─── Mock Database ───────────────────────────────────────────────────────────

const INITIAL_TASKS: Task[] = [
  {
    id: 'task-001',
    category: 'NAV / Hivatalos',
    summary: 'NAV Azonnali Inkasszó veszély — TrendMarket Kft.',
    next_step:
      'Azonnal ellenőrizd a NAV Ügyfélportálon az inkasszó értesítést, és értesítsd a TrendMarket Kft. ügyvezetőjét a számlaszám egyenlegéről.',
    priority: 5,
    received_at: minutesAgo(12),
    sender: 'ertesites@nav.gov.hu',
    subject: 'Azonnali inkasszó értesítés — TrendMarket Kft. (12345678-2-41)',
    user_email: DEMO_USER_EMAIL,
    status: 'pending',
  },
  {
    id: 'task-002',
    category: 'Sürgős teendő',
    summary: 'Bérszámfejtési adatok hiánya — Kovács és Társa Bt.',
    next_step:
      'Küldj emlékeztetőt a Kovács és Társa Bt. HR osztályának a hiányzó jelenléti ívek és túlórák adatairól — határidő: holnap 12:00.',
    priority: 4,
    received_at: hoursAgo(2),
    sender: 'hr@kovacs-tarsa.hu',
    subject: 'RE: Márciusi bérszámfejtés — hiányzó adatok',
    user_email: DEMO_USER_EMAIL,
    status: 'pending',
  },
  {
    id: 'task-003',
    category: 'Számla / Bizonylat',
    summary: 'Külföldi számlák áfa köre — Apex Digital Kft.',
    next_step:
      'Ellenőrizd az Apex Digital Kft. német és osztrák beszállítói számláinak áfa-kezelését, és készítsd elő a 58-as bevallás módosítását.',
    priority: 3,
    received_at: hoursAgo(5),
    sender: 'penzugy@apexdigital.hu',
    subject: 'Külföldi számlák — áfa kör tisztázása szükséges',
    user_email: DEMO_USER_EMAIL,
    status: 'pending',
  },
  {
    id: 'task-004',
    category: 'NAV / Hivatalos',
    summary: 'NAV ellenőrzési értesítés — SolarTech Zrt.',
    next_step:
      'Készítsd össze a SolarTech Zrt. 2023-as évi bizonylatait és főkönyvi kivonatokat — NAV ellenőrzés indul 8 napon belül.',
    priority: 5,
    received_at: hoursAgo(1),
    sender: 'ellenorzes@nav.gov.hu',
    subject: 'Adóellenőrzési értesítés — SolarTech Zrt. (98765432-1-13)',
    user_email: DEMO_USER_EMAIL,
    status: 'pending',
  },
  {
    id: 'task-005',
    category: 'Ügyfél kérdés',
    summary: 'OEP járulék kérdés — Horváth Nikolett E.V.',
    next_step:
      'Válaszolj Horváth Nikolett E.V.-nek az egészségügyi járulék 2024-es mértékéről és a kötelező bevallási határidőkről.',
    priority: 2,
    received_at: hoursAgo(8),
    sender: 'horvath.nikolett@gmail.com',
    subject: 'Kérdés: TB járulék mértéke egyéni vállalkozónál',
    user_email: DEMO_USER_EMAIL,
    status: 'pending',
  },
  {
    id: 'task-006',
    category: 'Számla / Bizonylat',
    summary: 'Lejárt szállítói számla — BuildPro Kft.',
    next_step:
      'Egyeztess a BuildPro Kft. pénzügyi vezetőjével a 3 lejárt szállítói számla (összesen 2,4 M Ft) rendezési ütemezéséről.',
    priority: 4,
    received_at: hoursAgo(3),
    sender: 'szamla@buildpro.hu',
    subject: 'FIZETÉSI FELSZÓLÍTÁS — 3 db lejárt számla',
    user_email: DEMO_USER_EMAIL,
    status: 'pending',
  },
  {
    id: 'task-007',
    category: 'Ügyfél kérdés',
    summary: 'EVÁ bevallás határideje — MiniShop Bt.',
    next_step:
      'Tájékoztasd a MiniShop Bt. ügyvezetőjét az EVÁ bevallás következő határidejéről és a szükséges dokumentumokról.',
    priority: 1,
    received_at: hoursAgo(26),
    sender: 'info@minishop.hu',
    subject: 'Kérdés: EVÁ bevallás — mikor kell benyújtani?',
    user_email: DEMO_USER_EMAIL,
    status: 'pending',
  },
  {
    id: 'task-008',
    category: 'NAV / Hivatalos',
    summary: 'Hiányzó NAV bevallás — FreshFood Kft.',
    next_step:
      'Azonnal indítsd el a FreshFood Kft. 2508-as áfabevallásának pótlását — 3 napja lejárt a határidő, mulasztási bírság veszély.',
    priority: 3,
    received_at: hoursAgo(6),
    sender: 'ertesites@nav.gov.hu',
    subject: 'Hiányzó bevallás figyelmeztetés — FreshFood Kft.',
    user_email: DEMO_USER_EMAIL,
    status: 'pending',
  },
]

const STREAM_TASK_TEMPLATES: Omit<Task, 'id' | 'received_at' | 'status'>[] = [
  {
    category: 'Sürgős teendő',
    summary: 'Új bankszámla kivonat — GreenEnergy Kft.',
    next_step:
      'Importáld a GreenEnergy Kft. friss bankszámla kivonatát és párosítsd a nyitott tételeket.',
    priority: 3,
    sender: 'penzugy@greenenergy.hu',
    subject: 'Márciusi bankszámla kivonat csatolva',
    user_email: DEMO_USER_EMAIL,
  },
  {
    category: 'Ügyfél kérdés',
    summary: 'KATA kilépés kérdés — Szabó Péter E.V.',
    next_step:
      'Készíts részletes tájékoztatót Szabó Péter E.V.-nek a KATA kilépés feltételeiről és következményeiről.',
    priority: 2,
    sender: 'szabo.peter.ev@gmail.com',
    subject: 'KATA — kilépés lehetősége és határidők',
    user_email: DEMO_USER_EMAIL,
  },
  {
    category: 'NAV / Hivatalos',
    summary: 'NAV felszólítás — MetroLogisztika Kft.',
    next_step:
      'Ellenőrizd a MetroLogisztika Kft. NAV felszólítását és készítsd elő a válaszlevelet 48 órán belül.',
    priority: 5,
    sender: 'ertesites@nav.gov.hu',
    subject: 'Felszólítás — elmaradt járulékbevallás',
    user_email: DEMO_USER_EMAIL,
  },
  {
    category: 'Számla / Bizonylat',
    summary: 'Hibás számla javítás — TechVision Zrt.',
    next_step:
      'Kérd meg a TechVision Zrt.-t a hibás áfa tartalmú számla (TV-2024/0892) sztornózására és helyesbítő kiállítására.',
    priority: 4,
    sender: 'szamla@techvision.hu',
    subject: 'Hibás számla — áfa összeg eltérés',
    user_email: DEMO_USER_EMAIL,
  },
  {
    category: 'Sürgős teendő',
    summary: 'Éves beszámoló határidő — ArtDesign Studio Kft.',
    next_step:
      'Indítsd el az ArtDesign Studio Kft. 2024-es éves beszámolójának összeállítását — határidő: 30 nap.',
    priority: 4,
    sender: 'ugyvezeto@artdesign.hu',
    subject: 'Éves beszámoló — mikor készül el?',
    user_email: DEMO_USER_EMAIL,
  },
]

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

  const handleGoogleLogin = () => {
    setIsLoading(true)
    setTimeout(() => {
      onLogin(DEMO_USER_EMAIL)
      setIsLoading(false)
    }, 1200)
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
            <h2 className="text-2xl font-bold text-white">Üdvözöljük vissza</h2>
            <p className="mt-2 text-sm text-slate-400">
              Jelentkezzen be a munkaterület eléréséhez. Az adatai titkosítva
              tárolódnak.
            </p>

            <button
              type="button"
              onClick={handleGoogleLogin}
              disabled={isLoading}
              className="mt-8 flex w-full items-center justify-center gap-3 rounded-xl border border-slate-700 bg-white px-6 py-3.5 text-sm font-semibold text-slate-900 transition-all hover:bg-slate-100 hover:shadow-lg disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isLoading ? (
                <span className="flex items-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-400 border-t-slate-900" />
                  Belépés folyamatban…
                </span>
              ) : (
                <>
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
                </>
              )}
            </button>

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
            </main>
          </>
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
  const [tasks, setTasks] = useState<Task[]>(INITIAL_TASKS)
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

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const handleLogin = (email: string) => {
    setUserEmail(email)
    setView('paywall')
  }

  const handleLogout = () => {
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

  const handleCompleteTask = (id: string) => {
    setCompletingIds((prev) => new Set(prev).add(id))
    setTimeout(() => {
      setTasks((prev) =>
        prev.map((t) => (t.id === id ? { ...t, status: 'completed' as const } : t)),
      )
      setCompletingIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }, 450)
  }

  const handleSaveAutomation = (rules: string, enabled: boolean) => {
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

  // Real-time stream simulation
  useEffect(() => {
    if (view !== 'dashboard' || !userEmail) return

    let streamIndex = 0

    const interval = setInterval(() => {
      const template =
        STREAM_TASK_TEMPLATES[streamIndex % STREAM_TASK_TEMPLATES.length]
      streamIndex++

      const isAutoOn = automationEnabledRef.current
      const newTaskId = generateId()

      const newTask: Task = {
        ...template,
        id: newTaskId,
        received_at: new Date().toISOString(),
        status: 'pending',
        user_email: userEmail,
        ai_status: isAutoOn ? 'generating' : 'idle',
      }

      setTasks((prev) => [newTask, ...prev])

      const toastId = generateId()
      setToasts((prev) => [
        ...prev,
        {
          id: toastId,
          message: 'Új feladat érkezett',
          taskSummary: newTask.summary,
        },
      ])

      // If automation is on, simulate generating a response after 5 seconds
      if (isAutoOn) {
        setTimeout(() => {
          setTasks((prev) =>
            prev.map((t) => {
              if (t.id !== newTaskId) return t
              const senderName = template.sender.split('@')[0]
              const senderCapitalized = senderName.charAt(0).toUpperCase() + senderName.slice(1)
              const generatedReply = `Kedves ${senderCapitalized}!\n\nKöszönjük megkeresését. A(z) "${template.subject}" tárgyú e-mailjét megkaptuk.\n\nAz Ön által kért műveletet a megadott beállítások alapján feldolgozzuk:\n"${promptRulesRef.current}"\n\nAmennyiben további adatra van szükségünk, kollégánk keresni fogja.\n\nÜdvözlettel,\nNormaFlow AI`

              return {
                ...t,
                ai_status: 'sent',
                ai_reply: generatedReply,
              }
            }),
          )

          // Trigger AI Toast
          setToasts((prev) => [
            ...prev,
            {
              id: generateId(),
              message: 'AI Válasz elküldve',
              taskSummary: `Címzett: ${template.sender}`,
            },
          ])
        }, 5000)
      }
    }, STREAM_INTERVAL_MS)

    return () => clearInterval(interval)
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
