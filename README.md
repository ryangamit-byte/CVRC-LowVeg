# Seed Stock Monitor

Warehouse dashboard for vegetable seed stock: stock in/out, low-stock and expiry alerts, and admin control.

## Run it

1. Install Node.js 18 or newer.
2. In this folder:
   ```
   npm install
   npm start
   ```
3. Open http://localhost:3000 and log in with `admin` / `admin123`.
4. Change the admin password right away (Admin tab, Users, Reset password).

For real use, set a secret before starting: `JWT_SECRET=your-long-random-text npm start`

## Files

| File | What it does |
|---|---|
| `server.js` | Backend: login, roles, stock in/out rules, alerts, audit log. Data is saved in `data/db.json` (created on first run). |
| `public/index.html` | Frontend: dashboard, stock table, in/out form, admin tab. Colors are at the top of the file. |

## Roles

- **Staff**: view dashboard and stock, record stock in and stock out, download CSV.
- **Admin**: everything staff can do, plus manage seed varieties, add or deactivate users, reset passwords, delete wrong entries, and read the activity log.

## How stock works

- Stock = total in minus total out. Stock out is blocked if it is more than what is on hand.
- Stock out is taken from the earliest-expiring lot first, so expiry alerts stay accurate.
- "Reorder at" per variety sets the low-stock warning. Lots expiring within 90 days are flagged (`EXPIRY_WARN_DAYS` in `server.js`).

## Easy edits

- Change sample seeds: `init()` in `server.js` (only applies before `data/db.json` exists).
- Add a field to movements (for example, germination %): add it in `POST /api/tx` in `server.js`, then in the form and table in `index.html`.
- Move to a real database: replace the storage block at the top of `server.js` (`init`, `save`).
- Back up by copying `data/db.json`.
