import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { auth, db } from '../firebase'
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  GoogleAuthProvider,
  signInWithPopup,
} from 'firebase/auth'
import { doc, getDoc, setDoc, onSnapshot } from 'firebase/firestore'

type SubscriptionTier = 'none' | 'basic' | 'pro' | 'ultra'

interface User {
  email: string
  uid: string
  subscriptionStatus: string
  tier: SubscriptionTier
  processedEmailsThisMonth: number
}

interface AuthContextType {
  user: User | null
  isLoading: boolean
  isAuthenticated: boolean
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string) => Promise<void>
  signInWithGoogle: () => Promise<void>
  logout: () => Promise<void>
  quotaLimit: number
  quotaUsed: number
  quotaRemaining: number
  quotaPercentage: number
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

const TIER_LIMITS: Record<SubscriptionTier, number> = {
  none: 0,
  basic: 500,
  pro: 1500,
  ultra: 5000,
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        const email = firebaseUser.email
        if (email) {
          // Ensure user document exists (only on initial signup or if missing vital properties)
          await ensureUserDocument(email, firebaseUser.uid)

          // Set up real-time quota tracking
          const userRef = doc(db, 'users', email)
          const unsubscribeUser = onSnapshot(userRef, (docSnap) => {
            if (docSnap.exists()) {
              const data = docSnap.data()
              setUser({
                email: data.email || email,
                uid: data.uid || firebaseUser.uid,
                subscriptionStatus: data.subscriptionStatus || 'none',
                tier: data.tier || 'none',
                processedEmailsThisMonth: data.processedEmailsThisMonth || 0,
              })
            }
          })

          return () => unsubscribeUser()
        }
      }
      setUser(null)
      setIsLoading(false)
    })

    return () => unsubscribe()
  }, [])

  const signIn = async (email: string, password: string) => {
    const userCredential = await signInWithEmailAndPassword(auth, email, password)
    await ensureUserDocument(userCredential.user.email || email, userCredential.user.uid)
  }

  const signUp = async (email: string, password: string) => {
    const userCredential = await createUserWithEmailAndPassword(auth, email, password)
    await ensureUserDocument(userCredential.user.email || email, userCredential.user.uid)
  }

  const signInWithGoogle = async () => {
    const provider = new GoogleAuthProvider()
    const result = await signInWithPopup(auth, provider)
    await ensureUserDocument(result.user.email || '', result.user.uid)
  }

  const logout = async () => {
    await signOut(auth)
    setUser(null)
  }

  const quotaLimit = user ? TIER_LIMITS[user.tier] : 0
  const quotaUsed = user?.processedEmailsThisMonth || 0
  const quotaRemaining = Math.max(0, quotaLimit - quotaUsed)
  const quotaPercentage = quotaLimit > 0 ? (quotaUsed / quotaLimit) * 100 : 0

  const value: AuthContextType = {
    user,
    isLoading,
    isAuthenticated: !!user,
    signIn,
    signUp,
    signInWithGoogle,
    logout,
    quotaLimit,
    quotaUsed,
    quotaRemaining,
    quotaPercentage,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
