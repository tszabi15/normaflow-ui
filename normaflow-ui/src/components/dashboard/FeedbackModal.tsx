import React, { useState } from 'react'
import { X, Lightbulb } from 'lucide-react'

interface FeedbackModalProps {
  isOpen: boolean
  onClose: () => void
  onSubmit: (title: string, category: string, description: string) => void
  userEmail: string
}

type FeedbackCategory = 'Új funkció' | 'Hiba' | 'Dizájn javaslat'

export default function FeedbackModal({
  isOpen,
  onClose,
  onSubmit,
  userEmail,
}: FeedbackModalProps) {
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState<FeedbackCategory>('Új funkció')
  const [description, setDescription] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  if (!isOpen) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim() || !description.trim()) return

    setIsSubmitting(true)

    try {
      let mappedCategory = 'Feature'
      if (category === 'Hiba') {
        mappedCategory = 'Bug'
      } else if (category === 'Dizájn javaslat') {
        mappedCategory = 'Design'
      }

      const response = await fetch('https://handlefeedbacksubmit-cdaanjspxq-uc.a.run.app', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: title.trim(),
          category: mappedCategory,
          description: description.trim(),
          user_email: userEmail,
        }),
      })

      if (!response.ok) {
        throw new Error(`Feedback submission failed with status: ${response.status}`)
      }

      // Trigger success callback (triggers toast in parent)
      onSubmit(title.trim(), category, description.trim())

      // Reset form fields
      setTitle('')
      setCategory('Új funkció')
      setDescription('')
      onClose()
    } catch (error) {
      console.error('Error submitting feedback:', error)
      alert('Hiba történt a visszajelzés beküldése során. Kérjük, próbálja meg újra!')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-md transition-all duration-300"
    >
      {/* Click outside to close */}
      <div
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />

      {/* Modal Container */}
      <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-slate-700/50 bg-slate-900/80 p-6 shadow-2xl backdrop-blur-xl transition-all duration-300 animate-scale-up">
        {/* Glow behind title */}
        <div className="absolute -left-20 -top-20 h-40 w-40 rounded-full bg-amber-500/10 blur-3xl" />

        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-slate-800/80 pb-4">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/20 text-amber-400">
              <Lightbulb className="h-4 w-4" />
            </div>
            <h3 className="text-lg font-bold text-white">Ötlet beküldése</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200"
            aria-label="Modal bezárása"
          >
            <X className="h-4.5 w-4.5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          {/* Title */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="feedback-title" className="text-xs font-semibold text-slate-300">
              Ötlet címe
            </label>
            <input
              id="feedback-title"
              type="text"
              required
              disabled={isSubmitting}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Pl. Automatikus emlékeztető kiküldése..."
              className="w-full rounded-xl border border-slate-700 bg-slate-950/60 px-3.5 py-2 text-sm text-slate-200 placeholder-slate-600 shadow-inner transition-colors focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-60"
            />
          </div>

          {/* Category */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="feedback-category" className="text-xs font-semibold text-slate-300">
              Kategória
            </label>
            <select
              id="feedback-category"
              disabled={isSubmitting}
              value={category}
              onChange={(e) => setCategory(e.target.value as FeedbackCategory)}
              className="w-full rounded-xl border border-slate-700 bg-slate-950/60 px-3.5 py-2 text-sm text-slate-200 shadow-inner transition-colors focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-60"
            >
              <option value="Új funkció">Új funkció</option>
              <option value="Hiba">Hiba</option>
              <option value="Dizájn javaslat">Dizájn javaslat</option>
            </select>
          </div>

          {/* Description */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="feedback-desc" className="text-xs font-semibold text-slate-300">
              Részletes leírás
            </label>
            <textarea
              id="feedback-desc"
              required
              rows={4}
              disabled={isSubmitting}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Mutasd be részletesen a javaslatod, miért lenne hasznos..."
              className="w-full rounded-xl border border-slate-700 bg-slate-950/60 px-3.5 py-2 text-sm text-slate-200 placeholder-slate-600 shadow-inner transition-colors focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-60"
            />
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 border-t border-slate-800/80 pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="rounded-xl border border-slate-700 px-4 py-2 text-xs font-semibold text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200 disabled:opacity-60"
            >
              Mégse
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !title.trim() || !description.trim()}
              className="flex items-center gap-1.5 rounded-xl bg-amber-500 px-4 py-2 text-xs font-bold text-slate-950 shadow-lg shadow-amber-500/20 transition-all hover:bg-amber-400 hover:shadow-amber-400/30 active:scale-95 disabled:scale-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSubmitting ? 'Küldés...' : 'Ötlet beküldése'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
