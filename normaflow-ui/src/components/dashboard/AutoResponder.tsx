import { useState, useEffect } from 'react'
import { Sparkles, Save, Loader2, HelpCircle, Shield, Mail, Check, Copy, Inbox } from 'lucide-react'
import { doc, getDoc, setDoc, onSnapshot, collection } from 'firebase/firestore'
import { db } from '../../firebase'
import AiPromptSettings from './AiPromptSettings'

interface AutoResponderProps {
  initialEnabled: boolean
  initialRules: string
  initialGlobalAutomation: boolean
  initialExclusionRules: string
  onSave: (rules: string, enabled: boolean, globalAutomation: boolean, exclusionRules: string) => Promise<void> | void
  limitExceeded?: boolean
  userEmail: string
  userId: string
}

export default function AutoResponder({
  initialEnabled,
  initialRules,
  initialGlobalAutomation,
  initialExclusionRules,
  onSave,
  limitExceeded = false,
  userEmail,
  userId,
}: AutoResponderProps) {
  // AI responder rules states
  const [rules, setRules] = useState(initialRules)
  const [isEnabled, setIsEnabled] = useState(initialEnabled)
  const [globalAutomation, setGlobalAutomation] = useState(initialGlobalAutomation)
  const [exclusionRules, setExclusionRules] = useState(initialExclusionRules)
  const [isSaving, setIsSaving] = useState(false)

  // SMTP form states
  const [configEmail, setConfigEmail] = useState('')
  const [configPassword, setConfigPassword] = useState('')
  const [smtpHost, setSmtpHost] = useState('')
  const [smtpPort, setSmtpPort] = useState('587')
  const [isSmtpSaving, setIsSmtpSaving] = useState(false)
  const [smtpError, setSmtpError] = useState('')
  const [smtpSuccess, setSmtpSuccess] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setRules(initialRules)
    setIsEnabled(initialEnabled && !limitExceeded)
    setGlobalAutomation(initialGlobalAutomation)
    setExclusionRules(initialExclusionRules)
  }, [initialRules, initialEnabled, limitExceeded, initialGlobalAutomation, initialExclusionRules])

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

  const handleSave = async () => {
    setIsSaving(true)
    await new Promise((resolve) => setTimeout(resolve, 800))
    await onSave(rules, isEnabled, globalAutomation, exclusionRules)
    setIsSaving(false)
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

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6 animate-fade-in space-y-8">
      {/* 1. AI Automatizáció Settings Card */}
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
              disabled={isSaving || limitExceeded}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-slate-900 ${
                isEnabled && !limitExceeded ? 'bg-indigo-600' : 'bg-slate-700'
              } ${limitExceeded ? 'opacity-45 cursor-not-allowed' : ''}`}
              aria-checked={isEnabled && !limitExceeded}
              role="switch"
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                  isEnabled && !limitExceeded ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
            <span
              className={`text-xs font-bold uppercase ${
                limitExceeded ? 'text-rose-400' : (isEnabled ? 'text-indigo-400' : 'text-slate-500')
              }`}
            >
              {limitExceeded ? 'LIMIT ELÉRVE' : (isEnabled ? 'BE' : 'KI')}
            </span>
          </div>
        </div>

        {/* Form Content */}
        <div className="relative z-10 mt-6 space-y-6">
          {/* Global Automation Toggle */}
          <div className="rounded-xl border border-violet-500/20 bg-violet-950/15 p-4 flex items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <Shield className="h-5 w-5 shrink-0 text-violet-400 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-white">Teljesen autonóm háttér-feldolgozás</p>
                <p className="mt-0.5 text-xs text-slate-400">
                  Ha aktív, a rendszer az e-mail továbbítás (Webhook) során azonnal feldolgozza az új e-maileket az AI asszisztenssel — manuális beavatkozás nélkül.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setGlobalAutomation(!globalAutomation)}
              disabled={isSaving}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-violet-500 focus:ring-offset-2 focus:ring-offset-slate-900 ${
                globalAutomation ? 'bg-violet-600' : 'bg-slate-700'
              }`}
              role="switch"
              aria-checked={globalAutomation}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                  globalAutomation ? 'translate-x-5' : 'translate-x-0'
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

          {/* Prompt Rules */}
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
              placeholder={"Például:\nHa az ügyfél számlát vagy bizonylatot kér, válaszolj udvariasan, hogy feldolgozzuk és küldjük.\nHa NAV levélről van szó, jelezd, hogy szakértőnk felülvizsgálja és 24 órán belül válaszol.\nMinden választ írj alá így: NormaFlow AI Asszisztens."}
              className="w-full rounded-xl border border-slate-700 bg-slate-950/70 p-4 text-sm text-slate-300 placeholder-slate-600 shadow-inner transition-colors focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-60"
            />
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
                  Mentés…
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

      {/* Custom AI rules configuration */}
      <AiPromptSettings userId={userId} />

      {/* 2. Outgoing SMTP Config Card */}
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
                className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-950/70 p-3 text-xs text-slate-200 focus:border-violet-500 focus:outline-none"
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

      {/* 3. Bejövő Levelek Aktiválása (Forwarder Guide) Card */}
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
