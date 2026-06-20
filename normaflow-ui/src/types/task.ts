export type TaskCategory =
  | 'NAV / Hivatalos'
  | 'Sürgős teendő'
  | 'Számla / Bizonylat'
  | 'Ügyfél kérdés'
  | 'E-mail'

export type TaskStatus = 'pending' | 'completed'

export type TaskPriority = 1 | 2 | 3 | 4 | 5

export interface Task {
  id: string
  category: TaskCategory
  summary: string
  next_step: string
  priority: TaskPriority
  received_at: string
  sender: string
  subject: string
  user_email: string
  status: TaskStatus
  ai_reply?: string
  ai_status?: 'idle' | 'generating' | 'sent'
}
