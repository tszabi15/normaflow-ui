import { Zap, Inbox, Mail, Sparkles, Filter, Lightbulb, LogOut } from 'lucide-react'

type CategoryFilter = string

interface SidebarProps {
  activeTab: string
  categoryFilter: CategoryFilter
  categoryFilters: CategoryFilter[]
  metrics: { counts: Record<string, number> }
  userEmail: string
  workspaceTitle: string
  workspaceSubtitle: string
  workspaceStatusLabel: string
  tierLabel: string
  processedEmailsThisMonth: number
  limit: number
  onTabChange: (tab: string) => void
  onCategoryChange: (category: CategoryFilter) => void
  onOpenFeedback: () => void
  onLogout: () => void
}

export default function Sidebar({
  activeTab,
  categoryFilter,
  categoryFilters,
  metrics,
  userEmail,
  workspaceTitle,
  workspaceSubtitle,
  workspaceStatusLabel,
  tierLabel,
  processedEmailsThisMonth,
  limit,
  onTabChange,
  onCategoryChange,
  onOpenFeedback,
  onLogout,
}: SidebarProps) {
  const quotaPercentage = limit > 0 ? Math.min(100, Math.round((processedEmailsThisMonth / limit) * 100)) : 0

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-slate-800 bg-slate-900/50 lg:flex">
      <div className="border-b border-slate-800 p-5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600">
            <Zap className="h-4 w-4 text-white" />
          </div>
          <div>
            <p className="text-sm font-bold text-white">{workspaceTitle}</p>
            <p className="text-[10px] text-slate-500">{workspaceSubtitle}</p>
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
            onClick={() => onTabChange('inbox')}
            className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-all ${
              activeTab === 'inbox'
                ? 'bg-indigo-600/20 font-medium text-indigo-300'
                : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
            }`}
          >
            <Mail className="h-4 w-4" />
            <span>Bejövő levelek</span>
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
          <span>{quotaPercentage}%</span>
        </div>
        <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              processedEmailsThisMonth >= limit ? 'bg-rose-500 shadow-lg shadow-rose-500/20' : 'bg-indigo-500 shadow-lg shadow-indigo-500/20'
            }`}
            style={{ width: `${quotaPercentage}%` }}
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
            {categoryFilters.map((cat) => (
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
          <p className="text-[10px] text-slate-500">{workspaceStatusLabel}</p>
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
  )
}
