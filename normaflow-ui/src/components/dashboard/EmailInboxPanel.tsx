import { useState, useEffect } from 'react'
import { collection, query, where, onSnapshot, doc, updateDoc } from 'firebase/firestore'
import { db, auth } from '../../firebase'
import { Inbox, Sparkles, Loader2, Mail, Filter, Eye, Trash2 } from 'lucide-react'

interface Email {
  id: string
  sender: string
  subject: string
  textContent: string
  received_at: string
  status: 'unread' | 'read' | 'processed' | 'filtered'
  source_mailbox: string
  received_via: string
}

interface EmailInboxPanelProps {
  userId: string
}

export default function EmailInboxPanel({ userId }: EmailInboxPanelProps) {
  const [emails, setEmails] = useState<Email[]>([])
  const [selectedEmail, setSelectedEmail] = useState<Email | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const [processResult, setProcessResult] = useState<{ type: 'success' | 'filtered' | 'error'; message: string } | null>(null)
  const [filterStatus, setFilterStatus] = useState<'active' | 'filtered'>('active')

  // Real-time Firestore listener
  useEffect(() => {
    if (!userId) return

    const statusFilter = filterStatus === 'active' ? ['unread', 'read'] : ['filtered']
    const q = query(
      collection(db, 'emails'),
      where('user_id', '==', userId),
      where('status', 'in', statusFilter)
    )

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const fetched: Email[] = snapshot.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      })) as Email[]

      // Sort by received_at descending
      fetched.sort((a, b) => (b.received_at || '').localeCompare(a.received_at || ''))
      setEmails(fetched)
    })

    return () => unsubscribe()
  }, [userId, filterStatus])

  const handleSelectEmail = async (email: Email) => {
    setSelectedEmail(email)
    setProcessResult(null)

    // Mark as read if unread
    if (email.status === 'unread') {
      try {
        await updateDoc(doc(db, 'emails', email.id), { status: 'read' })
      } catch (err) {
        console.error('Failed to mark email as read:', err)
      }
    }
  }

  const handleProcessWithAi = async () => {
    if (!selectedEmail) return
    setIsProcessing(true)
    setProcessResult(null)

    try {
      const token = await auth.currentUser?.getIdToken(true)
      const res = await fetch('https://api-cdaanjspxq-uc.a.run.app/processEmailWithAi', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token || ''}`,
        },
        body: JSON.stringify({ emailId: selectedEmail.id }),
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Feldolgozási hiba.')

      if (data.status === 'filtered') {
        setProcessResult({ type: 'filtered', message: `Kiszűrve: ${data.reason || 'AI szűrő'}` })
      } else {
        setProcessResult({ type: 'success', message: `Feladat létrehozva (${data.taskId})` })
      }

      // Deselect since the email moved to processed/filtered
      setSelectedEmail(null)
    } catch (err: any) {
      setProcessResult({ type: 'error', message: err.message || 'Hiba a feldolgozás során.' })
    } finally {
      setIsProcessing(false)
    }
  }

  const handleDeleteEmail = async (emailId: string) => {
    if (!emailId) return
    setIsProcessing(true)
    setProcessResult(null)

    // Optimistic UI update: remove it from selected email if that's the one being deleted
    if (selectedEmail?.id === emailId) {
      setSelectedEmail(null)
    }

    try {
      const token = await auth.currentUser?.getIdToken(true)
      const res = await fetch(`https://api-cdaanjspxq-uc.a.run.app/emails/${emailId}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token || ''}`,
        },
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Törlési hiba.')

      setProcessResult({ type: 'success', message: 'E-mail törölve' })
    } catch (err: any) {
      setProcessResult({ type: 'error', message: err.message || 'Hiba a törlés során.' })
    } finally {
      setIsProcessing(false)
    }
  }

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-5">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
            <Inbox className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-white">Bejövő levelek</h2>
            <p className="text-xs text-slate-500">{emails.length} levél</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Filter toggle */}
          <button
            type="button"
            onClick={() => { setFilterStatus('active'); setSelectedEmail(null) }}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
              filterStatus === 'active'
                ? 'bg-indigo-600 text-white'
                : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
            }`}
          >
            <Mail className="h-3.5 w-3.5" />
            Aktív
          </button>
          <button
            type="button"
            onClick={() => { setFilterStatus('filtered'); setSelectedEmail(null) }}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
              filterStatus === 'filtered'
                ? 'bg-amber-600 text-white'
                : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
            }`}
          >
            <Filter className="h-3.5 w-3.5" />
            Kiszűrt
          </button>
        </div>
      </div>

      {/* Result notification */}
      {processResult && (
        <div className={`mb-4 rounded-xl border p-3 text-xs font-medium ${
          processResult.type === 'success'
            ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
            : processResult.type === 'filtered'
            ? 'bg-amber-500/10 border-amber-500/20 text-amber-400'
            : 'bg-red-500/10 border-red-500/20 text-red-400'
        }`}>
          {processResult.message}
        </div>
      )}

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Left: Email List */}
        <div className="lg:col-span-2 overflow-hidden rounded-xl border border-slate-800 bg-slate-900/50 backdrop-blur-sm">
          <div className="max-h-[70vh] overflow-y-auto divide-y divide-slate-800/60">
            {emails.length === 0 ? (
              <div className="p-8 text-center text-slate-500 text-xs font-medium">
                {filterStatus === 'active' ? 'Nincs új bejövő levél.' : 'Nincs kiszűrt levél.'}
              </div>
            ) : (
              emails.map((email) => (
                <button
                  key={email.id}
                  type="button"
                  onClick={() => handleSelectEmail(email)}
                  className={`w-full text-left p-4 transition-all hover:bg-slate-800/50 ${
                    selectedEmail?.id === email.id ? 'bg-slate-800/70 border-l-2 border-l-indigo-500' : ''
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {/* Unread indicator */}
                    <div className="mt-1.5 shrink-0">
                      {email.status === 'unread' ? (
                        <div className="h-2.5 w-2.5 rounded-full bg-indigo-500 shadow-lg shadow-indigo-500/50" />
                      ) : email.status === 'filtered' ? (
                        <Filter className="h-3 w-3 text-amber-500" />
                      ) : (
                        <Eye className="h-3 w-3 text-slate-600" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className={`text-xs truncate ${email.status === 'unread' ? 'font-bold text-white' : 'font-medium text-slate-300'}`}>
                        {email.sender || 'Ismeretlen feladó'}
                      </p>
                      <p className={`text-sm truncate mt-0.5 ${email.status === 'unread' ? 'font-semibold text-slate-100' : 'text-slate-400'}`}>
                        {email.subject}
                      </p>
                      <p className="text-[11px] text-slate-600 mt-1 line-clamp-2 leading-relaxed">
                        {email.textContent?.substring(0, 120) || ''}
                      </p>
                      <p className="text-[10px] text-slate-600 mt-1.5 font-mono">
                        {email.received_at ? new Date(email.received_at).toLocaleString('hu-HU') : ''}
                      </p>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Right: Detail View */}
        <div className="lg:col-span-3 overflow-hidden rounded-xl border border-slate-800 bg-slate-900/50 backdrop-blur-sm">
          {selectedEmail ? (
            <div className="flex flex-col h-full">
              {/* Detail Header */}
              <div className="border-b border-slate-800 p-5 space-y-2 bg-slate-900/40">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-base font-bold text-white truncate">{selectedEmail.subject}</h3>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleDeleteEmail(selectedEmail.id)}
                      disabled={isProcessing}
                      className="flex items-center gap-2 rounded-xl bg-slate-800 border border-slate-700/60 px-4 py-2 text-xs font-semibold text-rose-400 hover:bg-slate-700 active:scale-95 disabled:opacity-55 disabled:cursor-not-allowed"
                      title="E-mail Törlése"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Törlés
                    </button>
                    {filterStatus === 'active' && (
                      <button
                        type="button"
                        onClick={handleProcessWithAi}
                        disabled={isProcessing}
                        className="flex items-center gap-2 shrink-0 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-indigo-900/30 transition-all hover:bg-indigo-500 active:scale-95 disabled:opacity-55 disabled:cursor-not-allowed"
                      >
                        {isProcessing ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            Feldolgozás…
                          </>
                        ) : (
                          <>
                            <Sparkles className="h-3.5 w-3.5" />
                            Feldolgozás AI Asszisztenssel
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3 text-xs text-slate-400">
                  <span><strong className="text-slate-300">Feladó:</strong> {selectedEmail.sender}</span>
                  <span className="text-slate-700">•</span>
                  <span className="font-mono">{selectedEmail.received_at ? new Date(selectedEmail.received_at).toLocaleString('hu-HU') : ''}</span>
                  <span className="text-slate-700">•</span>
                  <span className="text-[10px]">{selectedEmail.source_mailbox}</span>
                </div>
              </div>

              {/* Detail Body */}
              <div className="flex-1 overflow-y-auto p-5 max-h-[55vh]">
                <pre className="text-sm text-slate-300 whitespace-pre-wrap font-sans leading-relaxed">
                  {selectedEmail.textContent || 'Nincs szöveges tartalom.'}
                </pre>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full min-h-[300px] text-center p-8">
              <div className="p-4 rounded-2xl bg-slate-800/50 mb-4">
                <Mail className="h-8 w-8 text-slate-600" />
              </div>
              <p className="text-sm font-semibold text-slate-500">Válasszon ki egy levelet a listából</p>
              <p className="text-xs text-slate-600 mt-1">A részletek és az AI feldolgozás itt jelenik meg.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
