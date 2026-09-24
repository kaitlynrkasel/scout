# Scout Application Filler (Chrome extension)

Fills job and internship application forms from your Scout profile.

## Install (unpacked, until it's on the Web Store)
1. Open chrome://extensions
2. Turn on Developer mode (top right)
3. Click "Load unpacked" and pick this `extension` folder
4. Visit https://scout-source.com/app once while signed in (this syncs your profile)
5. On any application page, click the Scout icon, then "Fill this page"

## What it does
- Fills empty fields it recognizes: name, email, phone, LinkedIn, website,
  location, school, major, skills, and experience textareas
- Highlights everything it filled; never overwrites typed text; never submits
- The popup has one-click Copy for each experience role, for the repeater
  sections (Workday/Greenhouse style) that can't be filled generically

## Where the data comes from
The Profile page on scout-source.com writes a structured copy of your profile
(scout_fill_profile in the site's own storage); the extension's content script
copies it into extension storage when you visit the site. Nothing is sent
anywhere else.
