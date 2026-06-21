import { useState, useEffect } from 'react'
import { Sparkles, Save, Loader2, HelpCircle, Shield, Mail, Check, Copy, Inbox, Settings2, Bot } from 'lucide-react'
import { doc, getDoc, setDoc, onSnapshot, collection } from 'firebase/firestore'
import { db } from '../../firebase'

interface AiSettingsProps {
  userEmail: string
  userId: string
}

interface AiConfiguration {
  globalAutomationEnabled: boolean
  exclusionRules: string
  customPriorityRules: string
  customReplyRules: string
}

export default function AiSettings({ userEmail, userId }: AiSettingsProps) {
  const [activeTab, setActiveTab] = useState<'automation' | 'customization'>('automation')
  
  // AI configuration states
  const [globalAutomationEnabled, setGlobalAutomationEnabled] = useState(false)
  const [exclusionRules, setExclusionRules] = useState('')
  const [customPriorityRules, setCustomPriorityRules] = useState('')
  const [customReplyRules, setCustomReplyRules] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [saveSuccess, setSaveSuccess] = useState('')
  const [saveError, setSaveError] = useState('')

  // SMTP form states
  const [configEmail, setConfigEmail] = useState('')
  const [configPassword, setConfigPassword] = useState('')
  const [smtpHost, setSmtpHost] = useState('')
  const [smtpPort, setSmtpPort] = useState('587')
  const [isSmtpSaving, setIsSmtpSaving] = useState(false)
  const [smtpError, setSmtpError] = useState('')
  const [smtpSuccess, setSmtpSuccess] = useState('')
  const [copied, setCopied] = useState(false)

  // Load unified AI configuration
  useEffect(() => {
    if (!userId) return

    const loadConfig = async () => {
      try {
        const docRef = doc(db, `users/${userId}/settings/ai_configuration`)
        const docSnap = await getDoc(docRef)
        if (docSnap.exists()) {
          const data = docSnap.data() as AiConfiguration
          setGlobalAutomationEnabled(data.globalAutomationEnabled || false)
          setExclusionRules(data.exclusionRules || '')
          setCustomPriorityRules(data.customPriorityRules || '')
          setCustomReplyRules(data.customReplyRules || '')
        }
      } catch (err: any) {
        console.error('Failed to load AI configuration:', err)
      } finally {
        setIsLoading(false)
      }
    }

    loadConfig()
  }, [userId])

  // Load existing SMTP config
  useEffect(() => {
    if (!userEmail) return
    const docRef = doc(db, `users/${userEmail}/email_connections`, 'smtp')
    const unsubscribe = onSnapshot(docRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data()
        setConfigEmail(data.email || '')
        setConfigPassword(data.password || '')
        setSmtpHost(data.smtp_host || '')
        setSmtpPort(String(data.smtp_port || '587'))
      } else {
        // Fallback: try loading first document in collection if 'smtp' doc does not exist
        getDoc(doc(db, `users/${userEmail}/email_connections`, 'smtp')).then((smtpSnap) => {
          if (!smtpSnap.exists()) {
            const q = collection(db, `users/${userEmail}/email_connections`)
            onSnapshot(q, (snap) => {
              if (!snap.empty) {
                const data = snap.docs[0].data()
                setConfigEmail(data.email || '')
                setConfigPassword(data.password || '')
                setSmtpHost(data.smtp_host || data.smtpHost || '')
                setSmtpPort(String(data.smtp_port || data.smtpPort || '587'))
              }
            })
          }
        })
      }
    }, (err) => {
      console.error('Error loading email connections:', err)
    })
    return () => unsubscribe()
  }, [userEmail])

  const handleSaveAiConfig = async () => {
    setIsSaving(true)
    setSaveSuccess('')
    setSaveError('')

    try {
      const docRef = doc(db, `users/${userId}/settings/ai_configuration`)
      await setDoc(docRef, {
        globalAutomationEnabled,
        exclusionRules: exclusionRules.trim(),
        customPriorityRules: customPriorityRules.trim(),
        customReplyRules: customReplyRules.trim(),
        updatedAt: new Date().toISOString(),
      }, { merge: true })

      setSaveSuccess('AI beállítások sikeresen mentve!')
      setTimeout(() => setSaveSuccess(''), 3000)
    } catch (err: any) {
      setSaveError(err.message || 'Hiba történt a mentés során.')
    } finally {
      setIsSaving(false)
    }
  }

  const handleSaveSmtp = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSmtpSaving(true)
    setSmtpError('')
    setSmtpSuccess('')
    try {
      const docRef = doc(db, `users/${userEmail}/email_connections`, 'smtp')
      await setDoc(docRef, {
        email: configEmail.trim(),
        password: configPassword,
        smtp_host: smtpHost.trim(),
        smtp_port: parseInt(smtpPort) || 587,
        connected_at: new Date().toISOString(),
      })
      setSmtpSuccess('SMTP beállítások sikeresen mentve!')
    } catch (err: any) {
      setSmtpError(err.message || 'Hiba történt a mentés során.')
    } finally {
      setIsSmtpSaving(false)
    }
  }

  const forwarderEmail = `normaflow.inbound+${userId}@gmail.com`

  const handleCopyWebhook = () => {
    navigator.clipboard.writeText(forwarderEmail)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8 rounded-2xl border border-slate-800 bg-slate-900/60 backdrop-blur-md">
        <Loader2 className="h-6 w-6 animate-spin text-indigo-400" />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6 animate-fade-in space-y-8">
      {/* Unified AI Settings Card */}
      <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-2xl backdrop-blur-md">
        {/* Glow Effects */}
        <div className="absolute -right-24 -top-24 h-48 w-48 rounded-full bg-indigo-600/10 blur-3xl" />
        <div className="absolute -left-24 -bottom-24 h-48 w-48 rounded-full bg-violet-600/10 blur-3xl" />

        {/* Header */}
        <div className="relative z-10 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-slate-800/80 pb-6">
          <div>
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-indigo-400" />
              <h2 className="text-xl font-bold tracking-tight text-white">AI Beállítások</h2>
            </div>
            <p className="mt-1 text-sm text-slate-400">
              Egységesített AI konfiguráció az automatizációhoz és asszisztens testreszabáshoz.
            </p>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="relative z-10 mt-6 flex gap-2 border-b border-slate-800/80">
          <button
            type="button"
            onClick={() => setActiveTab('automation')}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-semibold transition-all ${
              activeTab === 'automation'
                ? 'text-indigo-400 border-b-2 border-indigo-400'
                : 'text-slate-400 hover:text-slate-300'
            }`}
          >
            <Settings2 className="h-4 w-4" />
            AI Automatizáció és Szűrés
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('customization')}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-semibold transition-all ${
              activeTab === 'customization'
                ? 'text-violet-400 border-b-2 border-violet-400'
                : 'text-slate-400 hover:text-slate-300'
            }`}
          >
            <Bot className="h-4 w-4" />
            AI Asszisztens Testreszabása
          </button>
        </div>

        {/* Tab Content */}
        <div className="relative z-10 mt-6">
          {activeTab === 'automation' ? (
            <div className="space-y-6">
              {/* Global Automation Toggle */}
              <div className="rounded-xl border border-violet-500/20 bg-violet-950/15 p-4 flex items-center justify-between gap-4">
                <div className="flex items-start gap-3">
                  <Shield className="h-5 w-5 shrink-0 text-violet-400 mt-0.5" />
                  <div>
                    <p className="text-sm font-semibold text-white">Teljesen autonóm háttér-feldolgozás</p>
                    <p className="mt-0.5 text-xs text-slate-400">
                      Ha aktív, a rendszer az e-mail továbbítás során azonnal feldolgozza az új e-maileket az AI asszisztenssel — manuális beavatkozás nélkül. Ha ki van kapcsolva, a levelek mentésre kerülnek, de AI kreditet nem fogyasztanak.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setGlobalAutomationEnabled(!globalAutomationEnabled)}
                  disabled={isSaving}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-violet-500 focus:ring-offset-2 focus:ring-offset-slate-900 ${
                    globalAutomationEnabled ? 'bg-violet-600' : 'bg-slate-700'
                  }`}
                  role="switch"
                  aria-checked={globalAutomationEnabled}
                >
                  <span
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      globalAutomationEnabled ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {/* Exclusion Rules */}
              <div className="flex flex-col gap-2">
                <label htmlFor="exclusion-rules" className="text-sm font-semibold text-slate-200 flex items-center gap-1.5">
                  AI Szűrési Szabályok (Milyen leveleket hagyjon figyelmen kívül az AI?)
                  <span title="Ha az AI úgy ítéli meg, hogy a levél megfelel ezeknek a kizáró szabályoknak, automatikusan kiszűri és nem hoz létre feladatot belőle.">
                    <HelpCircle className="h-3.5 w-3.5 text-slate-500 cursor-help" />
                  </span>
                </label>
                <textarea
                  id="exclusion-rules"
                  rows={4}
                  disabled={isSaving}
                  value={exclusionRules}
                  onChange={(e) => setExclusionRules(e.target.value)}
                  placeholder={"Például:\nHírlevelek, marketing e-mailek, automatikus rendszerértesítések.\nNoreply címről érkező levelek.\nBelső céges körlevelek."}
                  className="w-full rounded-xl border border-slate-700 bg-slate-950/70 p-4 text-sm text-slate-300 placeholder-slate-600 shadow-inner transition-colors focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500 disabled:opacity-60"
                />
              </div>

              {/* Save Actions */}
              <div className="flex items-center justify-between border-t border-slate-800/80 pt-6">
                <div className="text-xs text-slate-500">
                  Mentve a Firestore-ba: <code className="text-slate-400">users/{userId}/settings/ai_configuration</code>
                </div>
                <button
                  type="button"
                  onClick={handleSaveAiConfig}
                  disabled={isSaving}
                  className="flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-900/30 transition-all hover:bg-indigo-500 hover:shadow-indigo-800/40 active:scale-95 disabled:scale-100 disabled:cursor-not-allowed disabled:opacity-60"
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
            </div>
          ) : (
            <div className="space-y-6">
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
                <Shield className="h-4 w-4 text-slate-500 shrink-0 mt-0.5" />
                <p className="leading-relaxed">
                  Megjegyzés: Az AI alapvető könyvelési és biztonsági logikája védett, az Ön kiegészítései ezen felül lépnek érvénybe.
                </p>
              </div>

              {/* Save Actions */}
              <div className="flex items-center justify-end border-t border-slate-800/80 pt-6">
                <button
                  type="button"
                  onClick={handleSaveAiConfig}
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
            </div>
          )}
        </div>
      </div>

      {/* SMTP Configuration Card */}
      <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-2xl backdrop-blur-md">
        <div className="absolute -right-24 -top-24 h-48 w-48 rounded-full bg-violet-600/5 blur-3xl" />

        <div className="flex items-center gap-3 border-b border-slate-800/80 pb-4">
          <div className="p-2.5 rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
            <Mail className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-white">Kimenő SMTP (Válaszküldő) Szerver Beállítása</h3>
            <p className="text-xs text-slate-400">Adja meg a kimenő levelek küldéséhez szükséges SMTP hitelesítő adatokat</p>
          </div>
        </div>

        <form onSubmit={handleSaveSmtp} className="mt-6 space-y-4">
          {smtpError && (
            <div className="rounded-lg bg-red-500/15 border border-red-500/20 p-3 text-xs font-medium text-red-400">
              {smtpError}
            </div>
          )}
          {smtpSuccess && (
            <div className="rounded-lg bg-emerald-500/15 border border-emerald-500/20 p-3 text-xs font-medium text-emerald-400">
              {smtpSuccess}
            </div>
          )}

          <div>
            <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider">E-mail cím</label>
            <input
              type="email"
              required
              value={configEmail}
              onChange={(e) => setConfigEmail(e.target.value)}
              placeholder="pl. szabi@gmail.com"
              className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-950/70 p-3 text-xs text-slate-200 placeholder-slate-600 focus:border-violet-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Alkalmazásjelszó / Jelszó</label>
            <input
              type="password"
              required
              value={configPassword}
              onChange={(e) => setConfigPassword(e.target.value)}
              placeholder="••••••••"
              className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-950/70 p-3 text-xs text-slate-200 placeholder-slate-600 focus:border-violet-500 focus:outline-none"
            />
            <p className="text-[10px] text-slate-500 mt-1">
              Gmail/Outlook esetén generált 16 karakteres Alkalmazásjelszó szükséges!
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider">SMTP Kiszolgáló</label>
              <input
                type="text"
                required
                value={smtpHost}
                onChange={(e) => setSmtpHost(e.target.value)}
                placeholder="pl. smtp.gmail.com"
                className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-950/70 p-3 text-xs text-slate-200 placeholder-slate-600 focus:border-violet-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider">SMTP Port</label>
              <input
                type="text"
                required
                value={smtpPort}
                onChange={(e) => setSmtpPort(e.target.value)}
                placeholder="pl. 587 vagy 465"
                className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-950/70 p-3 text-xs text-slate-200 placeholder-slate-600 focus:border-violet-500 focus:outline-none"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={isSmtpSaving}
            className="flex items-center gap-2 rounded-xl bg-violet-600 px-5 py-2.5 text-xs font-semibold text-white shadow-lg transition-all hover:bg-violet-500 active:scale-95 disabled:opacity-55"
          >
            {isSmtpSaving ? 'Mentés…' : 'SMTP Mentése'}
          </button>
        </form>
      </div>

      {/* Incoming Email Activation Card */}
      <div className="relative overflow-hidden rounded-2xl border border-indigo-500/20 bg-indigo-950/20 p-6 shadow-2xl backdrop-blur-md">
        <div className="absolute -right-24 -top-24 h-48 w-48 rounded-full bg-indigo-600/5 blur-3xl" />

        <div className="flex items-center gap-3 border-b border-indigo-500/20 pb-4">
          <div className="p-2.5 rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
            <Inbox className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-white">Bejövő Levelek Aktiválása (E-mail Továbbítás)</h3>
            <p className="text-xs text-slate-400">Levelek automatikus fogadása és feldolgozása</p>
          </div>
        </div>

        <div className="mt-6 space-y-4">
          <p className="text-sm text-slate-300 leading-relaxed">
            Másolja ki ezt az egyedi címet, és állítson be automatikus e-mail továbbítást (Forwarding) a saját levelezőjében (Gmail, Outlook stb.), hogy az AI azonnal fogadhassa a leveleit.
          </p>

          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              readOnly
              value={forwarderEmail}
              className="flex-1 rounded-xl border border-slate-700 bg-slate-950/70 p-3 text-sm font-mono text-indigo-300 shadow-inner focus:outline-none"
            />
            <button
              type="button"
              onClick={handleCopyWebhook}
              className="flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-lg transition-all hover:bg-indigo-500 active:scale-95 whitespace-nowrap"
            >
              {copied ? (
                <>
                  <Check className="h-4.5 w-4.5" />
                  Másolva!
                </>
              ) : (
                <>
                  <Copy className="h-4.5 w-4.5" />
                  Másolás
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
