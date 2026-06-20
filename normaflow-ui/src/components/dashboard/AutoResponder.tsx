import { useState, useEffect } from 'react'
import { Sparkles, Save, Loader2, AlertCircle, HelpCircle } from 'lucide-react'

interface AutoResponderProps {
  initialEnabled: boolean
  initialRules: string
  onSave: (rules: string, enabled: boolean) => Promise<void> | void
}

export default function AutoResponder({
  initialEnabled,
  initialRules,
  onSave,
}: AutoResponderProps) {
  const [rules, setRules] = useState(initialRules)
  const [isEnabled, setIsEnabled] = useState(initialEnabled)
  const [isSaving, setIsSaving] = useState(false)

  // Sync state if props change (though usually local state controls this)
  useEffect(() => {
    setRules(initialRules)
    setIsEnabled(initialEnabled)
  }, [initialRules, initialEnabled])

  const handleSave = async () => {
    setIsSaving(true)
    // Simulate Firestore write delay
    await new Promise((resolve) => setTimeout(resolve, 800))
    await onSave(rules, isEnabled)
    setIsSaving(false)
  }

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6 animate-fade-in">
      <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-2xl backdrop-blur-md">
        {/* Glow Effects */}
        <div className="absolute -right-24 -top-24 h-48 w-48 rounded-full bg-indigo-600/10 blur-3xl" />
        <div className="absolute -left-24 -bottom-24 h-48 w-48 rounded-full bg-violet-600/10 blur-3xl" />

        {/* Header */}
        <div className="relative z-10 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-slate-800/80 pb-6">
          <div>
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-indigo-400" />
              <h2 className="text-xl font-bold tracking-tight text-white">AI Automatizáció</h2>
            </div>
            <p className="mt-1 text-sm text-slate-400">
              E-mailes megkeresések automatikus megválaszolása egyedi szabályok alapján.
            </p>
          </div>

          {/* Toggle Switch */}
          <div className="flex items-center gap-3 self-start sm:self-center">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Automatizáció:
            </span>
            <button
              type="button"
              onClick={() => setIsEnabled(!isEnabled)}
              disabled={isSaving}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-slate-900 ${
                isEnabled ? 'bg-indigo-600' : 'bg-slate-700'
              }`}
              aria-checked={isEnabled}
              role="switch"
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                  isEnabled ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
            <span
              className={`text-xs font-bold uppercase ${
                isEnabled ? 'text-indigo-400' : 'text-slate-500'
              }`}
            >
              {isEnabled ? 'BE' : 'KI'}
            </span>
          </div>
        </div>

        {/* Form Content */}
        <div className="relative z-10 mt-6 space-y-6">
          <div className="flex flex-col gap-2">
            <label htmlFor="prompt-rules" className="text-sm font-semibold text-slate-200 flex items-center gap-1.5">
              Instrukciók az AI részére (Prompt szabályok)
              <span title="Itt határozhatja meg, hogyan válaszoljon az AI az ügyfeleknek.">
                <HelpCircle className="h-3.5 w-3.5 text-slate-500 cursor-help" />
              </span>
            </label>
            <textarea
              id="prompt-rules"
              rows={6}
              disabled={isSaving}
              value={rules}
              onChange={(e) => setRules(e.target.value)}
              placeholder="Például:&#10;Ha az ügyfél számlát vagy bizonylatot kér, válaszolj udvariasan, hogy feldolgozzuk és küldjük.&#10;Ha NAV levélről van szó, jelezd, hogy szakértőnk felülvizsgálja és 24 órán belül válaszol.&#10;Minden választ írj alá így: NormaFlow AI Asszisztens."
              className="w-full rounded-xl border border-slate-700 bg-slate-950/70 p-4 text-sm text-slate-300 placeholder-slate-600 shadow-inner transition-colors focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-60"
            />
          </div>

          {/* Quick Guidance Box */}
          <div className="rounded-xl border border-indigo-500/20 bg-indigo-950/20 p-4 flex gap-3">
            <AlertCircle className="h-5 w-5 shrink-0 text-indigo-400 mt-0.5" />
            <div className="text-xs text-slate-300 space-y-1.5">
              <span className="font-bold text-indigo-300">Hogyan működik a generálás?</span>
              <p className="leading-relaxed">
                Új feladat beérkezésekor, ha a funkció aktív, a rendszer a fenti instrukciók és az e-mail tartalma alapján összeállít egy választervezetet. 5 másodperc múlva a válasz automatikusan megjelenik a feladatkártyán és szimuláltan kiküldésre kerül az ügyfélnek.
              </p>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-between border-t border-slate-800/80 pt-6">
            <div className="text-xs text-slate-500">
              Mentve a Firestore-ba: <code className="text-slate-400">users/id/settings/auto_responder</code>
            </div>
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving}
              className="flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-900/30 transition-all hover:bg-indigo-500 hover:shadow-indigo-800/40 active:scale-95 disabled:scale-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSaving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Mentés folyamatban…
                </>
              ) : (
                <>
                  <Save className="h-4 w-4" />
                  Mentés és Aktiválás
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
