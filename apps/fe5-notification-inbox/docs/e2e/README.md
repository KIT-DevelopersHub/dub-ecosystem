# FE5 — Browser E2E (real @dub/ui)

Confirms the FE5 notification-inbox migration renders and operates correctly on the
**real `@dub/ui`** design system (not the old local mirror). Run headless against a
static `vite preview` of the dev harness (`src/dev/main.tsx`) wired to the mock API
client — no dev server / HMR, no backend, no network.

## Result: 14/14 checks green

| Flow | Checks |
|---|---|
| Inbox list | renders 6 seeded items |
| Bell unread badge | visible, `tone=danger` (red), shows unread count `3`, styled background renders |
| Bell popover | opens, renders recent items, has "See all" |
| Type filter | is `@dub/ui` Tabs (`role=tablist`); "Tasks" tab selects + list re-renders (3 items) |
| Preferences | `DataTable` matrix renders; channel column header center-aligned; channel `Switch` toggles |
| Console | no console/page errors during the run |

The three UI choices confirmed by the product owner are all in place:
1. Bell unread badge tone = **danger** (red).
2. Preferences **DataTable** = plain grid, channel columns **center-aligned**.
3. Type filter = **@dub/ui Tabs**.

## Screenshots

| File | Shows |
|---|---|
| `01-inbox.png` | Inbox list + tabs + unread badge |
| `02-bell-open.png` | Bell popover open (danger badge + recent list + See all) |
| `03-filter-tasks.png` | Tasks tab selected, list filtered |
| `04-prefs.png` | Preferences DataTable matrix |
| `05-prefs-toggled.png` | Channel Switch toggled on |

## Reproduce

```
pnpm --filter @dub/tokens build
pnpm --filter @dub/ui build
pnpm --filter @dub/fe5-notification-inbox exec vite build
pnpm --filter @dub/fe5-notification-inbox exec vite preview --port 5175
# then drive http://localhost:5175 with Playwright (headless chromium),
# injecting @dub/ui dist/style.css for component styling.
```
