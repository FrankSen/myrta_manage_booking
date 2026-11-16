Test Rebooking Assistant — User Guide
=====================================

The app watches myrta.com for you. For each student you set the test centres and times you want;
the app keeps refreshing, rebooks when an exact match appears, and asks you when a close match appears.


1. Install
----------

Windows (Windows 10 or 11, any system language)
1. Google Chrome or Microsoft Edge must be installed (the Edge that comes with Windows is fine).
   The app uses it to refresh students; myrta.com only allows a normal browser.
2. Unzip myrta-rebook-…-win-x64.zip to a fixed place, e.g. D:\MyRTA Rebook. Don't run it from inside the zip.
3. Double-click "MyRTA Rebook.exe".
   - The first time, Windows may say "Windows protected your PC" or "Unknown publisher" (the app has no
     code-signing certificate). If the file came from us, click "More info" → "Run anyway".
   - After the first run there is a "Test Rebooking Assistant" shortcut on the desktop and in the Start menu.

Mac
1. Google Chrome or Microsoft Edge must be installed.
   Apple silicon (M1, M2, …) uses the mac-arm64 build; Intel uses mac-x64.
   Not sure? Apple menu → "About This Mac", see "Chip".
2. Double-click the zip and drag "MyRTA Rebook.app" into Applications.
3. First launch: the app has no Apple developer signature, so macOS blocks it. Open Terminal, paste this and press Return:
       xattr -dr com.apple.quarantine "/Applications/MyRTA Rebook.app"
   Then double-click the app. Alternatively, after a blocked launch go to System Settings → Privacy & Security and click "Open Anyway".

General
- The app is a normal window; there's no command-line window. Closing the window quits the app.
- Nothing else (Node etc.) needs to be installed.
- Only one copy runs per computer. Opening it again brings the existing window to the front.
- The interface is in Chinese by default. Click "English" at the top right to switch; click "中文" to switch back.
  The choice is remembered. All dates and times are shown in Sydney time, whatever the computer's time zone.


1a. Import the license
----------------------

The trial needs a license file (a .json file from the developer). On first launch the top of the page says
there is no license yet; click "Import license file" and choose it. You only do this once; upgrades keep it.

- The top right shows "Trial until <date>". It ends at the end of that day, Sydney time.
- After it ends you can still see students and the log, but nothing is refreshed and you can't add students.
  Import a new license file and students that were refreshing continue automatically.
- Don't set the computer's clock back. If the clock is earlier than last time, refreshing stops until the time is correct.


2. Add a student
----------------

1. Click "Add student" at the top right.
2. Fill in:
   - Nickname: just for you, e.g. "Wang Wed". No full name needed.
   - Booking number.
   - Surname: exactly as on the booking.
3. Click "Add and read booking". The app logs in once to read the current booking. This takes 1 to 2 minutes;
   a browser window opens and works by itself. Please don't touch it.
4. The student then appears in the list with the current booking.

If reading fails, check the booking number and surname. The site may also be down for a moment; try again in a few minutes.


3. Set a target and start
-------------------------

After adding a student the "Set target" dialog opens. You can change it later with "Set target" on the card.

1. Target centres: search by name, suburb or postcode and tick up to 2 centres per student.
   More centres make each round slower for every student, so the limit is 2.
2. Dates: earliest and latest date.
3. Time: slots are every 15 minutes. Choose one of:
   - Time range: earliest and latest time. Picking the earliest time sets the latest to the same value; change it if needed.
   - Specific times: click the exact times you'd accept (e.g. 08:00, 09:15, 13:30). Only these count as an exact match.
4. Click "Save target", then "Start". The status becomes "Refreshing".

While refreshing, each student has their own browser window that the app operates. It is minimised
automatically and shows in the taskbar (the Dock on a Mac). Don't close it or click in it. myrta.com blocks invisible "background" browsers, so the window is required.

Up to 5 students can refresh at once. Besides your centres, the app also checks one nearby centre (within 10 km).

With many students or centres, refreshing is slower than the interval you set: all students share one
internet connection and any two visits to the site are at least 20 seconds apart. For example, 5 students
with 2 centres each make about 15 visits per round, so a full cycle takes about 5 minutes.
"About every X min in practice" on each card is that real speed.

Each card shows rounds done, a countdown to the next round, which centre is being checked, and how long the
student can still be refreshed (until 48 hours before the latest target day or the current test).
The blue box is the current booking; the green box is the target.


3a. Refresh interval
--------------------

Click "⏱ Every 2 min" at the top to change the interval for all students: 1, 2, 3, 5, 10, 15 or 30 minutes,
default 2. "Interval" on a card sets it for one student only. Changes apply immediately.

Why 1 minute is the minimum and faster isn't better:
- The interval counts from the end of the previous round, and a round itself takes 1 to 1.5 minutes.
- All students share one connection. Too many visits and myrta.com blocks them; then every student pauses
  for 5 minutes, doubling with each further block up to 1 hour. One block costs more than refreshing faster saves.
- Any two visits are at least 20 seconds apart; this can't be changed.

Tip: use 2 minutes normally; give students who aren't in a hurry 5 or 10 minutes.


4. When a slot appears
----------------------

Exact match (centre, date and time all within your target):
  The app rebooks, the status becomes "Rebooked" and you get a notification. That student is then finished.

  Note: auto-rebook is not enabled in this version (the top bar says "Auto-rebook: off").
  On an exact match the app goes as far as the site's confirm page without submitting; the status becomes
  "Found (not submitted)" and it appears under "Needs your attention". Click "Open myrta.com" to rebook
  yourself, or "Keep looking" to continue.

Close match (within 1 hour, or a centre within 10 km):
  Never rebooked automatically. It appears under "Needs your attention" with a notification.
  - "Rebook to this": the app checks the slot again and rebooks if it's still there (with auto-rebook off, it stops at the confirm page).
  - "Dismiss": ignore it and keep refreshing.

Notifications: if there's an "Enable notifications" button at the top, click it and allow.
On Windows, check Settings → System → Notifications if none appear.


5. When the app stops by itself
-------------------------------

- The current test is less than 48 hours away: the site locks the booking, so the student stops.
- All target dates are within 48 hours: there are no days left, so the student stops.
- The app never moves a booking to a slot less than 48 hours away.

On errors the student becomes "Paused" and appears under "Needs your attention" with the reason.
The activity log has details; filter by student or tick "Problems only". Click "Restart" when it's sorted.


6. FAQ
------

Q: "Chrome or Edge was not found".
A: Install Google Chrome and open the app again.

Q: "The site is refusing access for now".
A: The site thinks there are too many visits. The app pauses all students (from 5 minutes up to 1 hour) and
   resumes by itself. If it keeps happening, refresh fewer students at once.

Q: "The site asked for a captcha".
A: The app doesn't solve captchas; the student pauses. Start again a while later.

Q: "The booking number or surname is wrong".
A: Delete the student, check the details and add them again.

Q: "Submitted, but the result couldn't be confirmed".
A: Log in to myrta.com in a browser straight away and check the booking. The website is the source of truth.

Q: Pop-ups keep saying "download complete" (e.g. Tencent iOA, antivirus).
A: Nothing is being downloaded. The Chrome used for refreshing writes its own cache files (LOCK, LOG, …) in the
   app's data folder, and some security software treats them as downloads. Add this folder to the security
   software's allow list or trusted zone (on a work computer you may need your IT admin):
     Windows: %APPDATA%\MyRTA Rebook\browser-profile
     Mac: ~/Library/Application Support/MyRTA Rebook/browser-profile
   Trusting Chrome (chrome.exe) also works. The app keeps these files to a minimum, but can't avoid them entirely.

Q: What about sleep or shutdown?
A: Nothing is refreshed while the computer sleeps or is off. Students that were refreshing continue when you
   open the app again. Turn off automatic sleep while refreshing.

Q: Where is student data stored?
A: Separately from the app, in the system's app data folder:
     Windows: %APPDATA%\MyRTA Rebook (type this into the File Explorer address bar)
     Mac: ~/Library/Application Support/MyRTA Rebook
   Booking numbers and surnames are encrypted. Don't send this folder to anyone.

Q: How do I upgrade? Are students that are refreshing affected?
A: Students, targets, round counts and the license are in the data folder above; upgrading only replaces the app.
   1. Close the app (refreshing stops and the browser windows close).
   2. Windows: unzip the new version over the old folder (or replace the folder in the same place; shortcuts keep working).
      Mac: drag the new "MyRTA Rebook.app" into Applications, choose "Replace", and run the xattr command above again.
   3. Open the app. Students that were refreshing continue and keep their round counts.
   Only the few minutes of replacing files are lost. If a student is mid-rebooking (going to the confirm page),
   the app warns you when closing; it's best to wait for it to finish.


7. Quit
-------

Close the window (or press Command+Q on a Mac). If students are refreshing you're asked to confirm.
The app closes all browser windows it opened. Students that were refreshing continue next time.
