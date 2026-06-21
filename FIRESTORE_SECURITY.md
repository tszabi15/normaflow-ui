# Firestore Security Architecture Documentation

This document describes the authorization policies and security structure of the NormaFlow Cloud Firestore database.

## Security Policies & Principles

1. **Strict Data Isolation:**
   - Every collection containing user-specific data is protected by resource ownership validation. Users can only access documents mapped to their verified identity (matching their ID token claims).

2. **Billing and Paywall Protection:**
   - Client-side modifications of subscription statuses, tiers, and processed emails quotas on the `/users/{email}` collection are strictly prohibited.
   - Any subscription level mutations must go through server-side logic (e.g., checkout verify API hooks).

---

## Collection Rules

### 1. `/users/{email}`
- **Read:** Only the authenticated owner matching the document ID (`request.auth.token.email`) is allowed to read.
- **Create:** Allowed if the owner is initializing their profile, setting `subscriptionStatus` to `'none'`, `tier` to `'none'`, and `processedEmailsThisMonth` to `0`.
- **Update:** Allowed for user profile customizations, but explicitly blocks modifications to billing fields (`subscriptionStatus`, `tier`, `processedEmailsThisMonth`).
- **Delete:** Denied.

### 2. `/users/{email}/email_connections` & `/users/{email}/clients` & `/users/{email}/settings`
- **Read/Write:** Inherited owner check (`request.auth.token.email == email`).

### 3. `/tasks/{taskId}`
- **Read/Write:** Restricted to the owner whose email matches `resource.data.user_email` (or `request.resource.data.user_email` on create).

### 4. `/emails/{emailId}`
- **Read/Write:** Restricted to the owner whose UID matches the email document's `user_id`.

### 5. `/feedbacks/{feedbackId}`
- **Read/Write:** Denied for all client-side requests. Feedbacks are ingested exclusively through backend service APIs using Firebase Admin SDK privileges.
