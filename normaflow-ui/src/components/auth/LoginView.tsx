import { useState } from 'react'
import { Check, Zap, Shield } from 'lucide-react'
import { auth } from '../../firebase'
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithPopup,
} from 'firebase/auth'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { db } from '../../firebase'

interface LoginViewProps {
  onAuthenticated: () => void
}

async function ensureUserDocument(email: string, uid?: string): Promise<void> {
  const userRef = doc(db, 'users', email)
  const snap = await getDoc(userRef)
  
  // Only write if document doesn't exist (initial signup) or if vital properties are missing
  if (!snap.exists()) {
    await setDoc(userRef, {
      email,
      uid: uid || '',
      subscriptionStatus: 'none',
      tier: 'none',
      processedEmailsThisMonth: 0,
      createdAt: new Date().toISOString(),
    })
  } else if (uid && !snap.data().uid) {
    // Only update UID if it's missing
    await setDoc(userRef, { uid }, { merge: true })
  }
}

export default function LoginView({ onAuthenticated }: LoginViewProps) {
  const [isLoading, setIsLoading] = useState(false)
  const [isSignUp, setIsSignUp] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  const completeSignIn = async (signedInEmail: string, uid?: string) => {
    await ensureUserDocument(signedInEmail, uid)
    onAuthenticated()
  }

  const handleEmailPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim() || !password.trim()) return
    setIsLoading(true)
    setError('')
    try {
      if (isSignUp) {
        const userCredential = await createUserWithEmailAndPassword(auth, email, password)
        await ensureUserDocument(userCredential.user.email || email, userCredential.user.uid)
        onAuthenticated()
      } else {
        const userCredential = await signInWithEmailAndPassword(auth, email, password)
        await completeSignIn(userCredential.user.email || email, userCredential.user.uid)
      }
    } catch (err: any) {
      let errMsg = err.message
      if (err.code === 'auth/user-not-found' || err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
        errMsg = 'Érvénytelen e-mail cím vagy jelszó.'
      } else if (err.code === 'auth/email-already-in-use') {
        errMsg = 'Ez az e-mail cím már használatban van.'
      } else if (err.code === 'auth/weak-password') {
        errMsg = 'A jelszónak legalább 6 karakterből kell állnia.'
      }
      setError(errMsg)
    } finally {
      setIsLoading(false)
    }
  }

  const handleGoogleLogin = async () => {
    setIsLoading(true)
    setError('')
    try {
      const provider = new GoogleAuthProvider()
      const result = await signInWithPopup(auth, provider)
      await ensureUserDocument(result.user.email || '', result.user.uid)
      onAuthenticated()
    } catch (err: any) {
      if (err.code === 'auth/popup-closed-by-user') {
        setError('A Google bejelentkezés megszakítva.')
      } else {
        setError(err.message || 'Google bejelentkezés sikertelen.')
      }
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen bg-slate-950">
      {/* Left — Brand */}
      <div className="relative hidden flex-1 flex-col justify-between overflow-hidden p-12 lg:flex">
        <div className="absolute inset-0 bg-gradient-to-br from-indigo-950/40 via-slate-950 to-slate-950" />
        <div className="absolute -left-32 top-1/4 h-96 w-96 rounded-full bg-indigo-600/10 blur-3xl" />
        <div className="absolute -right-16 bottom-1/4 h-64 w-64 rounded-full bg-violet-600/10 blur-3xl" />

        <div className="relative z-10">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600">
              <Zap className="h-5 w-5 text-white" />
            </div>
            <span className="text-xl font-bold tracking-tight text-white">NormaFlow</span>
          </div>
        </div>

        <div className="relative z-10 max-w-lg">
          <h1 className="text-4xl font-bold leading-tight tracking-tight text-white xl:text-5xl">
            Intelligens könyvelési munkafolyamat automatizálás
          </h1>
          <p className="mt-6 text-lg leading-relaxed text-slate-400">
            Az e-mailekből automatikusan kinyert, priorizált feladatok egyetlen
            munkaterületen. Kevesebb adminisztráció, több idő az ügyfelekre.
          </p>

          <div className="mt-10 space-y-4">
            {[
              'NAV értesítések azonnali kiemelése',
              'Automatikus prioritás-sorrendezés',
              'Valós idejű feladat-stream',
            ].map((feature) => (
              <div key={feature} className="flex items-center gap-3">
                <div className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-500/20">
                  <Check className="h-3.5 w-3.5 text-indigo-400" />
                </div>
                <span className="text-sm text-slate-300">{feature}</span>
              </div>
            ))}
          </div>
        </div>

        <p className="relative z-10 text-xs text-slate-600">
          © 2026 NormaFlow Kft. · Magyar könyvelőknek, magyar könyvelőktől.
        </p>
      </div>

      {/* Right — Login Card */}
      <div className="flex flex-1 items-center justify-center p-6 sm:p-12">
        <div className="w-full max-w-md">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600">
              <Zap className="h-4 w-4 text-white" />
            </div>
            <span className="text-lg font-bold text-white">NormaFlow</span>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-8 shadow-2xl backdrop-blur-sm">
            <div className="mb-2 flex items-center gap-2">
              <Shield className="h-4 w-4 text-indigo-400" />
              <span className="text-xs font-medium uppercase tracking-wider text-indigo-400">
                Biztonságos belépés
              </span>
            </div>
            <h2 className="text-2xl font-bold text-white">
              {isSignUp ? 'Regisztráció' : 'Üdvözöljük vissza'}
            </h2>
            <p className="mt-2 text-sm text-slate-400">
              {isSignUp
                ? 'Hozza létre fiókját az intelligens könyvelői felület használatához.'
                : 'Jelentkezzen be a munkaterület eléréséhez.'}
            </p>

            {error && (
              <div className="mt-4 rounded-lg bg-red-500/15 border border-red-500/20 p-3 text-xs font-medium text-red-400">
                {error}
              </div>
            )}

            <form onSubmit={handleEmailPasswordSubmit} className="mt-6 space-y-4">
                <div>
                  <label htmlFor="email-input" className="block text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    E-mail cím
                  </label>
                  <input
                    id="email-input"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="kovacs.kata@normaflow.hu"
                    className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-950/70 p-3.5 text-sm text-slate-200 placeholder-slate-600 shadow-inner focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>

                <div>
                  <label htmlFor="password-input" className="block text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Jelszó
                  </label>
                  <input
                    id="password-input"
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-950/70 p-3.5 text-sm text-slate-200 placeholder-slate-600 shadow-inner focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>

                <button
                  type="submit"
                  disabled={isLoading}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-6 py-3.5 text-sm font-semibold text-white shadow-lg shadow-indigo-900/30 transition-all hover:bg-indigo-500 hover:shadow-indigo-800/40 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isLoading ? (
                    <span className="flex items-center gap-2">
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-indigo-400 border-t-white" />
                      Feldolgozás…
                    </span>
                  ) : isSignUp ? (
                    'Regisztráció'
                  ) : (
                    'Belépés'
                  )}
                </button>

                <div className="relative flex py-2 items-center">
                  <div className="flex-grow border-t border-slate-800"></div>
                  <span className="flex-shrink mx-4 text-[10px] uppercase font-semibold text-slate-600 tracking-wider">vagy</span>
                  <div className="flex-grow border-t border-slate-800"></div>
                </div>

                <button
                  type="button"
                  onClick={handleGoogleLogin}
                  disabled={isLoading}
                  className="flex w-full items-center justify-center gap-3 rounded-xl border border-slate-700 bg-white px-6 py-3.5 text-sm font-semibold text-slate-900 transition-all hover:bg-slate-100 hover:shadow-lg disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <svg className="h-5 w-5" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                      fill="#4285F4"
                    />
                    <path
                      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                      fill="#34A853"
                    />
                    <path
                      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                      fill="#FBBC05"
                    />
                    <path
                      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                      fill="#EA4335"
                    />
                  </svg>
                  Belépés Google fiókkal
                </button>

                <div className="mt-6 text-center">
                  <button
                    type="button"
                    onClick={() => {
                      setIsSignUp(!isSignUp)
                      setError('')
                    }}
                    className="text-xs font-semibold text-indigo-400 hover:underline"
                  >
                    {isSignUp ? 'Már van fiókja? Belépés' : 'Nincs még fiókja? Regisztráció'}
                  </button>
                </div>
              </form>

            <p className="mt-6 text-center text-xs text-slate-600">
              A belépéssel elfogadja az{' '}
              <span className="text-slate-500 underline decoration-slate-700">
                Általános Szerződési Feltételeket
              </span>
              .
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
