# Sweets Factory ERP (Google Sheets + Apps Script)

A mobile-friendly web app that moves each order through the factory:

```
Sales ──submit──▶ Production ──finish──▶ Packing ──finish──▶ Dispatch ──▶ Delivered
            (Accept → Save partial → Finish) (Accept → Save partial → Finish) (Accept → Dispatched → Delivered)
```

All data lives in one Google Sheet. Users sign in with a username and password that the admin creates.

## Roles

| Role | What they see / do |
|---|---|
| **sales** | New order form (customer, mobile, multiple sweets with boxes × box weight = weight, delivery date/time, address, optional GST, optional packing details and image). Tracks all orders. Can edit or cancel an order until production accepts it. |
| **production** | Only production info: customer name, delivery time, sweets and weights. **Accept** → enter produced kg per item → **Save partial** or **Finish → Packing**. |
| **packing** | Packing instructions and image, ordered vs produced weight, boxes. **Accept** → enter packed boxes → **Save partial** or **Finish → Dispatch**. |
| **dispatch** | Customer mobile (tap to call), address (map link), boxes. **Accept** → vehicle no / driver → **Mark dispatched** → **Mark delivered**. |
| **accounts** | Read-only view of every order at every stage, GST details, full history, link to the sheet. |
| **admin** | Everything above, plus users, sweets master, settings, and moving any order to any stage or cancelling it. |

## Files

| File | Purpose |
|---|---|
| `Code.gs` | Config, sheet setup, web-app entry, sheet helpers |
| `Auth.gs` | Login, sessions, password hashing |
| `Orders.gs` | Order entry, workflow actions, per-role dashboard data |
| `Admin.gs` | Users, sweets, settings, status override, cancel |
| `Index.html`, `Styles.html`, `App.html` | The web app UI |
| `appsscript.json` | Manifest (time zone Asia/Kolkata, web-app settings) |

## Setup (about 10 minutes)

1. Create a new Google Sheet, e.g. **Factory ERP**.
2. **Extensions → Apps Script**.
3. In the editor, create files with the **same names** and paste the content:
   - Script files (`+` → Script): `Code`, `Auth`, `Orders`, `Admin` (the editor adds `.gs`).
   - HTML files (`+` → HTML): `Index`, `Styles`, `App`.
   - Manifest: **Project Settings → Show "appsscript.json" manifest file in editor**, then paste `appsscript.json`.
4. Save. Pick the `setup` function in the toolbar and click **Run**. Approve permissions (Sheets, Drive).
   This creates the sheets `Orders`, `OrderItems`, `Users`, `Sweets`, `Settings`, `ActivityLog`, a Drive folder for packing images, and the user **admin / admin123**.
5. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone** (staff sign in with the app's own username/password, so they don't need Google accounts)
6. Open the web app URL, sign in as `admin`, then:
   - ☰ → change the admin password.
   - **Users** tab → add a user for each person with the right role.
   - **Masters & Settings** → company name, sweets list, partial-finish rules.
7. Share the URL with staff. On phones, use "Add to Home screen" so it opens like an app.

> After changing code later, use **Deploy → Manage deployments → Edit → Version: New version** so the same URL gets the update.

Alternatively use [clasp](https://github.com/google/clasp): `clasp create --type sheets --title "Factory ERP"` then `clasp push` from this folder.

## Settings (Masters & Settings tab or `Settings` sheet)

| Key | Meaning |
|---|---|
| `COMPANY_NAME` | Shown in the header |
| `ORDER_PREFIX` | Order numbers look like `ORD-1001` |
| `ALLOW_PARTIAL_PRODUCTION_FINISH` | If off, production must produce the full weight before **Finish** |
| `ALLOW_PARTIAL_PACKING_FINISH` | If off, packing must pack all boxes before **Finish** |
| `DRIVE_FOLDER_ID` | Where packing images are saved |
| `SHARE_IMAGES_BY_LINK` | Makes images viewable by link so thumbnails show in the app (your Google Workspace policy may block this; the "open image" link still works for people with access) |

## Notes

- Every change is written to `ActivityLog` (who, when, from → to status). The order detail screen shows this history.
- Two people pressing the same button at once is handled: the second one gets "order is already updated, refresh".
- Queues refresh by themselves every 60 seconds, unless you are typing.
- Forgot the admin password? Open the sheet → **Factory ERP → Reset admin password**.
- Don't rename sheets or header columns. Extra columns added to the right are fine.
- Sessions last 6 hours of inactivity, then the user signs in again.
