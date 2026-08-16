# @conovo/react

Embedded contract components for [Conovo](https://conovo.co). Your
users import a contract they already use, AI proposes the dynamic fields,
they confirm — then sending a filled, validated, signable PDF is one click,
from inside your product.

```bash
npm install @conovo/react
```

## Setup

Wrap the contract surfaces of your app in the provider. `getSession` calls
**your server**, which mints tokens with `@conovo/node` — your secret key
never reaches the browser.

```tsx
import { ConovoProvider } from "@conovo/react";
import "@conovo/react/styles.css";

<ConovoProvider
  apiUrl="https://api.conovo.co"
  getSession={async () => {
    const res = await fetch("/api/conovo/session", { method: "POST" });
    if (!res.ok) throw Object.assign(new Error("locked"), await res.json());
    return res.json(); // { token, expiresAt }
  }}
  lockedFallback={<UpgradePrompt />} // rendered on 402 (subscription lapsed)
>
  {children}
</ConovoProvider>
```

## Components

```tsx
// Import + review: upload → AI proposals → highlight-and-confirm → template.
// Includes the "Contract check-up" (gaps/risks with accept/reject clause
// redlines — automated suggestions, not legal advice).
<ContractStudio onConfirmed={({ autoFillCount, fieldCount }) => ...} />

// One-click send on your record's page. `subject` is your own JSON — fields
// bound during setup fill from it automatically.
<SendContract
  subject={{ customer, project }}
  defaultRecipient={{ name: customer.name, email: customer.email }}
  onSent={(contractId) => ...}
/>

// Bulk: CSV upload → AI column mapping (user confirms) → pre-flight table →
// send with live progress, pause/resume.
<BulkSend recipientRole="client" />

// Every contract with live signing status.
<ContractInbox renderItemActions={(contract, refresh) => <YourActions />} />

// Set-once standing values (payment terms, business address …) that
// auto-fill every contract.
<StandingTerms />
```

## Theming

Styles ship scoped under `.conovo` and read CSS variables — override them
to match your product:

```css
.conovo {
  --cv-accent: #6d28d9;
  --cv-radius: 6px;
  /* --cv-ink, --cv-muted, --cv-panel, --cv-line, --cv-good, --cv-warn, --cv-danger … */
}
```

Peer dependency: React 18+.
