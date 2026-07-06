# Timesheet

A local desktop timesheet app built with Electron.

## Features

- 15-minute time slots (default 4:30 AM – 10:30 PM, configurable in Settings)
- Planned vs. actual tracking with colour-coded categories
- 15-minute popup reminders to log what you just did
- Stats dashboard (week / month / 3M / 6M / year / all-time)
- CSV and JSON export with custom date ranges
- Data stored as plain JSON files — one per day — under a configurable data folder

## Where your data lives

By default the app stores data locally at:

```
%AppData%\Timesheet\
  days\<YYYY-MM-DD>.json    ← one file per day
  categories.json           ← your category list
  config.json               ← per-machine settings (data location, etc.)
```

You can point the data folder anywhere via **Settings → Data Location** (see below).

## Syncing across devices via OneDrive

The recommended way to use Timesheet on multiple machines is to point the data
folder at a folder inside your OneDrive. Because each day is a small JSON file
(not a live database), OneDrive syncs it reliably with no corruption risk.

### One-time setup on your primary device

1. In OneDrive, create a folder for the app — e.g. `OneDrive\Apps\Timesheet\`.
2. **Close the Timesheet app**, then copy your existing data into that folder:
   - Copy the entire `days` folder from `%AppData%\Timesheet\` into
     `OneDrive\Apps\Timesheet\`.
   - Copy `categories.json` from `%AppData%\Timesheet\` into
     `OneDrive\Apps\Timesheet\`.
3. Wait for OneDrive to finish syncing (green checkmark on the files).
4. Reopen Timesheet, go to **Settings → Data Location → Choose folder…**, and
   pick the `OneDrive\Apps\Timesheet\` folder.
5. The app immediately starts reading and writing from that location. Confirm
   by checking that your existing days still show up in Stats.

### Setup on a second device

1. Install Timesheet on the second device.
2. Wait for OneDrive to sync `OneDrive\Apps\Timesheet\` down to that device.
3. Open Timesheet → **Settings → Data Location → Choose folder…** → pick the
   same `OneDrive\Apps\Timesheet\` folder.

That's it. Both devices now read and write the same day files.

### Important: don't run on two devices at the same time

OneDrive can't merge changes to the same file made from two machines simultaneously.
Close Timesheet on one machine before opening it on another, and wait for the
green checkmark on the folder so you're not opening stale files.

The Data Location card lives in **Settings** — the current folder, day-file
count, and detected OneDrive path are shown there for quick reference.

## Development setup

Requires [Node.js](https://nodejs.org) (v18+).

```
npm install
npm start
```

## Building a release

```
npm run dist
```

Publishes a Windows installer via `electron-builder` to the configured GitHub
release.
