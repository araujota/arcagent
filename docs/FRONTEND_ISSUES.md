# Frontend Issues — Web Interface Guidelines Review

Audit of the Terminal Noir redesign (13 files) against Vercel's Web Interface Guidelines.
Three categories: `transition-all` overuse, missing `prefers-reduced-motion` guards, and accessibility gaps.

---

## 1. `transition-all` Anti-pattern

`transition: all` causes the browser to animate every CSS property simultaneously, including non-composited properties that force layout/paint. Replace each instance with only the properties that actually change.

| File | Line | Current | Fix |
|------|------|---------|-----|
| [marketing-nav.tsx](../src/components/landing/marketing-nav.tsx#L10) | 10 | `transition-all duration-200` (logo mark) | `transition-shadow` — only `box-shadow` changes via `.glow-blue-hover` |
| [marketing-nav.tsx](../src/components/landing/marketing-nav.tsx#L28) | 28 | `transition-all duration-200` (CTA button) | `transition-shadow` |
| [waitlist-form.tsx](../src/components/landing/waitlist-form.tsx#L63) | 63 | `transition-all duration-200` (submit button) | `transition-shadow` |
| [platform-stats.tsx](../src/components/landing/platform-stats.tsx#L57) | 57 | `transition-all` (icon container) | `transition-[border-color,box-shadow]` |
| [page.tsx](../src/app/page.tsx#L151) | 151 | `transition-all` (Learn How It Works button) | `transition-[border-color,background-color]` |
| [page.tsx](../src/app/page.tsx#L251) | 251 | `transition-all` (See Detailed Breakdown button) | `transition-[border-color,background-color]` |
| [how-it-works/page.tsx](../src/app/(marketing)/how-it-works/page.tsx#L249) | 249 | `transition-all` (creator step icon wrapper) | `transition-[border-color]` |
| [how-it-works/page.tsx](../src/app/(marketing)/how-it-works/page.tsx#L269) | 269 | `transition-all` (agent step icon wrapper) | `transition-[border-color]` |
| [how-it-works/page.tsx](../src/app/(marketing)/how-it-works/page.tsx#L305) | 305 | `transition-all` (gate card icon wrapper) | `transition-[border-color]` |

**9 instances total.**

---

## 2. Missing `prefers-reduced-motion` Guards

Users who enable "Reduce Motion" in OS accessibility settings get animations regardless. All keyframe and pulse animations should be wrapped with `motion-safe:` (Tailwind) or a `@media (prefers-reduced-motion: reduce)` CSS block.

### Keyframe definitions — no reduced-motion fallback

[globals.css:217](../src/app/globals.css#L217) — `float-up` keyframe
[globals.css:228](../src/app/globals.css#L228) — `pulse-glow` keyframe

**Fix:** Add a `@media (prefers-reduced-motion: reduce)` block at the bottom of `globals.css`:

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

### `animate-pulse` — decorative hero dots

[page.tsx:159,163,167](../src/app/page.tsx#L159) — trust-bar dots in hero section

**Fix:** Replace `animate-pulse` with `motion-safe:animate-pulse` on each dot span.

### `animate-pulse` — skeleton loaders

[live-activity-feed.tsx:72](../src/components/landing/live-activity-feed.tsx#L72) — skeleton rows while loading

**Fix:** Replace `animate-pulse` with `motion-safe:animate-pulse`.

### `animate-[float-up]` — feed item entrance animation

[live-activity-feed.tsx:106](../src/components/landing/live-activity-feed.tsx#L106) — staggered float-up on each activity row

**Fix:** Replace `animate-[float-up_0.3s_ease-out]` with `motion-safe:animate-[float-up_0.3s_ease-out]`.

---

## 3. Accessibility Gaps

### 3a. Unlabeled email input

[waitlist-form.tsx:54](../src/components/landing/waitlist-form.tsx#L54)

The waitlist `<Input type="email">` has a `placeholder` but no associated `<label>`. Placeholders disappear on focus and are not announced reliably by all screen readers.

**Fix:**
```tsx
<label htmlFor="waitlist-email" className="sr-only">Email address</label>
<Input
  id="waitlist-email"
  type="email"
  placeholder="you@example.com"
  ...
/>
```

### 3b. Icon-only button without `aria-label`

[notification-bell.tsx:28](../src/components/layout/notification-bell.tsx#L28)

The notification bell `<Button size="icon">` renders only a `<Bell>` SVG icon. Screen readers announce "button" with no description of its purpose.

**Fix:**
```tsx
<Button
  variant="ghost"
  size="icon"
  aria-label="Notifications"
  className="relative text-muted-foreground hover:text-foreground transition-colors"
>
```

### 3c. Multiple unlabeled `<nav>` regions

[marketing-nav.tsx:15](../src/components/landing/marketing-nav.tsx#L15) — header nav
[marketing-footer.tsx:16](../src/components/landing/marketing-footer.tsx#L16) — footer nav

When a page has more than one `<nav>` landmark, WCAG requires each to be distinguishable via `aria-label`. Both the header and footer nav elements are unlabeled.

**Fix:**
```tsx
// marketing-nav.tsx
<nav aria-label="Main navigation" className="hidden sm:flex items-center gap-4 ...">

// marketing-footer.tsx
<nav aria-label="Footer navigation" className="flex items-center gap-4 ...">
```

---

## Priority

| Priority | Issue | Count |
|----------|-------|-------|
| High | `transition-all` → specific properties | 9 files |
| High | Unlabeled form input | 1 file |
| High | Icon button missing `aria-label` | 1 file |
| Medium | `prefers-reduced-motion` not respected | 3 files |
| Low | Duplicate unlabeled `<nav>` landmarks | 2 files |
