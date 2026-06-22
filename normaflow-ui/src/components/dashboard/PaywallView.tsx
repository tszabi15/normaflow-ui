import { useState } from 'react'
import { Check, LogOut, Sparkles, Zap, CreditCard } from 'lucide-react'

type SubscriptionTier = 'none' | 'basic' | 'pro' | 'ultra'

interface PricingPlan {
  tier: SubscriptionTier
  name: string
  price: string
  emails: number
  features: string[]
  highlighted?: boolean
}

const PRICING_PLANS: PricingPlan[] = [
  {
    tier: 'basic',
    name: 'Basic',
    price: '8.990',
    emails: 500,
    features: ['500 e-mail / hó', 'AI feladat összegzés', 'Prioritás-sorrendezés', '30 napos kuka'],
  },
  {
    tier: 'pro',
    name: 'Pro',
    price: '14.990',
    emails: 1500,
    features: ['1500 e-mail / hó', 'AI auto-választervezet', 'Ügyfél fehérlista', 'Prioritás riasztások'],
    highlighted: true,
  },
  {
    tier: 'ultra',
    name: 'Ultra',
    price: '39.990',
    emails: 5000,
    features: ['5000 e-mail / hó', 'Teljes automatizáció', 'Dedikált támogatás', 'Audit napló'],
  },
]

interface PaywallViewProps {
  userEmail: string
  onSelectTier: (tier: SubscriptionTier) => Promise<void>
  onLogout: () => void
}

export default function PaywallView({ userEmail, onSelectTier, onLogout }: PaywallViewProps) {
  const [checkingOutTier, setCheckingOutTier] = useState<SubscriptionTier | null>(null)
  const [error, setError] = useState('')

  const handleSelectPlan = async (tier: SubscriptionTier) => {
    setCheckingOutTier(tier)
    setError('')
    try {
      await onSelectTier(tier)
    } catch (err: any) {
      setError(err.message || 'Nem sikerült aktiválni az előfizetést.')
    } finally {
      setCheckingOutTier(null)
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-950 p-6">
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute left-1/2 top-0 h-px w-3/4 -translate-x-1/2 bg-gradient-to-r from-transparent via-indigo-500/30 to-transparent" />
        <div className="absolute left-1/2 top-1/3 h-64 w-64 -translate-x-1/2 rounded-full bg-indigo-600/5 blur-3xl" />
      </div>

      <div className="relative w-full max-w-5xl">
        <div className="mb-8 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600">
              <Zap className="h-4 w-4 text-white" />
            </div>
            <span className="font-bold text-white">NormaFlow</span>
          </div>
          <button
            type="button"
            onClick={onLogout}
            className="flex items-center gap-1.5 text-xs text-slate-500 transition-colors hover:text-slate-300"
          >
            <LogOut className="h-3.5 w-3.5" />
            Kijelentkezés
          </button>
        </div>

        <div className="mb-10 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-500/20">
            <Sparkles className="h-7 w-7 text-indigo-400" />
          </div>
          <h2 className="text-3xl font-bold text-white">Válasszon csomagot</h2>
          <p className="mt-2 text-sm text-slate-400">
            Belépve mint <span className="text-slate-300">{userEmail}</span>
          </p>
          <p className="mt-3 text-sm text-slate-500">
            Az alkalmazás használatához aktív előfizetés szükséges.
          </p>
        </div>

        {error && (
          <div className="mb-6 rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-center text-sm text-red-400">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          {PRICING_PLANS.map((plan) => (
            <div
              key={plan.tier}
              className={`relative flex flex-col rounded-2xl border p-6 shadow-xl transition-all ${
                plan.highlighted
                  ? 'border-indigo-500/50 bg-gradient-to-b from-indigo-950/40 to-slate-900 ring-1 ring-indigo-500/30'
                  : 'border-slate-800 bg-slate-900/80'
              }`}
            >
              {plan.highlighted && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-indigo-600 px-3 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
                  Népszerű
                </span>
              )}
              <h3 className="text-xl font-bold text-white">{plan.name}</h3>
              <div className="mt-3 flex items-baseline gap-1">
                <span className="text-3xl font-bold text-white">{plan.price}</span>
                <span className="text-sm text-slate-400">Ft / hó</span>
              </div>
              <p className="mt-2 text-sm font-medium text-indigo-300">
                {plan.emails.toLocaleString('hu-HU')} e-mail / hó
              </p>

              <ul className="mt-6 flex-1 space-y-3">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2.5 text-sm text-slate-300">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-indigo-400" />
                    {feature}
                  </li>
                ))}
              </ul>

              <button
                type="button"
                onClick={() => handleSelectPlan(plan.tier)}
                disabled={checkingOutTier !== null}
                className={`mt-6 flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-60 ${
                  plan.highlighted
                    ? 'bg-indigo-600 text-white hover:bg-indigo-500 shadow-lg shadow-indigo-900/40'
                    : 'border border-slate-700 bg-slate-950 text-slate-200 hover:border-indigo-500/50 hover:bg-slate-900'
                }`}
              >
                {checkingOutTier === plan.tier ? (
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    Aktiválás…
                  </>
                ) : (
                  <>
                    <CreditCard className="h-4 w-4" />
                    {plan.name} csomag választása
                  </>
                )}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
