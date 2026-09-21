# Running DeedPilot

Everything below runs in the deployed app. Nothing needs a laptop. The console is
**/admin**, and it opens with the operations token.

## What runs by itself

| When | What it does | Where you see it |
|---|---|---|
| Every 3 min | **CAPE scripts.** Writes or rewrites the briefing script for every upcoming sale at least 7 days out with 20+ parcels. It holds a script that speaks a figure not in the facts, or names the wrong county. | /cape |
| Every 5 min | **Crawl.** Fetches county parcel lists from the queue. On Sundays it also runs the **Auction Scout research** (4 states). Every tick it merges an announced sale into the crawl that found its parcels, and checks site intel. | /admin → Crawl |
| Every 10 min | **Enrichment.** Places and values the parcels of upcoming sales. Free county records go first, then paid lookups, which stop at the weekly budget. | /admin → Schedules, "What needs you" |
| Every 10 min | **Briefing videos.** Voices and renders one video at a time for the largest sales in each weekly batch (the next two weeks), then delivers it to **CAPE/Video** on Drive. | Drive, /cape/review |
| Daily, 6am Pacific | **Frameworks.** Delivers the framework document for the same sales to **CAPE/Framework** on Drive. | Drive |

When the Auction Scout research finishes a state, the rows it confirmed on the
county's own page go straight into the calendar. It records their list links as
crawl sources and queues crawls. Anything it could not confirm waits for you.

## Your week

1. **Open /admin.** "What needs you" at the top lists everything that needs a
   decision.
2. **Upload the Auction Scout workbook.** Go to Stage 1 (Discover) → *Upload the
   Auction Scout workbook*. Download it from Google Sheets with File → Download →
   Microsoft Excel. Read it once with *Preview only* ticked, then untick and read
   again to apply.
   - Applying adds the sales the calendar is missing, and fills venue, contact
     and parcel counts on the ones it holds.
   - It never overwrites what a county or another import published.
   - Near-miss dates and ambiguous days are listed, not written.
3. **Scout findings.** On the same page, *Scout findings waiting for you* lists
   sales the research could not confirm. **Approve** adds or fills the sale.
   **Dismiss** hides it for good.
4. **Read the briefings** at **/cape/review**. If one is wrong, choose *Needs a
   change* and say what it should say. Within the hour the script is rewritten
   with your note, and its video is re-rendered and replaced in Drive under the
   same name.
5. **Drive.** The week's videos and frameworks are in CAPE/Video and
   CAPE/Framework, named as before. Attaching them to the GHL course is still
   done by hand.

The **Documents** card on /admin links the live frameworks book, the Statutory
Ground page, script review and the CAPE board. All of them are generated from
the calendar each time you open them.

## Settings

The *Schedules* card on /admin holds every setting, and changes take effect on
the next run:

- **Crawl Scout:** counties per tick.
- **Research Scout:** on/off, day, states per pass.
- **Enrichment:** on/off, weekly budget in dollars. 0 means free sources only.
- **Sales delivered per weekly batch:** how many of each week's largest sales get
  a video and a framework. 0 pauses delivery.

**Delivery is currently paused (set to 0): scripts only.** Scripts are written,
and can be read and sent back at /cape/review. No video is voiced or rendered, and
nothing is sent to Drive. When you're ready, set it back to 16. Drive must be set
up first; see One-time setup.

## What it costs

The *Schedules* card shows estimated spend for the last 30 days by service.
Rough figures per item:

- **Briefing script:** a few cents each (Grok, with Claude as fallback). A script
  is rewritten only when its facts change, or when you send it back.
- **Video:** $0.06–$0.30 of speech each, depending on the voice service.
  Narration is cached, so an unchanged section is never bought twice.
- **Enrichment:** never more than the weekly budget.
- **Research:** one paid searched call per state, 4 states on Sundays.

## When "What needs you" says…

- **Auction Scout findings waiting.** Approve or dismiss them (step 3 above).
- **This week's enrichment budget is spent.** Paid lookups resume Monday. Raise
  the budget if the week needs more.
- **Jobs failed this week.** A county site moved or a parser broke. *Recent runs*
  carries the error. A developer fixes these.
- **Jobs never finished.** A job ran out of time on every attempt, usually one
  oversized county or state.
- **Parcels still listed after their sale date.** These clear when the county is
  next crawled.
- **Sales dropped from a county calendar.** The county stopped listing them.
  They get no video or framework until they reappear. Check before telling a
  subscriber.

## Stopping things

- Each schedule has its own switch on the *Schedules* card. *Sales delivered per
  weekly batch = 0* stops videos and frameworks.
- In the Vercel project, `CAPE_RENDER_DISABLED=1` stops rendering outright.

## One-time setup (developer)

1. **Drive delivery.** Create a Google Cloud service account with the Drive API
   enabled. Add its email to the *Tax Deed Collective – The Boys* shared drive
   (or just its CAPE folder) as **Content manager**. Then set these in Vercel
   (Production):
   - `GOOGLE_SERVICE_ACCOUNT_JSON`: the whole key file, as raw JSON or base64.
   - `GOOGLE_DRIVE_CAPE_FOLDER_ID`: the ID from the CAPE folder's URL.

   Until both are set, the video and framework workers stay idle rather than
   fail.
2. **Voice.** Production has a Google speech key, so videos use the Google
   Neural2 voice. To keep the ElevenLabs voice of the earlier batches, add
   `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` and
   `CAPE_VOICE_PROVIDER=elevenlabs`.
3. **Handover of accounts.** Move billing and keys to Ed: Vercel, Neon, xAI,
   Anthropic, Google TTS or ElevenLabs, RentCast, ATTOM, BatchData.
4. **Schema changes** live in `drizzle/*.sql` and are applied with
   `npm run db:migrate`. Every file there is safe to re-run.

## From a terminal (optional)

| Command | Does |
|---|---|
| `npm run scout:ingest -- <file.xlsx> [--apply]` | The workbook upload, from the shell. |
| `npm run cape:render -- --plan` | Which sales get a video this week and where each stands. |
| `npm run cape:render -- --auction <id>` | Render and deliver one video now. |
| `npm run framework -- --county <FIPS>` | One county's framework as Word. |
| `npm run statutory:page` | Writes the Statutory Ground page to a file. |
| `npm run queue:drain` | Drains county crawls locally. |
