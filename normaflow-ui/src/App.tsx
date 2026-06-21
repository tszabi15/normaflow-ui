import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import {
  Mail,
  AlertTriangle,
  Inbox,
  Bell,
  X,
  Lightbulb,
  ShieldAlert,
  Trash2,
  Plus,
} from 'lucide-react'

// Import components and types
import type { Task, TaskCategory } from './types/task'
import AiSettings from './components/dashboard/AiSettings'
import FeedbackModal from './components/dashboard/FeedbackModal'
import EmailInboxPanel from './components/dashboard/EmailInboxPanel'
import LoginView from './components/auth/LoginView'
import PaywallView from './components/dashboard/PaywallView'
import Sidebar from './components/dashboard/Sidebar'
import TaskCard from './components/dashboard/TaskCard'
import ManualReplyModal from './components/dashboard/ManualReplyModal'
import { db, auth } from './firebase'
import { collection, query, where, onSnapshot, doc, setDoc, getDoc, addDoc, deleteDoc } from 'firebase/firestore'
import { useAuth } from './context/AuthContext'

// ─── Types ───────────────────────────────────────────────────────────────────

type CategoryFilter = TaskCategory | 'Összes'

type SubscriptionTier = 'none' | 'basic' | 'pro' | 'ultra'

interface Toast {
  id: string
  message: string
  taskSummary: string
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TIER_LIMITS: Record<SubscriptionTier, number> = {
  none: 0,
  basic: 500,
  pro: 1500,
  ultra: 5000,
}

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

// ─── TaskCard (extracted to components/dashboard/TaskCard.tsx) ────────────────────

// ─── MainDashboard ───────────────────────────────────────────────────────────

function MainDashboard({
  userEmail,
  userId,
  tasks,
  categoryFilter,
  onCategoryChange,
  completingIds,
  onCompleteTask,
  onLogout,
  activeTab,
  onTabChange,
  onOpenFeedback,
  processedEmailsThisMonth,
  tier,
  enforceWhitelist,
  onToggleWhitelist,
  onWriteReply,
  onRestoreTask,
}: {
  userEmail: string
  userId: string
  tasks: Task[]
  categoryFilter: CategoryFilter
  onCategoryChange: (cat: CategoryFilter) => void
  completingIds: Set<string>
  onCompleteTask: (id: string) => void
  onLogout: () => void
  activeTab: 'tasks' | 'inbox' | 'automation'
  onTabChange: (tab: 'tasks' | 'inbox' | 'automation') => void
  onOpenFeedback: () => void
  processedEmailsThisMonth: number
  tier: string
  enforceWhitelist: boolean
  onToggleWhitelist: (checked: boolean) => void
  onWriteReply: (task: Task) => void
  onRestoreTask: (id: string) => void
}) {
  const limit = TIER_LIMITS[tier as SubscriptionTier] ?? TIER_LIMITS.none
  const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1)

  let workspaceTitle = "Nincs aktív előfizetés"
  let workspaceSubtitle = "Nincs aktív előfizetés"
  let workspaceStatusLabel = "Nincs aktív előfizetés"

  if (tier === 'basic') {
    workspaceTitle = "NormaFlow Basic"
    workspaceSubtitle = "Basic munkaterület"
    workspaceStatusLabel = "NormaFlow Basic aktív"
  } else if (tier === 'pro') {
    workspaceTitle = "NormaFlow Pro"
    workspaceSubtitle = "Pro munkaterület"
    workspaceStatusLabel = "NormaFlow Pro aktív"
  } else if (tier === 'ultra') {
    workspaceTitle = "NormaFlow Ultra"
    workspaceSubtitle = "Ultra munkaterület"
    workspaceStatusLabel = "NormaFlow Ultra aktív"
  }

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
      <Sidebar
        activeTab={activeTab}
        categoryFilter={categoryFilter}
        categoryFilters={CATEGORY_FILTERS}
        metrics={metrics}
        userEmail={userEmail}
        workspaceTitle={workspaceTitle}
        workspaceSubtitle={workspaceSubtitle}
        workspaceStatusLabel={workspaceStatusLabel}
        tierLabel={tierLabel}
        processedEmailsThisMonth={processedEmailsThisMonth}
        limit={limit}
        onTabChange={onTabChange}
        onCategoryChange={onCategoryChange}
        onOpenFeedback={onOpenFeedback}
        onLogout={onLogout}
      />

      {/* Main Content */}
      <div className="flex min-w-0 flex-1 flex-col">
        {activeTab === 'tasks' ? (
          <>
            {/* Top Metrics Bar */}
            <header className="border-b border-slate-800 bg-slate-900/80 px-4 py-4 backdrop-blur-sm sm:px-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h1 className="text-lg font-bold text-white">{workspaceSubtitle}</h1>
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
                      className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-all ${
                        activeTab === 'tasks' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Feladatok
                    </button>
                    <button
                      type="button"
                      onClick={() => onTabChange('inbox')}
                      className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-all ${
                        (activeTab as string) === 'inbox' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Levelek
                    </button>
                    <button
                      type="button"
                      onClick={() => onTabChange('automation')}
                      className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-all ${
                        (activeTab as string) === 'automation' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'
                      }`}
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
        ) : activeTab === 'inbox' ? (
          <>
            {/* Top Header for Inbox */}
            <header className="border-b border-slate-800 bg-slate-900/80 px-4 py-4 backdrop-blur-sm sm:px-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h1 className="text-lg font-bold text-white">Bejövő levelek</h1>
                  <p className="text-xs text-slate-500">
                    A szerverre érkező és AI által feldolgozásra váró e-mailek listája
                  </p>
                </div>

                {/* Mobile Tab Switcher */}
                <div className="flex items-center gap-1 rounded-lg bg-slate-950 p-1 border border-slate-800/80 lg:hidden">
                  <button
                    type="button"
                    onClick={() => onTabChange('tasks')}
                    className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-all ${
                      (activeTab as string) === 'tasks' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Feladatok
                  </button>
                  <button
                    type="button"
                    onClick={() => onTabChange('inbox')}
                    className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-all ${
                      activeTab === 'inbox' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Levelek
                  </button>
                  <button
                    type="button"
                    onClick={() => onTabChange('automation')}
                    className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-all ${
                      (activeTab as string) === 'automation' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    AI
                  </button>
                </div>
              </div>
            </header>

            <main className="flex-1 overflow-y-auto bg-slate-950">
              <EmailInboxPanel userId={userId} />
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
                    className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-all ${
                      (activeTab as string) === 'tasks' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Feladatok
                  </button>
                  <button
                    type="button"
                    onClick={() => onTabChange('inbox')}
                    className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-all ${
                      (activeTab as string) === 'inbox' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Levelek
                  </button>
                  <button
                    type="button"
                    onClick={() => onTabChange('automation')}
                    className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-all ${
                      activeTab === 'automation' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    AI
                  </button>
                </div>
              </div>
            </header>

            <main className="flex-1 overflow-y-auto p-4 sm:p-6 bg-slate-950">
              <AiSettings
                userEmail={userEmail}
                userId={userId}
              />
              <div className="mx-auto max-w-3xl px-4 pb-12 sm:px-6 space-y-6">
                <WhitelistSettingsCard
                  userEmail={userEmail}
                  enforceWhitelist={enforceWhitelist}
                  onToggleWhitelist={onToggleWhitelist}
                />
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





// ─── App Root ────────────────────────────────────────────────────────────────

export default function App() {
  const { user, isLoading, logout } = useAuth()
  const [tasks, setTasks] = useState<Task[]>([])
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('Összes')
  const [completingIds, setCompletingIds] = useState<Set<string>>(new Set())
  const [toasts, setToasts] = useState<Toast[]>([])

  const hasAccess = user?.subscriptionStatus === 'active'

  // AI automation states
  const [activeTab, setActiveTab] = useState<'tasks' | 'inbox' | 'automation'>('tasks')
  const [automationEnabled, setAutomationEnabled] = useState(false)
  const [promptRules, setPromptRules] = useState(
    'Ha az ügyfél számlát kér, válaszolj udvariasan, hogy feldolgozzuk és küldjük. Válasz végére írd oda: Üdvözlettel, NormaFlow Asszisztens.'
  )
  const [enforceWhitelist, setEnforceWhitelist] = useState(true)
  
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false)

  // Manual Reply states & actions
  const [replyTask, setReplyTask] = useState<Task | null>(null)

  const handleWriteReply = (task: Task) => {
    setReplyTask(task)
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

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const handleLogout = async () => {
    try {
      await logout()
    } catch (err) {
      console.error('Logout error:', err)
    }
    setCategoryFilter('Összes')
    setCompletingIds(new Set())
    setToasts([])
    setActiveTab('tasks')
    setAutomationEnabled(false)
    setEnforceWhitelist(true)
  }

  const handleSelectTier = async (selectedTier: SubscriptionTier) => {
    if (!user?.email) return
    try {
      const firebaseUser = auth.currentUser
      if (!firebaseUser) throw new Error('Nem bejelentkezett felhasználó')
      const token = await firebaseUser.getIdToken()

      // Hardening: Removed client-side direct writes to users/{userId} subscription status/tier
      // Bypasses local setDoc with a secure backend verify/checkout session network call.
      const response = await fetch(`${import.meta.env.VITE_API_BASE_URL}/verifySubscription`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ tier: selectedTier }),
      })

      if (!response.ok) {
        throw new Error('Sikertelen előfizetés frissítés.')
      }

      const toastId = generateId()
      setToasts((prev) => [
        ...prev,
        {
          id: toastId,
          message: 'Előfizetés kezdeményezve',
          taskSummary: `Csomag: ${selectedTier}. A frissítés hamarosan élesedik.`,
        },
      ])
    } catch (err: any) {
      console.error('Error starting subscription checkout:', err)
      alert('Hiba az előfizetés során: ' + err.message)
    }
  }

  const handleCompleteTask = async (id: string) => {
    setCompletingIds((prev) => new Set(prev).add(id))
    try {
      const user = auth.currentUser
      if (!user) throw new Error('Nem bejelentkezett felhasználó')
      const token = await user.getIdToken()

      const response = await fetch(`${import.meta.env.VITE_API_BASE_URL}/archiveTask`, {
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

      const response = await fetch(`${import.meta.env.VITE_API_BASE_URL}/restoreTask`, {
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

  const handleToggleWhitelist = async (checked: boolean) => {
    if (!user?.email) return
    try {
      const settingsRef = doc(db, `users/${user.email}/settings/auto_responder`)
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
    if (!hasAccess || !user?.email) return

    const q = query(
      collection(db, 'tasks'),
      where('user_email', '==', user.email)
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
  }, [hasAccess, user?.email])

  // Load auto-responder settings from Firestore on mount/login
  useEffect(() => {
    if (!hasAccess || !user?.email) return

    const settingsRef = doc(db, `users/${user.email}/settings/auto_responder`)
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
  }, [hasAccess, user?.email])

  return (
    <>
      {isLoading && (
        <div className="flex min-h-screen items-center justify-center bg-slate-950">
          <span className="h-8 w-8 animate-spin rounded-full border-2 border-indigo-400 border-t-transparent" />
        </div>
      )}

      {!isLoading && !user && (
        <LoginView onAuthenticated={() => {}} />
      )}

      {!isLoading && user && user.subscriptionStatus !== 'active' && (
        <PaywallView
          userEmail={user.email}
          onSelectTier={handleSelectTier}
          onLogout={handleLogout}
        />
      )}

      {!isLoading && user && user.subscriptionStatus === 'active' && (
        <MainDashboard
          userEmail={user.email}
          userId={user.uid}
          tasks={tasks}
          categoryFilter={categoryFilter}
          onCategoryChange={setCategoryFilter}
          completingIds={completingIds}
          onCompleteTask={handleCompleteTask}
          onLogout={handleLogout}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          onOpenFeedback={() => setIsFeedbackOpen(true)}
          processedEmailsThisMonth={user.processedEmailsThisMonth}
          tier={user.tier}
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
        userEmail={user?.email || ''}
      />

      {/* Manual Reply Modal */}
      {replyTask && (
        <ManualReplyModal
          replyTask={replyTask}
          userEmail={user?.email || ''}
          onClose={() => setReplyTask(null)}
          onReplySent={() => {
            setReplyTask(null)
            setToasts((prev) => [
              ...prev,
              {
                id: `toast-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                message: 'E-mail elküldve',
                taskSummary: `Sikeres válasz a következőnek: ${replyTask.sender}`,
              },
            ])
          }}
          onNavigateToAutomation={() => setActiveTab('automation')}
          onToastAdd={(toast) => setToasts((prev) => [...prev, toast])}
        />
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
