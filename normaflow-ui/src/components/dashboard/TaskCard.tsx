import { useState } from 'react'
import { Check, Mail, Clock, AlertTriangle, Sparkles } from 'lucide-react'
import type { Task, TaskPriority } from '../../types/task'

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

interface TaskCardProps {
  task: Task
  isCompleting: boolean
  onComplete: (id: string) => void
  onWriteReply: (task: Task) => void
  onRestoreTask: (id: string) => void
}

export default function TaskCard({ task, isCompleting, onComplete, onWriteReply, onRestoreTask }: TaskCardProps) {
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

          {task.source_email && (
            <div className="mt-2">
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-violet-400 bg-violet-500/10 border border-violet-500/20 px-2 py-0.5 rounded-full">
                <Mail className="h-2.5 w-2.5 shrink-0" />
                Fiók: {task.source_email}
              </span>
            </div>
          )}

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
