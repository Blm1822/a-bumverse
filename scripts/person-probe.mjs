// Real-data check for personCredits.js: fetch a few people and summarise what the page would show.
import { fetchPersonCredits } from '../personCredits.js';
import { personCreditGroups, personSummary, personTitle, personDescription } from '../credits.js';
const people = [['f4e48104-a321-4cbc-81a3-a5d087415eb7', 'Quinn Allman'], ['c8af4490-e48a-4f91-aef9-2b1e39369576', 'Savan Kotecha'], ['61f2ae93-ab59-4c59-aef6-43f5f9afceae', 'Robert John "Mutt" Lange']];
for (const [id, name] of people) {
  const t0 = Date.now();
  const { rows, relationCount } = await fetchPersonCredits(id);
  const artist = { id, name, type: 'Person', albums: [], appearances: [] };
  artist.creditGroups = personCreditGroups(artist, rows.map((r) => ({ ...r, byArtist: r.by })));
  const s = personSummary(artist);
  console.log(`\n== ${name}: ${relationCount} relationships -> ${rows.length} rows in ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log('title:', personTitle(artist, s));
  console.log('desc :', personDescription(artist, s));
  for (const g of artist.creditGroups) {
    console.log(`  ${g.label} (${g.count}): ` + g.items.slice(0, 6).map((i) => `${i.title} [${(i.date || '').slice(0, 4)}] by ${i.by} — ${i.roles.join(', ')}${i.songs.length ? ' / ' + i.songs.slice(0, 2).join(', ') : ''}`).join(' | '));
  }
}
