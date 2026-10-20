# DESIGN.md — Speech-AI Research Hub

> **v1 design, superseded.** v2 is being redesigned (see docs/architecture.md and the v2 frontend design doc once written). Kept for reference only.

## Context

- Artifact type: internal SaaS application + onboarding/auth + settings/admin CMS; Quarto research decks use app routes backed by isolated renderer.
- Positioning: technical, utilitarian, research-first.
- Audience: graduate research team. Primary action: locate current research context and continue work without navigation friction.
- Adjectives: precise, calm, candid, dependable, compact.
- Visual translations:
  - Precise: strict editorial rails, tabular numerals, explicit dates and states.
  - Calm: low-chroma surfaces, limited accent, no ambient decoration.
  - Candid: provenance, author, modified time, and pending states stay visible.
  - Dependable: familiar controls, clear confirmations, full empty/error/loading states.
  - Compact: dense lists with generous section breaks, not card grids.
- Aesthetic essence: quiet, technical, editorial.
- Single-minded proposition: shared research record feels closer to a maintained lab notebook than a generic dashboard.
- References: scientific working papers for marginal index and rules; Linear for fast interactions; GitHub settings for safe account administration.
- Mode: light and dark. Density: balanced-dense.
- Constraints: Next.js + PostgreSQL, WCAG 2.2 AA, responsive, Docker deployment, Passkey requires localhost or future HTTPS domain.

## Aesthetic

- Direction: indexed research ledger.
- Defining trait: numbered vertical ledger. Main destinations form one continuous ruled list rather than cards or sidebar tiles.
- Signature move: persistent narrow index rail pairs section numbers with current identity and date metadata; installed PWA uses a compact bottom function rail.
- Category default refused: generic sidebar plus rounded KPI-card dashboard.

## Typography

- Display: `Noto Sans TC`, Google Fonts, OFL.
- Body: `Noto Sans TC`, Google Fonts, OFL.
- Mono: `IBM Plex Mono`, Google Fonts, OFL; used only for dates, IDs, and technical metadata.
- Scale: 1.2 Minor Third, base 16px: 12, 14, 16, 19, 23, 28, 34px.
- Weights: 400 body, 500 interface emphasis, 600 only page titles and critical findings.
- Measure: 68ch. Long text left aligned.

## Color

- Strategy: graphite and cool paper dominate; signal blue marks navigation/action; oxidized orange reserved for attention. No violet or gradient.
- Light palette:
  - bg: `oklch(0.975 0.006 240)` | `#f5f7f8`
  - surface: `oklch(0.995 0.002 240)` | `#fdfefe`
  - fg: `oklch(0.245 0.018 245)` | `#242c33`
  - muted: `oklch(0.52 0.018 245)` | `#6b747d`
  - border: `oklch(0.86 0.012 240)` | `#d2d9dd`
  - accent: `oklch(0.53 0.13 245)` | `#356b9f`
  - accent-fg: `oklch(0.985 0.004 240)` | `#f8fafb`
  - success: `oklch(0.55 0.12 155)` | `#397a59`
  - warning: `oklch(0.62 0.13 65)` | `#a26728`
  - error: `oklch(0.55 0.18 25)` | `#b84235`
- Dark palette:
  - bg: `oklch(0.19 0.012 245)` | `#171c20`
  - surface: `oklch(0.235 0.014 245)` | `#20262b`
  - fg: `oklch(0.92 0.008 240)` | `#e6e9eb`
  - muted: `oklch(0.69 0.014 240)` | `#9fa6ab`
  - border: `oklch(0.36 0.014 240)` | `#434b51`
  - accent: `oklch(0.72 0.11 240)` | `#75a7d1`

## Spacing, radius, shadow

- Base: 4px. Scale: 1, 2, 3, 4, 6, 8, 12, 16, 24.
- Radius: 3px and 8px only.
- Shadow: defined edges for normal surfaces; one compact dark shadow only for blocking dialogs.

## Layout and composition

- Desktop: 12-column editorial grid, 72px index rail, 24px gutters, content max 1320px.
- Mobile: single column, 16px gutters; index rail becomes compact top ledger.
- Tight within records, loose between functional sections.
- F scanning. Breakpoints: 640, 900, 1200px.
- Home uses one numbered destination ledger. Detail pages use date-led timelines and document body.

## Components and states

- Buttons: one filled primary per surface; secondary outlined; tertiary text. Every button has hover, pressed, focus-visible, disabled, and loading states.
- Inputs: persistent labels; validate on blur/submit; preserve values; errors adjacent and announced.
- Tables: left text, right tabular figures, horizontal separators only.
- Dialogs: Radix Dialog primitives; custom visual layer, focus trap, Escape, focus return. Backdrop uses blur only, without a gray wash. Destructive confirmation cannot dismiss through backdrop.
- Settings uses one restrained dialog with ruled rows (account, appearance, login mode, Passkey status, session); smaller type, no nested modal.
- Empty state teaches first action. Loading skeleton follows final structure. Errors name recovery step.
- Native `alert`, `confirm`, and `prompt` prohibited.

## Motion

- Durations: fast 120ms, normal 180ms, dialog 220ms.
- Enter: `cubic-bezier(.16,1,.3,1)`; exit: `cubic-bezier(.4,0,1,1)`.
- Transform and opacity only. Dialog originates near trigger where possible.
- Reduced motion removes spatial movement and retains short opacity feedback.

## Iconography

- Phosphor Icons, regular weight, 20/24px grid. Icon-only controls use 44px hit target and accessible label.
- Theme control uses `Sun`, `Moon`, and `Monitor`; no emoji.

## Imagery

- No stock imagery or decorative illustration. Real research artifacts, waveform previews, figures, tables, and slide thumbnails only.

## Accessibility

- WCAG 2.2 AA. Visible 3px focus ring; full keyboard operation; minimum 44px primary targets.
- Dialog focus trapped and restored. Status includes text, not color alone. Motion reduction supported.
- Authentication permits paste, password managers, Passkey, and no cognitive test.

## Security-facing UX

- Owner administration lives at `/admin`, with indexed destinations for invitations and roles. Page and mutation APIs require Owner; Admin/Member cannot view or mutate these resources.
- Owner cannot be removed or demoted.
- Member-to-admin changes, account suspension, invitation revocation, and deletion require explicit custom dialogs.
- Invitation token appears once; database stores only hash. Creation consumes token atomically with user creation.
- Password login remembers only non-secret account hint on device.
- User may choose password OR Passkey, or password AND Passkey 2FA.
- Settings include theme, authentication mode, Passkeys, password, active sessions, recent security activity, and logout.

## Tokens

```css
:root {
  --font-display: "Noto Sans TC", sans-serif;
  --font-body: "Noto Sans TC", sans-serif;
  --font-mono: "IBM Plex Mono", monospace;
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
  --space-6: 24px; --space-8: 32px; --space-12: 48px; --space-16: 64px;
  --radius-sm: 3px; --radius-md: 8px;
  --bg: oklch(0.975 0.006 240); --surface: oklch(0.995 0.002 240);
  --fg: oklch(0.245 0.018 245); --muted: oklch(0.52 0.018 245);
  --border: oklch(0.86 0.012 240); --accent: oklch(0.53 0.13 245);
  --accent-fg: oklch(0.985 0.004 240); --error: oklch(0.55 0.18 25);
}
[data-theme="dark"] {
  --bg: oklch(0.19 0.012 245); --surface: oklch(0.235 0.014 245);
  --fg: oklch(0.92 0.008 240); --muted: oklch(0.69 0.014 240);
  --border: oklch(0.36 0.014 240); --accent: oklch(0.72 0.11 240);
}
```

- Adapter: plain CSS custom properties with CSS Modules/global projection.

## Cards and surfaces

- Use open rows and section rules first. Surface enclosure only for forms, menus, and dialogs.
- No nested cards. No decorative shadow. Dialog uses edge plus restrained elevation because it must block context.

## Existing slide subsystem

- Quarto reveal.js slides retain their lab-notebook editorial system, Noto Sans TC, paper/graphite palette, blue/orange experiment encoding, and 1280×800 overflow checks. Each deck uses app-backed ZIP import, renderer, versioned iframe, and separate slide tags; nginx serves no slide alias.

## Slop audit

- 2026-10-13 conception audit: pass. Removed generated Soft UI recommendation because it conflicts with research-ledger positioning. Rejected generic sidebar/card dashboard, Space Mono everywhere, gradients, decorative grid, large radii, and shadows.
- Render audit remains required at 375, 768, 1024, and 1440px in light/dark modes.

## Changelog

- 2026-10-13 v1: scientific slide direction created.
- 2026-10-13 v2: slide flowcharts and evidence hierarchy refined.
- 2026-10-13 v3: expanded source of truth for authenticated Speech-AI Research Hub, admin, invitations, CRUD dialogs, theme modes, Docker, and Nginx integration.
- 2026-10-15 v4: renamed product to Speech-AI Research Hub; reduced home IA to meeting, research, and Overleaf; added PWA bottom navigation, blur-only dialogs, media transcoding/playback, and invitation lifecycle states.

- 2026-10-15 v5: Owner-only indexed admin entry and split invitation/role routes; compact settings rows and explicit section rules. Code audit passed; responsive visual review pending.
