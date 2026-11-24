# M1 dogfood demo script

Status: **Pending the user's run** · Written 2026-11-24 for [PLAN-012 S7b](PLAN-012-issue-page-list-view.md#s7b-m1-dogfood-demo-and-milestone-switch--s) · Specs: SPEC-012 (D21, AC-14, AC-23), SPEC-013, SPEC-014, SPEC-015

E2E tests are on hold ([README §6](README.md)), so this script is the M1 acceptance run. Do it by hand, keyboard only unless a step says otherwise. Every step has an expected result and a checkbox. Where this script says "check what happens and note it", the specs don't fix the behaviour: write down what you saw.

How to read it:

- **Mod** is `⌘` on macOS and `Ctrl` on Windows and Linux. **Ctrl** is always the Control key.
- `Ctrl+M`, `Ctrl+L` and `Ctrl+Shift+I` are bound on **macOS only** ([shortcuts.md §3.4a](../05-design/shortcuts.md), SPEC-012 D21). On Windows and Linux they must do nothing in Surface, and the commands run from the `⋯` menu and `Mod+K`.
- "Comment box" is the "Leave a comment…" editor at the bottom of the issue page. "Source list" is the list the issue was opened from.
- A step marked **(macOS)** is skipped on other systems. Write "n/a" in the results table.

Contents: [0 Setup](#0-setup) · [1 Core keyboard run](#1-core-keyboard-run-ac-14) · [2 The same from Mod+K](#2-the-same-from-modk) · [3 Offline pass](#3-offline-pass) · [4 Archive and restore](#4-archive-and-restore) · [5 Comments and reactions](#5-comments-and-reactions) · [6 Attachments](#6-attachments-uploads-viewer-and-previews) · [7 Description saver](#7-the-description-saver) · [8 Two tabs](#8-two-tabs) · [9 Private team, second user](#9-private-team-from-a-second-user) · [10 Performance](#10-performance-ac-6-and-ac-23) · [11 Small screens](#11-small-screens-ac-20) · [12 Keys and browsers](#12-keys-and-browsers-azerty-and-q16) · [13 Sign-out](#13-sign-out-and-focus-return) · [14 Composer toast](#14-composer-toast-d26) · [15 Dark theme](#15-dark-theme) · [16 Held ACs](#16-held-acs-checklist) · [17 Results](#17-results)

## 0. Setup

Everything runs locally. Nothing here needs the internet except pulling the PostgreSQL image the first time.

### 0.1 Start the stack

- [ ] **0.1.1** Use Node 24 and pnpm 10. In the repo root:

  ```sh
  source ~/.nvm/nvm.sh && nvm use      # only if node -v is not v24
  colima start                          # only if docker info fails
  pnpm install
  pnpm dev
  ```

  `pnpm dev` ([scripts/dev.mjs](../../scripts/dev.mjs)) starts PostgreSQL in Docker, applies migrations, then runs the server (port 3000) and Vite (port 5173). Expected: the log ends with the server and web ports, and no error.

  If port 5432 or 5173 is taken (for example by another worktree), set `SURFACE_DEV_PG_PORT` or `SURFACE_DEV_WEB_PORT` before `pnpm dev`. Settings come from `apps/server/dev.env` (dev values only; never reuse them elsewhere).

- [ ] **0.1.2** Open **http://localhost:5173**. Expected: you land on the setup wizard (a fresh database has no workspace yet). If you reuse an old database you will see sign-in instead: skip to 0.2.

### 0.2 Create the workspace and the first Admin

- [ ] **0.2.1** The wizard needs a one-time setup link. Find it in the server output (the line says "Surface is not set up yet. Open …/setup?token=…"). If you lost it, run in another terminal: `pnpm --filter @surface/server surface setup-token`. Open the link.
- [ ] **0.2.2** Create the workspace and the Admin. **Choose your own password in the form's password field** and keep it in your password manager. Do not paste it into this file. Expected: you are signed in and see the shell with the first team.

### 0.3 Teams and the second user

- [ ] **0.3.1** The setup wizard already created the first team: name it **ENG** (key `ENG`, public) there. Then create a second public team **DES** and a **private** team **SEC** (Settings → Teams → create; use the private option and note what the form calls it if the wording surprises you). PERF is created later, in 0.4. Expected: all teams show in the sidebar for the Admin.
- [ ] **0.3.2** Settings → Members → invite a second person (role Member, member of **ENG** and **DES** only, **not** SEC). The link is shown **once**: copy it. (Without SMTP the app shows the link instead of emailing it.)
- [ ] **0.3.3** Open the invite link in a **separate browser profile or a private window** (a second session must not replace the first, Q11). Fill in name, display name and **a password of your choosing**. Expected: the second user is signed in and sees ENG and DES, but not SEC. Call this user **User B** and the first **Admin**.
- [ ] **0.3.4** Add a few labels in ENG (Settings → Teams → ENG → Labels, the team's sub-page; if the path differs, note it): at least `Bug` and `Frontend`. Check the team has the default statuses (Backlog, Todo, In Progress, Done, Canceled).

Keep two windows open from now on: **Window A** (Admin, main) and **Window B** (User B, private window or second profile).

### 0.4 Seed issues for section 10

There is no seed command or bulk import in M1, and writing SQL rows directly is not an option (it skips `sync_log`, so clients would never see the rows). The only supported path is the operation endpoint (`POST /api/ops/issue.create`), which sync, permissions and history treat like real use. Mutations are limited to **120 per minute per actor** (`executor/rate-limit.ts`, no setting), so 10,000 issues take about **85 minutes**. Start it first and do sections 1 to 9 meanwhile, in the other window. **Seed as User B** (Window B), not as the Admin: the limit is per actor, so seeding as the Admin would make your own demo actions hit 429s. Anyone can create issues in a public team.

Create a public team **PERF** first (Settings → Teams), then:

- [ ] **0.4.1** In a dedicated tab of Window B (User B, signed in), open DevTools → Console on the Surface page and run the loop below. It is sequential, waits out a 429 using the `retry-after` header (falling back to 550 ms), logs progress every 100 issues, and can resume: set `start` to the last logged number if it stops (a reload, a sleeping laptop). Keep the tab open and the computer awake.

  ```js
  (async () => {
    const start = 0, total = 10000;               // resume: set start to the last logged number
    const csrf = document.cookie.split('; ').find((c) => c.startsWith('surface_csrf='))?.split('=')[1] ?? '';
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = start; i < total; ) {
      const r = await fetch('/api/ops/issue.create', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ input: { team: 'PERF', title: `Perf issue ${i + 1}`, priority: i % 5 } }),
      });
      if (r.status === 429) {
        await sleep(Number(r.headers.get('retry-after')) * 1000 || 550);
        continue;                                    // retry the same issue
      }
      if (!r.ok) { console.error('stopped at', i, r.status, await r.text()); return; }
      i += 1;
      if (i % 100 === 0) console.log('created', i);
    }
    console.log('finished', total);
  })();
  ```

  Expected: "created 100", "created 200", and so on, then "finished". A stop with another status prints the response: note it. Note the real time it took in the results.

- [ ] **0.4.2** **Practical size for AC-6.** You do not have to wait for all 10,000. Section 10 can run at **2,000** issues (about 17 minutes) as a first pass. **Record in the results which size you used** (2,000, 5,000 or 10,000). AC-6 is about 10,000, so run it again at 10,000 when seeding finishes, or mark AC-6 "partial" with the size.
- [ ] **0.4.3** Reload and open PERF's list. Expected: it loads.

## 1. Core keyboard run (AC-14)

SPEC-012 AC-14: keyboard only, from create to going back. Use ENG. Do not touch the mouse in this section. Use `Mod+/` or `?` for the shortcut help at any time.

- [ ] **1.1** Press `G` then `E`. Expected: ENG's issue list opens, focus is in the list.
- [ ] **1.2** Press `C`. Expected: the composer opens as a modal, context-prefilled with team ENG, focus in the title.
- [ ] **1.3** Type the title `Demo: login redirect loops`. Set the properties from the keyboard using the pills' keys while the composer is open (or open each pill with `Tab` and `Enter`): status **Todo**, priority **High**, assignee **me**, label **Bug**. Expected: each pill shows the value you chose.
- [ ] **1.4** Press `Mod+Enter`. Expected: the composer closes, focus returns to where it was, a toast says "Created ENG-…" with **Open**, and the new row appears in the list. The toast text changes to "Created ENG-N" when the number arrives. The live region announces it (a screen reader would say so; if you have none, note "not checked").
- [ ] **1.5** Move to the new row with `J` / `K` (or `↓` / `↑`) and press `Enter`. Expected: the issue page opens with the title, the properties panel (status, priority, assignee, labels), the description, and the comment box.
- [ ] **1.6** Change each property with its key. For each, a picker opens, you choose with `↑` / `↓` and `Enter` (or the digit where shown), and the page updates at once:
  - [ ] `S` status → In Progress
  - [ ] `P` priority → then `0–4` inside the picker (try `2`)
  - [ ] `A` assign… → another member (User B)
  - [ ] `I` assign to me
  - [ ] `L` labels → add `Frontend`
  - [ ] `Shift+E` estimate (set one, if the team uses estimates; otherwise check what happens and note it)
  - [ ] `Shift+D` due date → set one
  - [ ] `Mod+Shift+D` remove the due date. Expected: the due date goes. This is a browser key ("Bookmark all tabs") on some browsers: if the browser's dialog opens instead, note it (it feeds section 12).
- [ ] **1.7** Rename with `Shift+R`. Expected: focus goes to the title in edit mode; type a new title and press `Enter`. The title changes and the address bar slug changes with it (AC-13: the old slug still opens the issue).
- [ ] **1.8** Copy the identifier with `Mod+.`. Expected: a toast confirms the copy. Paste somewhere to check it reads `ENG-N`. Also try `Mod+Shift+,` (URL), `Mod+Shift+'` (title) and `Mod+Alt+C` (Markdown, includes the description).
- [ ] **1.9** Step to the next issue with `J`. Expected: the page shows the next issue in the **source list's order**. `K` goes back. At the end of the list the key does nothing (E10/E11). Opened without a source list (paste the issue's URL in a new tab), the step keys are hidden or do nothing.
- [ ] **1.10** Press `Esc`. Expected: you are back on the list with **the row you came from focused** (not the first row).
- [ ] **1.11** Open the issue again (`Enter`). Press `Mod+Backspace`. Expected: a confirm dialog opens (focus in the dialog). Confirm with `Enter`. Expected: the issue leaves the list, the live region announces the delete, and the page (if you were on it) shows the issue as **Deleted**, read-only.
- [ ] **1.12** Press `Mod+Z` (focus not in a text field). Expected: "Restoring…" then "Restored" with an **Open** action; the issue is back in the list with its properties.
- [ ] **1.13** Check the menu hints: open an issue page's `⋯` menu. Expected: **Delete issue** shows `Mod+Backspace`; **Attach file…** shows `Mod+Shift+U`. On a deleted issue, **Restore issue** shows `#`. (This is the milestone raise: before it, no hint showed.)
- [ ] **1.14** Press `?`. Expected: the shortcut help lists the M1 keys (`G X`, `Ctrl+Shift+1…9` on all systems, `Mod+Backspace`, `#`, and the `Ctrl+…` keys on macOS).

## 2. The same from `Mod+K`

Every action above must also be reachable from the command menu. Use only `Mod+K`, type, `↑` / `↓`, `Enter`.

- [ ] **2.1** On the list, `Mod+K`, type "create issue", `Enter`. Expected: the composer opens (same as `C`). Fill in a title, set status, priority, assignee and a label **through the menu's pickers** (`Mod+K` while the composer is open should still work for properties; if it does not, check what happens and note it). Create it.
- [ ] **2.2** Open the new issue. `Mod+K`: type "status" → choose a status; "priority" → choose; "assign" → choose; "label" → toggle one. Expected: each runs the same picker as the key, and the row/panel updates.
- [ ] **2.3** `Mod+K`: "rename" (focuses the title), "copy ID" (toast), "copy URL", "next issue" or the equivalent if listed. Expected: each command is listed with its key hint on the right where one exists.
- [ ] **2.4** `Mod+K`: "delete issue" (it never ranks first for a keyword match; type "delete"). Expected: the same confirm dialog. Confirm. Then `Mod+K`: "restore" (listed on a deleted issue). Expected: restored, same toast as `Mod+Z`.
- [ ] **2.5** `Mod+K` with the page of a **live** issue open: "Permanently delete…" must **not** be listed. On a **deleted** issue, as the Admin, it is listed. As User B (Member) it is not (Admin only).
- [ ] **2.6** `Mod+K` → "go to ENG issues", "go to My issues", "go to Drafts", "go to ENG archive". Expected: each navigates.

## 3. Offline pass

Use DevTools → Network → **Offline** (or turn off the network). Keep the tab open. Window A, ENG.

- [ ] **3.1** Go offline. Expected: a system banner or status shows you are offline; the list stays usable.
- [ ] **3.2** Open an issue and change status, priority and a label with the keys. Expected: each change shows at once (optimistic), with no error toast. Check what indicator shows pending changes and note it.
- [ ] **3.3** Press `C`, type a title and a description, then press `Esc`. Expected: "Save as draft?" with **Save** and **Discard**. Press **Save**. Open `G` `D`. Expected: the draft is listed (title, team, time).
- [ ] **3.4** Press `C` again for the same team. Expected: the draft is restored with a "Draft restored · Discard" line.
- [ ] **3.5** Write a comment on an issue (section 5 covers the box) and leave it unsent. Expected: it appears on the Drafts page as an unsent comment.
- [ ] **3.6** Press `Mod+Enter` in the composer while offline. Expected: the issue appears in the list as pending (it has no number yet; the page address uses the id). Check what the row shows and note it.
- [ ] **3.7** Go back online. Expected: within a few seconds the pending changes send, the new issue gets its `ENG-N` number, the address of its page switches to `/issue/ENG-N/<slug>` **without losing focus or scroll** (AC-13), and the toast text changes to "Created ENG-N".
- [ ] **3.8** Open the same workspace in Window B as User B. Expected: the status, priority and label changes from 3.2 are visible there.
- [ ] **3.9** Draft send: from the Drafts page, open the draft from 3.3 (if it is still there), and send it with `Mod+Enter`. Expected: it creates the issue and the draft disappears.

## 4. Archive and restore

PLAN-015 S4 left these for the browser. Archiving is automatic (a daily job), so make one archived issue first.

- [ ] **4.1** In ENG, create an issue `Archive me` and set it to **Done**.
- [ ] **4.2** Back-date it. This is **dev-only data trickery** (it writes a synced table outside the repo layer, which the product never does); use it only on this throwaway database. In a terminal:

  ```sh
  docker ps --format '{{.Names}}'        # find the dev database container, named like surface-dev-…-db-1
  docker exec -it <that-container> psql -U surface -d surface
  ```

  then, in psql:

  ```sql
  update issues set completed_at = now() - interval '8 months', updated_at = now() - interval '8 months' where title = 'Archive me';
  ```

  Expected: `UPDATE 1`. Also create and delete an issue `Delete me` in the app (for the Recently deleted tab).

- [ ] **4.3** Run the auto-archive job. It runs daily at **03:29 UTC**. On a worker's start it also catches up, but **only when the last completed `auto-archive` run finished more than 24 hours ago** (`jobs/daily-batch.ts`, `catchUp`), so restarting alone does nothing if it ran today. Either wait for 03:29 UTC, or delete the last run so the catch-up fires. The job table is `pgboss.job` (pg-boss 12), filtered on `name`. In psql (same container as 4.2):

  ```sql
  select id, state, completed_on from pgboss.job where name = 'auto-archive' order by created_on desc limit 5;
  delete from pgboss.job where name = 'auto-archive' and state = 'completed';
  ```

  Then restart `pnpm dev` and wait a minute or two. Expected: `Archive me` leaves the ENG list. If the first query shows other states (`created`, `active`), note them. If nothing archives, check the server log for the `auto-archive` job and note what you see; the rest of this section needs an archived issue, so mark dependent steps "not run" if it never archives. (The job table is pg-boss's own, not a synced table, so this edit does not touch `sync_log`.)
- [ ] **4.4** `G` then `X`. Expected: the ENG archive page opens (route `/team/ENG/archive`). Check and note:
  - [ ] the page layout and the tabs (Archived and Recently deleted)
  - [ ] `Archive me` is listed in Archived; `Delete me` in Recently deleted, with its "purged after" date
  - [ ] rows page by 50 (needs more than 50 rows; skip and note "not enough rows" if you have fewer)
  - [ ] the row menu has **Copy ›** and **Restore** only (no archive, no purge)
  - [ ] offline, the page says "Available when online" and Restore is refused
- [ ] **4.5** Sidebar: ENG has an **Archive** item. At the foot of the ENG issue list there is an "N archived issues" line: it is **hidden at 0** and shows the count when there are some. Check its position (footer of the list) and that it follows the count after a restore.
- [ ] **4.6** Open the archived issue from the archive page. Expected: the page is **read-only**, says it is archived, and has `⋯` items **Restore** and **Delete**; no **Permanently delete…**. Press `#`. Expected: "Restoring…" → "Restored"; the issue is back in the live list and the archive page row goes.
- [ ] **4.7** Open the deleted issue (Recently deleted tab). Expected: `⋯` shows **Restore** (until its purge date), not **Delete**. As the Admin it also shows **Permanently delete…**. Choose it. Expected: a confirm dialog with **focus on Cancel**. Press `Esc` and confirm nothing is deleted.
- [ ] **4.8** Open **Permanently delete…** again and confirm. Expected: the issue is gone for good; its page now says "This issue was deleted permanently." (E5). An address that never existed says the plain not-found text instead (E9, D23). Compare the two and note both messages.
- [ ] **4.9** Locked description: in Window A, open a **live** issue and type in its description. In Window B, delete that issue. Stop typing in A (wait for the save). Expected: the save is refused and a toast offers **Copy text**; pressing it copies your text (D31, SPEC-015 E1). Note the toast wording.
- [ ] **4.10** Settings → Teams → ENG → Automations (the team's sub-page; if the path differs, note it): the purge switch. (SPEC-015 §3.2) Check what the page offers (auto-archive period 1/3/6/9/12 months, auto-close) and note anything that does not match the page described in SPEC-015 §3.6.
- [ ] **4.11** After the milestone raise, `G X` works from anywhere (it needs the current team: route team, else home team, else first member team) and `#` works on an archive row, an archived page and a deleted page.

## 5. Comments and reactions

Window A, an open issue. Keyboard first.

- [ ] **5.1** Press `Ctrl+M` **(macOS)**. Expected: focus moves to the comment box. On Windows and Linux, `Ctrl+M` does nothing; use `Mod+K` → "Comment on issue" instead.
- [ ] **5.2** Type `First comment` and press `Enter`. Expected: the comment is sent and appears in the stream with your name and time. `Shift+Enter` makes a new line without sending. `Mod+Enter` also sends.
- [ ] **5.3** Leave text in the comment box, click away. Expected: the text stays (a synced draft saved on blur). Reload. Expected: it is still there. It also shows on the Drafts page.
- [ ] **5.4** Focus a comment card and press `R`. Expected: a reply box opens under it; send a reply. Expected: it threads under the comment.
- [ ] **5.5** Comment options menu (`⋯` on the card): **Edit** (edit in place, send with `Enter`), **Copy link** (the comment highlights for 2 s), **Copy as Markdown**, **Delete**, **Resolve thread**. Expected: Resolve collapses the thread to a line; reopening restores it.
- [ ] **5.6** Reactions: on a comment and on the issue, add a reaction through `Mod+K` → "Add reaction…" and with the pointer. Expected: it shows with a count; adding the same again removes yours; User B's reaction in Window B appears in A.
- [ ] **5.7** Edit conflict: open the same comment for edit in A and B, save in B, then save in A. Expected: A's save is refused with an edit-conflict message and your text is kept (use **Copy text**). Note the wording.
- [ ] **5.8** Offline: go offline, send a comment. Expected: it shows as pending ("E20" offline text) and sends when you reconnect. Reload while still offline with a pending comment and check what happens; note it.
- [ ] **5.9** On a deleted or archived issue, the comment box is replaced by read-only comments (no send box).
- [ ] **5.10** The activity stream: history lines and comment threads interleave oldest first. With more than 30 items the newest 30 show and **Show N earlier** loads the rest and **moves focus** to the first revealed item with a visible focus ring. Check at 375 px too (section 11).
- [ ] **5.11** AC-17 and AC-18 (by hand, from PLAN-013 S5): step through issues with `J` / `K` (AC-17: follows the source list order, disabled at the ends, hidden without a source list); with a screen reader or by inspecting the live region (DevTools: the element with `aria-live="polite"`), creating, rejecting, deleting and restoring each announce a message (AC-18). Note "not checked with a screen reader" if that is the case.

## 6. Attachments: uploads, viewer and previews

Use a small PNG (under 1 MB), a JPEG, a PDF or text file, and a file **bigger than the upload limit** (see Settings or SPEC-014 for the limit; if unsure, use a file of several hundred MB and note what the message says).

- [ ] **6.1** Open an issue. Press `Mod+Shift+U` with focus **outside** the editors. Expected: the file chooser opens. Choose the PNG. Expected: a row appears in **Attachments** at once, with progress, then a thumbnail (or the file icon until the preview job finishes: thumbnails come from the preview job, so wait a few seconds and check).
- [ ] **6.2** Cancel an upload: start a large upload and use **Cancel** on its row. Expected: the row goes, nothing is attached. Upload 4 files together: 3 run at once and the 4th waits ("queue of 3").
- [ ] **6.3** Oversize: upload a file over the limit. Expected: the row shows the **server's** "too large" message, which reads differently from a network error (D31: no client-side size check). Then go offline and upload: expected an offline toast. Note both texts.
- [ ] **6.4** Drag a file over the page. Expected: a **drop overlay** shows. Drop it: it attaches. Then drop over the **description editor**: the file goes **inline** in the description. Drop over the **title field**: the drop is cancelled (plain inputs cancel). Note each result.
- [ ] **6.5** Paste: copy an image to the clipboard (a screenshot) and paste with focus outside a field. Expected: it uploads as an attachment. Paste a lone URL outside fields: the **Link any URL** form opens with the URL filled.
- [ ] **6.6** `Mod+Shift+U` with focus **in the description**: expected the file is inserted **inline** in the description, not as an attachment row.
- [ ] **6.7** `Ctrl+L` **(macOS)** opens the **Link any URL to issue** form. Add `https://example.com` with a title. Expected: a link row shows the host. On other systems `Ctrl+L` is the browser's address bar: use `⋯` → "Link any URL…".
- [ ] **6.8** Open an image row (`Enter` or click). Expected: the image viewer opens as a dialog, **focus inside it**, `←` / `→` go to the previous or next **image** of the issue (non-images are skipped), `Esc` closes and **focus returns to the row**. Check the arrows do nothing at the ends and that background keys (`J`, `K`) do not move the page behind it.
- [ ] **6.9** Row menu: **Open**, **Download** (check the saved **file name** matches the attachment's name), **Copy link**, **Rename…**, **Remove**. Rename and Remove are offered only to the creator, a team member or an Admin: check as User B on an issue of DES (a team B is in, offered) and on a team B is not in (not offered).
- [ ] **6.10** **Remove**, then **Undo** within 8 seconds. Expected: the attachment returns. Let the 8 seconds pass on another: it stays removed.
- [ ] **6.11** Thumbnails: the image rows show a **thumbnail** after the preview job runs (PLAN-014 S4b). Check a large image and a non-image (should keep the icon). Note delays.
- [ ] **6.12** Read-only view: on a deleted or archived issue the attachments list shows **Open / Download / Copy link only**, and is hidden when there are none.
- [ ] **6.13** The new-issue composer has no file upload yet (a known follow-up; its attach button should open the chooser per SPEC-013). Check what the composer's attach button does and note it.

## 7. The description saver

S4b by-hand list. Window A, a live issue.

- [ ] **7.1** Click into the description and type a sentence. Wait 2 seconds without doing anything. Expected: the text saves (no error; reload shows it).
- [ ] **7.2** Type, then click elsewhere (blur). Expected: saved at once.
- [ ] **7.3** Type, press `Mod+Enter`. Expected: saved at once. In a checklist item `Mod+Enter` toggles the item instead; elsewhere it saves.
- [ ] **7.4** `Ctrl+Shift+I` **(macOS)** from the comment box or elsewhere on the page. Expected: focus goes to the description.
- [ ] **7.5** **`Ctrl+M` from the description (macOS), the new wiring in this slice:** type a sentence in the description, do **not** wait, press `Ctrl+M`. Expected: the description is saved first (reload to confirm it kept the text) and then focus moves to the comment box. Check the order by watching Network: the description save request goes out before the comment box takes focus.
- [ ] **7.6** Type, then close the tab or switch tabs quickly (hide). Reopen. Expected: the text was saved (tab hide/close saves).
- [ ] **7.7** Type, then press `Esc` and open another issue (leave the page). Come back. Expected: the text saved; if the save was in flight, reopening the issue shows your text, not an older version (the saver is taken back on remount).
- [ ] **7.8** Conflict: open the same issue in A and B. Edit the description in B and let it save. Then edit in A (which has the older version) and let it save. Expected: A shows a banner "Someone changed this description since you opened it." with **Copy my text** and **Discard and reload**; your text stays in the editor. Check the banner's layout at 1280 px and at 375 px. **Copy my text** shows "Your text was copied"; **Discard and reload** shows the other version.
- [ ] **7.9** Remote change while you have no unsaved text: edit in B; A's editor follows within a moment. With unsaved text in A, A keeps your text.
- [ ] **7.10** Delete the issue in B while A has unsaved text, then let A save. Expected: a toast with **Copy text** (see 4.9).
- [ ] **7.11** The 375 px stream is covered in section 11.

## 8. Two tabs

Open the workspace in **two tabs of the same browser** (same user), both on ENG.

- [ ] **8.1** Create an issue in tab 1. Expected: it appears in tab 2's list within a second or two, no reload.
- [ ] **8.2** Change a property in tab 1 with the page open in tab 2. Expected: tab 2 updates, focus and scroll unaffected.
- [ ] **8.3** Delete an issue in tab 1 while tab 2 has its page open. Expected: tab 2 shows the page as Deleted (read-only) and does not lose its place. Restore in tab 1: tab 2 returns to live.
- [ ] **8.4** Archive page in both tabs: restore from tab 1; tab 2's archive page refreshes within about a second (it refreshes on the team's own packets, throttled to 1 s).
- [ ] **8.5** Log out in tab 1 (section 13.3 has the full steps). Expected: tab 2 ends its session ("You logged out in another tab.").

## 9. Private team, from a second user

Use SEC (private; User B is **not** a member). Window A is the Admin, who is a member of SEC.

- [ ] **9.1** In Window A, create an issue `Secret plan` in SEC with a comment, an attachment and a reaction. Note its identifier (`SEC-1`).
- [ ] **9.2** In Window B (User B): the sidebar does not show SEC; `G` `E` never opens it; the issue list, My issues, Mod+K and the archive pages show no SEC issue; a search for "Secret" finds nothing.
- [ ] **9.3** In Window B, paste the address `/issue/SEC-1`. Expected: the **plain not-found** page ("SEC-1 doesn't exist, or you don't have access to it."), identical to a number that never existed, **never** "forbidden" and never the title. Try `/issue/SEC-999` and compare.
- [ ] **9.4** In Window B, the attachment's file address (`/files/<id>`, copy it from Window A) opens nothing (404-style, not a download).
- [ ] **9.5** In Window A, delete `Secret plan` then check Window B: still invisible, including `/team/SEC/archive` (not found).
- [ ] **9.6** Cases where a member is removed from a team are covered by the leak suite (permissions.md §5), not by hand. Write "covered by the leak suite" and go on.
- [ ] **9.7** `Ctrl+Shift+1…9`: the digits follow the sidebar order of **the teams User B sees**. Press `Ctrl+Shift+1` in Window B: expected the first listed team's issues. Check the number does not map to SEC.

## 10. Performance (AC-6 and AC-23)

Needs the PERF team from 0.4. **Write down the list size you are testing (2,000, 5,000 or 10,000)** and enter it in the results. Use Chrome (DevTools → Performance and Rendering → **Frame rendering stats**). Close other heavy tabs.

- [ ] **10.1** Open PERF's issue list. Expected: it renders without a long freeze. Note the time from the click to the first rows.
- [ ] **10.2** Scroll the whole list with `J` held down and with the scroll bar. Expected: the frame rate stays near 60 fps, the page never blanks, and the DOM holds only the visible rows plus a small overscan (Elements: count the rows, expect a few dozen, not thousands). The focused row stays mounted when you scroll far from it (AC-6).
- [ ] **10.3** Press `Home`/`End` or hold `J` for a few seconds. Expected: still smooth; the focused row stays visible.
- [ ] **10.4** Group by status or collapse and expand groups with `T` and `Alt+T`. Expected: responsive (note any delay over about a second).
- [ ] **10.5** AC-23: open a hydrated issue (one you opened before, so its content is in the replica). Expected: it renders in under **100 ms**. Measure with DevTools Performance: record, press `Enter`, stop; read the time from key press to the page painted. Then press `S` and pick a status: expected the change paints in under **16 ms** after the key press (one frame). Repeat 5 times and write the worst in the results.
- [ ] **10.6** Memory: after the scroll, note the tab's memory (Task Manager or DevTools Memory) in the results. There is no budget to check against here; just record it.

## 11. Small screens (AC-20)

Use DevTools device mode, or resize the window. Check at **375 px**, **1000 px** and **1400 px**.

- [ ] **11.1** At **1000 px** (768 to 1279 px is the drawer, D30): open an issue. Expected: the properties panel is a **drawer**, not beside the text; it opens and closes (the panel toggle or its key) and the page text uses the full width. Focus moves into the drawer when it opens and returns when it closes.
- [ ] **11.2** At **375 px** (below 768 px, stacked): the issue page shows the title, then the properties as a **wrapping row of pills under the title**, then the description, attachments and the stream. No horizontal scroll anywhere (check the page and the long title, a long label list and a wide table in a description).
- [ ] **11.3** The issue list at 375 px: rows are compact, the pills wrap, no horizontal scroll, the focused row is visible. The sidebar is a drawer.
- [ ] **11.4** The composer at 375 px: it opens **full screen** (no rounded corners, fills the screen); every property pill is reachable; the soft keyboard (on a real phone or with device mode) does not hide the **Create issue** button. `Esc` closes with "Save as draft?".
- [ ] **11.5** The activity stream, the conflict banner (7.8) and the attachments rows at 375 px: no overlap, nothing cut off, **Show N earlier** works.
- [ ] **11.6** Archive page and Drafts page at 375 px: usable, no horizontal scroll.
- [ ] **11.7** Reduced motion: turn on "Reduce motion" in the OS, reload. Expected: panels and the dialog do not slide or scale (the dialog may keep its fade).

## 12. Keys and browsers: AZERTY and Q16

### 12.1 AZERTY (SPEC-012 §4.2)

Switch the OS keyboard layout to **French (AZERTY)**. Open an issue.

- [ ] **12.1.1** `Mod+.` (copy ID): on AZERTY `.` is typed with `Shift`, so the physical chord is `Ctrl/⌘+Shift+;`. Press the key combination that types `Mod+.` on that layout. Expected: **Copy ID**, not "copy URL" or anything else (`event.key` matches are tried before `event.code`).
- [ ] **12.1.2** `Mod+Shift+,` (copy URL) and `Mod+Shift+.` (copy branch name) still work, matched on the physical comma and period keys. Check what you must press and note it.
- [ ] **12.1.3** `Ctrl+,`: the Settings key `Mod+,`; on Windows and Linux this is `Ctrl+,`. Press the key that types `,` on AZERTY (the `M` key position). Expected: Settings opens. On macOS `⌘+,`: same check. Note exactly which physical key worked.
- [ ] **12.1.4** `Ctrl+Shift+1…9`: on AZERTY the digit row types symbols without Shift. Expected: it still goes to team N, because the match is on `Digit1`…`Digit9` (physical key).
- [ ] **12.1.5** `Mod+Alt+0`/`1…4` and `Mod+Shift+7/8/9` in the editor (headings, lists) work on AZERTY (matched on `Digit`).

### 12.2 The Q16 browser check

SPEC-012 D21. Do this **once per browser**: **Chrome**, **Edge** and **Firefox**, on the OS you use daily (add a second OS if you have one). For each key, press it on the issue page (and in a list for `Ctrl+Shift+1…9`) and record: **A** = Surface handled it and the browser did nothing; **B** = the browser took it (the key did not reach Surface, or both ran); **C** = nothing happened (unbound here).

Expected, by the spec: `Ctrl+Shift+1…9` bound on **every** platform, so A. `Ctrl+L`, `Ctrl+M`, `Ctrl+Shift+I` bound on **macOS only**, so A on macOS and C on Windows and Linux (the browser keeps them). `Mod+Shift+D` is bound everywhere; the browser may win.

For each browser, fill the matrix in the results table (section 17):

- [ ] **12.2.1** `Ctrl+Shift+1`, `Ctrl+Shift+2`, … `Ctrl+Shift+9` with at least 3 teams (ENG, DES, PERF, so keys 1 to 3; the rest do nothing or show a hint). Expected: team N's issue list. Watch for a **browser tab switch**.
- [ ] **12.2.2** `Ctrl+L` on the issue page. Expected on macOS: the Link-URL form opens and the address bar does **not** take focus. On Windows and Linux: the address bar takes focus (the browser's), and Surface does nothing.
- [ ] **12.2.3** `Ctrl+M` on the issue page. Expected on macOS: the comment box takes focus; in Firefox the **tab does not mute**. On Windows and Linux: Firefox mutes the tab (the browser's); Surface does nothing.
- [ ] **12.2.4** `Ctrl+Shift+I` on the issue page. Expected on macOS: the description takes focus and **DevTools does not open**. On Windows and Linux: DevTools opens (the browser's).
- [ ] **12.2.5** `Mod+Shift+D` on the issue page with a due date set. Expected: the due date clears. If the browser's "Bookmark all tabs" dialog opens instead, the browser won (shortcuts.md §3.10 says "Remove due date" then stays in `Mod+K`).
- [ ] **12.2.6** Decision. If a key worked only because Surface's `preventDefault` beat a browser key on macOS, SPEC-012 D21 allows binding it everywhere; if a browser took `Ctrl+Shift+1…9`, D21 says it becomes macOS-only. Write the observation in the results; the spec change is made after the run.

## 13. Sign-out and focus return

### 13.1 Focus return after the sign-out dialog

- [ ] **13.1.1** With an unsent change queued (go offline, change an issue's status), open the avatar menu, choose **Log out**. Expected: a dialog "1 change hasn't been sent yet. Signing out discards it." with **Cancel** and **Log out**. Press `Esc` or **Cancel**. Expected: the dialog closes, you stay signed in, and **focus returns to the avatar menu button** that opened it (not to the page body). Keep going offline? Go online to send the change.

### 13.2 Log out deletes the offline copy

- [ ] **13.2.1** Online, signed in, with no unsent changes: choose **Log out**. Expected: you go to the sign-in page. In DevTools → Application → IndexedDB, the database `surface-<workspace>-<user>` is **gone**. Sign in again. Expected: the app bootstraps fresh (a short loading), and your **drafts are back from the server**.
- [ ] **13.2.2** With 3 queued changes (offline), choose **Log out**, then **Log out** in the dialog. Expected: the dialog said "3 changes haven't been sent yet. Signing out discards them." and after confirming, they are discarded; the database is gone.

### 13.3 Two real tabs

- [ ] **13.3.1** Open two tabs of the same session. In tab 1, **Log out**. Expected: tab 2 closes its database at once and shows "You logged out in another tab."; the IndexedDB database is deleted (it may take a moment after tab 2 closes its connection). Sign in again in one tab: it works and the other tab can be reloaded.
- [ ] **13.3.2** Queue changes in **tab 2** (offline), then log out in tab 1. Expected: tab 1's dialog counted tab 2's queue too ("N changes…"), because the delete removes everything.

### 13.4 Offline log out

- [ ] **13.4.1** Go offline and choose **Log out**. Expected: you are signed out here at once and the avatar menu or sign-in page works offline. Go online. Expected: before anything else the app sends the logout to the server (check Network for `POST /auth/logout`), and **the old user is not signed back in** after a reload (the cookie must not resurrect the session). Reload offline first: expected the sign-in page, not the old shell.
- [ ] **13.4.2** If the offline copy could not be deleted (hard to cause; skip and note it), the menu says "You're logged out, but this device's offline data couldn't be deleted. Surface will try again the next time it opens."
- [ ] **13.4.3** Session expiry (not logout): revoke the session from another browser (Settings → Security → Sessions) while this one is open. Expected: this one ends, but the IndexedDB database is **not** deleted (only an explicit sign-out deletes it).

## 14. Composer toast (D26)

SPEC-012 D26: the "Created ENG-…" toast waits until the composer closes when it is open over a modal. Check in a real browser.

- [ ] **14.1** Press `C`, type a title, switch **Create more** on, press `Mod+Enter`. Expected: the issue is created, the composer **stays open** with the title and description cleared and the properties kept, focus back in the title. The "Created ENG-…" toast does **not** appear over the composer (it waits).
- [ ] **14.2** Create two more the same way. Then press `Esc`. Expected: the composer closes and the toast(s) show with **Open**; pressing **Open** goes to that issue. Note whether you get one toast or three and what they say.
- [ ] **14.3** With Create more **off**, create an issue. Expected: the composer closes, then the toast shows (the usual case).
- [ ] **14.4** Rejection: with Create more on, create an issue that the server refuses (go offline, create, delete the team in Window B and go online; or use a title over the length limit if the form allows). Expected: a toast with **Restore in composer**; with something already in the composer it asks "Replace what is in the composer with the rejected issue?" (**Replace** / **Cancel**). Note what you managed to test.

## 15. Dark theme

Press `Alt+Shift+T` to switch (or Settings). Redo a quick look in **dark** at each of these and note any unreadable text, missing focus ring or wrong contrast.

- [ ] **15.1** The issue list, the issue page (panel, pills, description editor), the composer.
- [ ] **15.2** The stream, comment cards, the conflict banner, reactions.
- [ ] **15.3** The attachments section: rows, thumbnails, the drop overlay, the image viewer, the link form.
- [ ] **15.4** The archive page, its tabs and the purge dialog, the "N archived issues" footer.
- [ ] **15.5** The sign-out dialog and the toasts.

## 16. Held ACs checklist

These need the run above. Tick them only after the named steps pass.

- [ ] **AC-14** (keyboard-only create, edit, rename, copy ID, next issue, `Esc` back; also from `Mod+K`): sections 1 and 2.
- [ ] **AC-23** (hydrated issue under 100 ms, property change under 16 ms): step 10.5.
- [ ] **AC-6, by hand** (10,000 issues, 60 fps, focused row stays mounted): steps 10.1 to 10.4; say which list size you used.
- [ ] **AC-13, by hand** (pending issue's address switches to the numbered one without losing focus or scroll; the old slug still opens): steps 1.7 and 3.7.
- [ ] **AC-20, by hand** (375 px with no horizontal scroll): section 11.
- [ ] **AC-17 and AC-18** (from PLAN-013 S5): step 5.11.
- [ ] **S7a by-hand items**: drawer 11.1, stacked page 11.2, full-screen composer 11.4, focus return 13.1.1, log out with deletion 13.2, two real tabs 13.3, offline 13.4, D26 toast section 14.

## 17. Results

Fill this in during the run. Copy the finished table into the "As built" note of PLAN-012 S7b, and make the D21 change in SPEC-012 if section 12.2 moved a key.

**Run details**

| Item | Value |
|---|---|
| Date | |
| Commit (`git rev-parse --short HEAD`) | |
| OS and version | |
| Browser and version for sections 1 to 11, 13 to 15 | |
| Screen size and pixel ratio | |
| Keyboard layout (and AZERTY layout name) | |

**Results by section.** Result is Pass, Fail, Not run, or n/a.

| Section | Result | Notes (what you saw, step numbers, wording to fix) |
|---|---|---|
| 0 Setup | | |
| 1 Core keyboard run (AC-14) | | |
| 2 The same from Mod+K | | |
| 3 Offline pass | | |
| 4 Archive and restore | | |
| 5 Comments and reactions | | |
| 6 Attachments | | |
| 7 Description saver (incl. `Ctrl+M`) | | |
| 8 Two tabs | | |
| 9 Private team, second user | | |
| 10 Performance (AC-6, AC-23) | | |
| 11 Small screens (AC-20) | | |
| 12.1 AZERTY | | |
| 13 Sign-out and focus return | | |
| 14 Composer toast (D26) | | |
| 15 Dark theme | | |

**Performance numbers**

| Measure | Result | Budget |
|---|---|---|
| List size tested (2,000, 5,000 or 10,000) | | AC-6 says 10,000 |
| Scroll frame rate at that size | | about 60 fps |
| DOM rows while scrolling | | a few dozen |
| Open a hydrated issue | | under 100 ms |
| Property change paint (worst of 5) | | under 16 ms |
| Tab memory at that size | | note only |

**Q16 matrix (section 12.2).** Write A (Surface handled it), B (browser took it, or both ran) or C (nothing happened). Expected: `Ctrl+Shift+1…9` is A everywhere; `Ctrl+L`, `Ctrl+M`, `Ctrl+Shift+I` are A on macOS and C elsewhere; `Mod+Shift+D` is A or B.

| Key | Chrome | Edge | Firefox | OS | Notes |
|---|---|---|---|---|---|
| `Ctrl+Shift+1…9` | | | | | |
| `Ctrl+L` | | | | | |
| `Ctrl+M` | | | | | |
| `Ctrl+Shift+I` | | | | | |
| `Mod+Shift+D` | | | | | |

**Held ACs**

| AC | Result | Notes |
|---|---|---|
| AC-14 | | |
| AC-23 | | |
| AC-6 (by hand) | | |
| AC-13 (by hand) | | |
| AC-20 (by hand) | | |

**Bugs and surprises.** One line each, with the step number.

| Step | What happened | Severity (blocks M1 / should fix / nit) |
|---|---|---|
| | | |
