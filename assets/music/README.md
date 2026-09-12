# Background music tracks

Drop a handful of royalty-free instrumental `.mp3` files in this folder -
`youtubeShort.js` picks one at random as the background bed under each
day's narration.

**Where to get them:** YouTube's own Audio Library
(studio.youtube.com → Audio Library) has tracks explicitly licensed for
use in YouTube videos, free, no attribution required for most of them.
There's no public API for that library, so this is a one-time manual step:
browse, download a few tracks you like (something understated - this is
background music under a voiceover, not the main event), and drop the
files here.

With this folder empty, the daily video job skips rendering for the day
rather than shipping a video with no music bed - same "best-effort,
nothing yet" shape as every other optional integration in this app.
