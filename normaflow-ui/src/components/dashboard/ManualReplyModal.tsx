import { useState } from 'react'
import { Mail, X, AlertTriangle, Sparkles, Check } from 'lucide-react'
import { auth } from '../../firebase'
import type { Task } from '../../types/task'

interface ManualReplyModalProps {
  replyTask: Task | null
  userEmail: string
  onClose: () => void
  onReplySent: () => void
  onNavigateToAutomation: () => void
  onToastAdd: (toast: { id: string; message: string; taskSummary: string }) => void
}

export default function ManualReplyModal({
  replyTask,
  userEmail,
  onClose,
  onReplySent,
  onNavigateToAutomation,
  onToastAdd,
}: ManualReplyModalProps) {
  const [replyRecipient, setReplyRecipient] = useState(replyTask?.sender || '')
  const [replySubject, setReplySubject] = useState(
    replyTask?.subject.startsWith('Re:') ? replyTask.subject : `Re: ${replyTask?.subject || ''}`
  )
  const [replyBody, setReplyBody] = useState(replyTask?.ai_reply || '')
  const [isImprovingDraft, setIsImprovingDraft] = useState(false)
  const [isSendingReply, setIsSendingReply] = useState(false)
  const [replyError, setReplyError] = useState<{ code: string; message: string } | null>(null)

  const handleImproveDraft = async () => {
    if (!replyBody.trim()) return
    setIsImprovingDraft(true)
    try {
      const user = auth.currentUser
      if (!user) throw new Error('Nincs bejelentkezve')

      const token = await user.getIdToken()
      const response = await fetch(`${import.meta.env.VITE_API_BASE_URL}/improveDraft`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ text: replyBody }),
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.message || 'Hiba történt')
      }

      const data = await response.json()
      if (data.text) {
        setReplyBody(data.text)
        const toastId = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
        onToastAdd({
          id: toastId,
          message: 'Választervezet feljavítva',
          taskSummary: 'AI segítségével',
        })
      }
    } catch (err: any) {
      console.error('Improve draft error:', err)
      alert('Hiba történt a választervezet feljavítása közben.')
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
    setReplyError(null)
    try {
      const user = auth.currentUser
      if (!user) throw new Error('Nincs bejelentkezve')

      const token = await user.getIdToken()
      const response = await fetch(`${import.meta.env.VITE_API_BASE_URL}/sendAiReply`, {
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
        setReplyError({ code: errorData.code || 'UNKNOWN_ERROR', message: errorData.message || 'Sikertelen e-mail küldés.' })
        throw new Error(errorData.message || 'Sikertelen e-mail küldés.')
      }

      onClose()
      onReplySent()

      const toastId = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
      onToastAdd({
        id: toastId,
        message: 'E-mail elküldve',
        taskSummary: `Sikeres válasz a következőnek: ${replyRecipient}`,
      })
    } catch (err: any) {
      console.error('Send manual reply error:', err)
      if (!replyError) {
        alert('Hiba történt az e-mail küldése közben.')
      }
    } finally {
      setIsSendingReply(false)
    }
  }

  if (!replyTask) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
      <div className="w-full max-w-2xl overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/90 shadow-2xl backdrop-blur-md transition-all duration-300">
        {/* Modal Header */}
        <div className="flex flex-col border-b border-slate-800 px-6 py-4 gap-1 bg-slate-900/40">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Mail className="h-5 w-5 text-indigo-400" />
              <h3 className="text-base font-bold text-white">Manuális válasz küldése</h3>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="flex items-center mt-1">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-500/10 border border-indigo-500/20 px-2.5 py-0.5 text-xs font-medium text-indigo-300">
              Küldő fiók: <span className="font-mono text-white">{replyTask.source_mailbox || replyTask.source_email || userEmail || ''}</span>
            </span>
          </div>
        </div>

        {/* Modal Body */}
        <div className="space-y-4 p-6">
          {replyError?.code === 'SMTP_NOT_CONFIGURED' && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-xs text-red-400 animate-fade-in">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <div className="space-y-2">
                  <p className="font-medium leading-normal">
                    Nem tudunk levelet küldeni a(z) <strong className="text-white font-mono">{replyTask.source_mailbox || replyTask.source_email || ''}</strong> címről, mert még nem kapcsolta össze az SMTP kimenő szervert az AI Automatizáció menüpontban.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      onClose()
                      onNavigateToAutomation()
                    }}
                    className="inline-flex items-center gap-1 font-bold underline hover:text-red-300 transition-colors"
                  >
                    <span>Ugrás az SMTP Beállításokhoz &rarr;</span>
                  </button>
                </div>
              </div>
            </div>
          )}

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
            onClick={onClose}
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
  )
}
