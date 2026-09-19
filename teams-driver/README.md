# teams-driver

Drives the Microsoft Teams **web** client, scrolls a chat from the beginning of
its history, and writes it into an Obsidian folder: one note per day, one copy
of every shared file, and a record of what changed when the same file was shared
twice.

First run walks back to the start of the conversation. Every run after that
takes only what is new.

## Why it drives the browser instead of calling an API

The Microsoft Graph API is the better source in every respect — clean text,
exact timestamps, real attachment downloads, and a delta token that makes
incremental sync trivial. It needs an app registration in your tenant's Entra
ID, which you don't have. So this reads the DOM of the running web client
instead, signed in as you.

That trade has a cost, and it should be stated plainly: **Microsoft can break
this at any time by reskinning the Teams UI.** Nothing here is a supported
interface. See *When it breaks*, below — the breakage is designed to be
loud and cheap to repair, not prevented.

## Requirements

- Windows, with Microsoft Edge (already present) or Chrome.
- Node 22.6 or newer. TypeScript runs directly via Node's type stripping —
  there is no build step and no bundler.
- One dependency: Playwright.

```powershell
cd teams-driver
npm install
```

## Use

Open the chat in Teams **web** (<https://teams.microsoft.com>), copy the URL,
then:

```powershell
# First run: visible window, sign in by hand, walks the whole history.
npm run teams-driver -- --url "<chat url>" --vault "C:\Vault\Teams\Project Falcon" --name "Project Falcon" --full

# Later runs: new messages only. Can be scheduled.
npm run teams-driver -- --url "<chat url>" --vault "C:\Vault\Teams\Project Falcon" --name "Project Falcon" --headless
```

`--profile` (default `./profile`) holds the browser profile with your Teams
session. **Treat that folder as a credential** — it is what lets later runs sign
in without you. It is gitignored; don't copy it off the machine.

Run `npm run teams-driver --` with no arguments for the full flag list.

### Scheduling it

Task Scheduler, daily, action `node`, arguments
`--experimental-strip-types src\cli.ts --url … --vault … --headless`, started in
the `teams-driver` folder. Drop `--headless` the first time a run fails: an
expired session shows up as a sign-in page that a headless run cannot clear.

## What lands in the vault

```
Project Falcon/
  index.md              participants, date range, every day, every shared file
  2026-09-18.md         one note per day
  2026-09-19.md
  undated.md            messages whose timestamp could not be read
  files/
    Q3-Plan.docx.md     version history for one file, with diffs where possible
    Q3-Plan.docx/
      v1--Q3-Plan.docx
      v2--Q3-Plan.docx
  .teams-driver/
    state.json          what has been captured; deleting it forces a full re-sync
```

Each message is a block ending in `^m-<teams message id>`. That anchor is what
makes re-runs safe — it is how the writer recognises a message it has already
filed — and it doubles as an Obsidian block reference you can link to from
anywhere else in the vault.

### Files shared more than once

Every download is hashed (SHA-256). A re-share of identical bytes links to the
copy already on disk. Different bytes become `v2`, `v3`, … and the file's note
records each version's hash, size, and the message that carried it. For textual
formats it also records a unified diff. `.docx` and `.xlsx` are zip containers,
so they get hash-and-size comparison only — you'll see *that* it changed, not
what changed.

## What it deliberately does not do

- **It does not guess timestamps.** A message whose time can't be read
  machine-readably is filed in `undated.md` with a warning callout rather than
  given a plausible-looking time. A wrong timestamp corrupts the chronology
  silently; a missing one is visible.
- **It does not store a sign-in page as a file.** If an attachment download
  returns HTML, the session has expired or the link was a viewer page. The
  download is skipped with a warning instead of being written into the vault.
- **It does not mark the backfill complete unless it reached the start.** An
  interrupted first run leaves `backfill_complete: false`, and every later run
  keeps backfilling. Otherwise a partial history becomes a permanent hole that
  nothing ever goes back for.
- **It does not write anything to Teams.** Read-only, by construction.

## When it breaks

Every assumption about the Teams DOM is in `src/selectors.ts`, and nowhere else.

The usual symptom is a run that ends with *"no new messages in N scroll steps"*
while the chat clearly has more, or *"could not find the scrollable message
pane"*. Both mean a selector went stale.

To repair: open the chat in Edge, F12, inspect the element in question, read its
`data-tid`, and add that spelling to the **front** of the matching list in
`src/selectors.ts`. Leave the old entries in place — tenants roll out at
different times, and a stale candidate costs one failed `querySelector`.

Never select on a class like `fui-Foo__bar_1a2b3c`. That hash rotates per
deploy.

## Tests

```powershell
npm test
```

Covers the parts that hold the data: HTML-to-Markdown conversion, the day-note
merge (re-runs don't duplicate, backfilled older messages insert in order,
edited messages replace rather than duplicate), the file-version diff, and the
state file's refusal to be misread. The browser-driving code is not covered —
it is tested against the live client, which is the only honest test of it.
