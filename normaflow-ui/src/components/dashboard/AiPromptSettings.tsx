import { useState, useEffect } from 'react'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { db } from '../../firebase'
import { Sparkles, Save, Loader2, ShieldAlert } from 'lucide-react'

interface AiPromptSettingsProps {
  userId: string
}

export default function AiPromptSettings({ userId }: AiPromptSettingsProps) {
  const [customPriorityRules, setCustomPriorityRules] = useState('')
  const [customReplyRules, setCustomReplyRules] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState('')
  const [saveError, setSaveError] = useState('')

  useEffect(() => {
    if (!userId) return

    const loadRules = async () => {
      try {
        const docRef = doc(db, `users/${userId}/settings/ai_rules`)
        const docSnap = await getDoc(docRef)
        if (docSnap.exists()) {
          const data = docSnap.data()
          setCustomPriorityRules(data.customPriorityRules || '')
          setCustomReplyRules(data.customReplyRules || '')
        }
      } catch (err: any) {
        console.error('Failed to load custom AI rules:', err)
      } finally {
        setIsLoading(false)
      }
    }

    loadRules()
  }, [userId])

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSaving(true)
    setSaveSuccess('')
    setSaveError('')

    try {
      const docRef = doc(db, `users/${userId}/settings/ai_rules`)
      await setDoc(docRef, {
        customPriorityRules: customPriorityRules.trim(),
        customReplyRules: customReplyRules.trim(),
        updatedAt: new Date().toISOString(),
      }, { merge: true })

      setSaveSuccess('AI prompt szabályok sikeresen mentve!')
      setTimeout(() => setSaveSuccess(''), 3000)
    } catch (err: any) {
      setSaveError(err.message || 'Hiba történt a mentés során.')
    } finally {
      setIsSaving(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8 rounded-2xl border border-slate-800 bg-slate-900/60 backdrop-blur-md">
        <Loader2 className="h-6 w-6 animate-spin text-indigo-400" />
      </div>
    )
  }

  return (
    <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-2xl backdrop-blur-md">
      {/* Glow Effects */}
      <div className="absolute -right-24 -top-24 h-48 w-48 rounded-full bg-indigo-600/5 blur-3xl" />
      <div className="absolute -left-24 -bottom-24 h-48 w-48 rounded-full bg-violet-600/5 blur-3xl" />

      {/* Header */}
      <div className="relative z-10 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-slate-800/80 pb-6 mb-6">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-violet-400" />
            <h2 className="text-xl font-bold tracking-tight text-white">AI Asszisztens Testreszabása</h2>
          </div>
          <p className="mt-1 text-sm text-slate-400">
            Személyre szabott szabályok és prioritások megadása az AI feldolgozáshoz.
          </p>
        </div>
      </div>

      <form onSubmit={handleSave} className="space-y-5 relative z-10">
        {saveSuccess && (
          <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3 text-xs font-semibold text-emerald-400">
            {saveSuccess}
          </div>
        )}
        {saveError && (
          <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-xs font-semibold text-red-400">
            {saveError}
          </div>
        )}

        {/* Custom Priority Rules */}
        <div className="flex flex-col gap-2">
          <label htmlFor="custom-priority-rules" className="text-sm font-semibold text-slate-200">
            Egyedi Prioritizálási Szabályok
          </label>
          <textarea
            id="custom-priority-rules"
            rows={4}
            disabled={isSaving}
            value={customPriorityRules}
            onChange={(e) => setCustomPriorityRules(e.target.value)}
            placeholder="Pl.: Ha a levélben szerepel a 'KATA' vagy 'Számlatömb' szó, az mindig legyen Sürgős. Ha a feladó a NAV, állítsd Sürgősre..."
            className="w-full rounded-xl border border-slate-700 bg-slate-950/70 p-4 text-sm text-slate-300 placeholder-slate-600 shadow-inner transition-colors focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500 disabled:opacity-60"
          />
        </div>

        {/* Custom Reply Rules */}
        <div className="flex flex-col gap-2">
          <label htmlFor="custom-reply-rules" className="text-sm font-semibold text-slate-200">
            Egyedi Válaszadási Stílus és Szabályok
          </label>
          <textarea
            id="custom-reply-rules"
            rows={4}
            disabled={isSaving}
            value={customReplyRules}
            onChange={(e) => setCustomReplyRules(e.target.value)}
            placeholder="Pl.: Mindig tegeződj, és a levél végére írd oda, hogy a hiányzó bizonylatokat péntekig várjuk..."
            className="w-full rounded-xl border border-slate-700 bg-slate-950/70 p-4 text-sm text-slate-300 placeholder-slate-600 shadow-inner transition-colors focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500 disabled:opacity-60"
          />
        </div>

        {/* Info warning */}
        <div className="flex items-start gap-2.5 rounded-xl border border-slate-800 bg-slate-950/40 p-3.5 text-xs text-slate-400">
          <ShieldAlert className="h-4 w-4 text-slate-500 shrink-0 mt-0.5" />
          <p className="leading-relaxed">
            Megjegyzés: Az AI alapvető könyvelési és biztonsági logikája védett, az Ön kiegészítései ezen felül lépnek érvénybe.
          </p>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end border-t border-slate-800/80 pt-5">
          <button
            type="submit"
            disabled={isSaving}
            className="flex items-center gap-2 rounded-xl bg-violet-600 px-5 py-2.5 text-xs font-semibold text-white shadow-lg shadow-violet-900/30 transition-all hover:bg-violet-500 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSaving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Mentés…
              </>
            ) : (
              <>
                <Save className="h-4 w-4" />
                Mentés
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  )
}
