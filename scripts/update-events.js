/**
 * update-events.js
 * 
 * Wekelijks script dat automatisch evenementen bijwerkt voor de
 * Verenigingen Kalender (https://antonnoe.github.io/verenigingen-kalender/)
 *
 * Drie methoden:
 * 1. iCal-feeds — direct parsen (NVLR, NedAzur, ANM)
 * 2. Web-scraping via Gemini AI — HTML → events JSON (NLVP, La Tulipe, etc.)
 * 3. Handmatig — bronnen zonder online agenda worden niet aangeraakt
 *
 * Bij fouten: schrijft warnings.json zodat de GitHub Action een Issue aanmaakt.
 *
 * v2 — Fixes:
 * - Gemini-prompt aangescherpt: negeer nieuws/blogs/externe content
 * - Post-validatie: nieuwskoppen en verdachte titels worden gefilterd
 * - categoriseerType(): iCal CATEGORIES-veld wordt gebruikt, regex-volgorde
 *   hersteld zodat bestuurlijk vóór sportief komt, en kerkdienst alleen
 *   matcht op expliciete kerkgerelateerde woorden (niet "ds." in adressen)
 */

const fs = require('fs');
const path = require('path');
const ical = require('node-ical');

// ════════════════════════════════════════════════════════════════
// CONFIGURATIE
// ════════════════════════════════════════════════════════════════

const DATA_PATH = path.join(__dirname, '..', 'data', 'verenigingen.json');
const WARNINGS_PATH = path.join(__dirname, 'warnings.json');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

// Bronnen met iCal-feed (betrouwbaar, direct parseerbaar)
const ICAL_BRONNEN = {
  'nvlr':    'https://www.nvlr.eu/_ical/public.ics',
  'nedazur': 'https://www.nedazur.org/_ical/public.ics',
  'anm':     'https://www.a-n-m.nl/_ical/public.ics'
};

// Bronnen met webpagina-agenda (via Gemini AI geëxtraheerd)
const WEB_BRONNEN = {
  'nlvp': {
    urls: ['https://nlvp.fr/calendar/'],
    naam: 'NLVP'
  },
  'latulipe': {
    urlGenerator: function () {
      const urls = [];
      const now = new Date();
      for (let i = 0; i < 4; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() + i, 15);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        urls.push(`https://www.latulipe.net/nl/activiteiten-la-tulipe/agenda-la-tulipe-dordogne/month.calendar/${y}/${m}/15/-.html`);
      }
      return urls;
    },
    naam: 'La Tulipe'
  },
  'atelier-neerlandais': {
    urls: ['https://atelierneerlandais.com/kalender/'],
    naam: 'Atelier Néerlandais'
  },
  'ern-paris': {
    urls: ['https://ernparis.fr/agenda/'],
    naam: 'ERN Paris'
  },
  'lotgenoten': {
    urls: ['https://www.lotgenoten.fr/agenda/'],
    naam: 'LOTgenoten'
  },
  'bourgondische-zaken': {
    urls: ['https://bourgondischezaken.com/'],
    naam: 'Bourgondische Zaken'
  },
  'neerlandia-toulouse': {
    urls: ['https://www.neerlandia.fr/index.php/nl/agenda'],
    naam: 'Neerlandia Toulouse'
  }
};

// Type-mapping voor normalisatie
const GELDIGE_TYPES = ['sociaal', 'sportief', 'cultureel', 'informatief', 'bestuurlijk', 'zakelijk', 'kerkdienst'];

// ════════════════════════════════════════════════════════════════
// POST-VALIDATIE: nieuwskoppen en rommel detecteren
// ════════════════════════════════════════════════════════════════

// Patronen die erop wijzen dat een "event" eigenlijk een nieuwskop is
const NIEUWSKOP_PATRONEN = [
  /\bNU\.NL\b/i,
  /\bNOS\b/,
  /\bRTL\s?Nieuws\b/i,
  /\bAD\.nl\b/i,
  /\bTelegraaf\b/i,
  /\bVolkskrant\b/i,
  /\bNRC\b/,
  /\bTrouw\b(?!.*(?:borrel|lunch|feest|dienst))/i,
  /\bReuters\b/i,
  /\bANP\b/,
  /\bBBC\b/,
  /\bCNN\b/,
  /\bwint\s+(Oscar|prijs|award|goud|zilver|brons)\b/i,
  /\bslecht\s+voorbereid\b/i,
  /\bbedrijventerrein/i,
  /\bverkiezing(?:en|suitslag)/i,
  /\bkabinets?(?:formatie|val|crisis)\b/i,
  /\bcoalitie(?:akkoord|overleg)\b/i,
  /\bopinie\s*stuk\b/i,
  /\bcolumn\b/i,
  /\bblog\s*post\b/i,
  /\bpodcast\s*(?:aflevering|episode)\b/i,
  /\bnewsletter\b/i,
  /\bnieuwsbrief\b/i,
  /\bbreaking\s*news\b/i
];

// Woorden die in een eventtitel van een Nederlandse vereniging thuishoren
const VERENIGING_EVENT_WOORDEN = [
  /borrel/i, /lunch/i, /diner/i, /wandel/i, /golf/i, /petanque/i,
  /p\u00e9tanque/i, /jeu de boules/i, /excursie/i, /lezing/i, /vergadering/i,
  /ALV/i, /konings/i, /paas/i, /kerst/i, /nieuwjaar/i, /bridge/i,
  /cursus/i, /workshop/i, /concert/i, /expo/i, /bezoek/i, /uitstap/i,
  /feest/i, /viering/i, /spelletjes/i, /quiz/i, /film/i, /koor/i,
  /yoga/i, /padel/i, /zeil/i, /fiet/i, /zwem/i, /tennis/i,
  /kerk/i, /dienst/i, /mis\b/i, /bijbel/i, /gebed/i,
  /markt/i, /beurs/i, /salon/i, /atelier/i, /rondleiding/i,
  /clubavond/i, /stamtafel/i, /bijpraat/i, /caf\u00e9/i, /aperitief/i,
  /toernooi/i, /wedstrijd/i, /clinic/i, /trail/i, /rally/i,
  /lustr/i, /jubile/i, /seizoen/i, /openingsdag/i, /paashaas/i
];

/**
 * Controleert of een event-titel waarschijnlijk een nieuwskop is
 * in plaats van een verenigingsevenement.
 */
function detecteerNieuwskop(titel) {
  if (!titel) return { isNieuws: false, reden: '' };

  // Check 1: titel te lang (>100 tekens is verdacht voor een evenementnaam)
  if (titel.length > 100) {
    var heeftEventWoord = VERENIGING_EVENT_WOORDEN.some(function (re) {
      return re.test(titel);
    });
    if (!heeftEventWoord) {
      return { isNieuws: true, reden: 'titel > 100 tekens zonder event-woorden' };
    }
  }

  // Check 2: bekende nieuwsbronpatronen in de titel
  for (var i = 0; i < NIEUWSKOP_PATRONEN.length; i++) {
    if (NIEUWSKOP_PATRONEN[i].test(titel)) {
      return { isNieuws: true, reden: 'bevat nieuwskop-patroon: ' + NIEUWSKOP_PATRONEN[i].source };
    }
  }

  // Check 3: titel bevat meerdere zinnen (punt + hoofdletter) — typisch nieuwskop
  var zinnenMatch = titel.match(/\.\s+[A-Z]/g);
  if (zinnenMatch && zinnenMatch.length >= 2) {
    return { isNieuws: true, reden: 'meerdere zinnen in titel (3+ segmenten)' };
  }

  // Check 4: titel begint als nieuwszin zonder enkel event-woord
  if (/^(de|het|een|er|dit|dat|deze|hij|zij|we|als|ook|meer|veel|geen|meeste)\s/i.test(titel)) {
    var heeftEventWoord2 = VERENIGING_EVENT_WOORDEN.some(function (re) {
      return re.test(titel);
    });
    if (!heeftEventWoord2) {
      return { isNieuws: true, reden: 'begint als nieuwszin zonder event-woorden' };
    }
  }

  return { isNieuws: false, reden: '' };
}

/**
 * Controleert of een event waarschijnlijk geen NL-verenigingsactiviteit is
 * maar een lokaal Frans/extern evenement dat per ongeluk is meegenomen.
 */
function detecteerExternEvent(titel, plaats) {
  var tekst = (titel + ' ' + (plaats || '')).toLowerCase();

  // Bekende race-/sportevenementen die niet van de vereniging zelf zijn
  if (/ultra[\s-]?trail|marathon\b|triathlon\b|ironman\b|tour de france/i.test(tekst)) {
    // Tenzij het expliciet een groepsdeelname of kijkactiviteit is
    if (/samen|groep|kijken|supporter|deelname|inschrijving|we gaan/i.test(tekst)) {
      return { isExtern: false, reden: '' };
    }
    return { isExtern: true, reden: 'extern sportevenement (niet van vereniging)' };
  }

  return { isExtern: false, reden: '' };
}

// ════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════

async function main() {
  console.log('=== Verenigingen Kalender Update v2 ===');
  console.log('Datum:', new Date().toISOString());
  console.log('');

  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  const warnings = [];
  let totaalGefilterd = 0;

  // ── 1. iCal-bronnen ──
  console.log('── iCal-bronnen ophalen ──');
  for (const [id, url] of Object.entries(ICAL_BRONNEN)) {
    console.log(`  ${id}: ${url}`);
    try {
      const result = await fetchIcalEvents(url, id);
      console.log(`  \u2713 ${result.events.length} toekomstige events gevonden`);
      if (result.gefilterd > 0) {
        console.log(`    (${result.gefilterd} items gefilterd als extern)`);
        totaalGefilterd += result.gefilterd;
      }
      updateVereniging(data, id, result.events);
    } catch (err) {
      console.log(`  \u2717 FOUT: ${err.message}`);
      warnings.push({
        bron_id: id,
        bron_naam: id.toUpperCase(),
        type: 'ical',
        url: url,
        fout: err.message,
        datum: new Date().toISOString()
      });
    }
  }

  // ── 2. Web-bronnen via Gemini ──
  if (!GEMINI_API_KEY) {
    console.log('\n\u26a0 GEMINI_API_KEY niet gevonden \u2014 web-bronnen worden overgeslagen');
    warnings.push({
      bron_id: 'alle-web-bronnen',
      bron_naam: 'Alle web-bronnen',
      type: 'config',
      fout: 'GEMINI_API_KEY ontbreekt als environment variable',
      datum: new Date().toISOString()
    });
  } else {
    console.log('\n── Web-bronnen ophalen via Gemini ──');
    for (const [id, config] of Object.entries(WEB_BRONNEN)) {
      const urls = config.urlGenerator ? config.urlGenerator() : config.urls;
      console.log(`  ${id}: ${urls.length} pagina('s)`);
      try {
        const result = await fetchWebEvents(id, config.naam, urls);
        console.log(`  \u2713 ${result.events.length} toekomstige events ge\u00ebxtraheerd`);
        if (result.gefilterd > 0) {
          console.log(`    (${result.gefilterd} items gefilterd als nieuws/extern)`);
          totaalGefilterd += result.gefilterd;
        }
        updateVereniging(data, id, result.events);
      } catch (err) {
        console.log(`  \u2717 FOUT: ${err.message}`);
        warnings.push({
          bron_id: id,
          bron_naam: config.naam,
          type: 'web-scraping',
          url: urls.join(', '),
          fout: err.message,
          datum: new Date().toISOString()
        });
      }
    }
  }

  // ── 3. Meta bijwerken ──
  const vandaag = new Date().toISOString().split('T')[0];
  const volgendeWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  let totaalEvents = 0;
  let bronnenMetEvents = 0;
  data.verenigingen.forEach(function (ver) {
    if (ver.events && ver.events.length > 0) {
      totaalEvents += ver.events.length;
      bronnenMetEvents++;
    }
  });

  data.meta = {
    laatst_bijgewerkt: vandaag,
    volgende_update: volgendeWeek,
    bronnen_gecontroleerd: Object.keys(ICAL_BRONNEN).length + Object.keys(WEB_BRONNEN).length,
    bronnen_met_events: bronnenMetEvents,
    totaal_events: totaalEvents,
    gefilterde_items: totaalGefilterd,
    methode: 'Automatisch via GitHub Action (iCal feeds + Gemini AI web-extractie)',
    warnings: warnings.length
  };

  // ── 4. Schrijf data terug ──
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`\n\u2713 verenigingen.json bijgewerkt: ${totaalEvents} events van ${bronnenMetEvents} bronnen`);
  if (totaalGefilterd > 0) {
    console.log(`  (${totaalGefilterd} items totaal gefilterd als nieuws/extern)`);
  }

  // ── 5. Warnings ──
  if (warnings.length > 0) {
    fs.writeFileSync(WARNINGS_PATH, JSON.stringify(warnings, null, 2), 'utf-8');
    console.log(`\n\u26a0 ${warnings.length} waarschuwing(en) \u2014 zie warnings.json`);
    warnings.forEach(function (w) {
      console.log(`  - ${w.bron_naam}: ${w.fout}`);
    });
    process.exitCode = 1;
  } else {
    if (fs.existsSync(WARNINGS_PATH)) fs.unlinkSync(WARNINGS_PATH);
    console.log('\n\u2713 Geen waarschuwingen');
  }
}

// ════════════════════════════════════════════════════════════════
// iCal VERWERKING
// ════════════════════════════════════════════════════════════════

async function fetchIcalEvents(url, bronId) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'VerenigingenKalender/1.0' },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} bij ophalen ${url}`);
  }

  const text = await response.text();

  if (!text.includes('BEGIN:VCALENDAR')) {
    throw new Error('Antwoord is geen geldige iCal-data');
  }

  const parsed = ical.parseICS(text);
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  const events = [];
  let gefilterd = 0;

  for (const key in parsed) {
    const item = parsed[key];
    if (item.type !== 'VEVENT') continue;

    const start = item.start;
    if (!start) continue;

    const datum = new Date(start);
    if (datum < now) continue;

    const titel = cleanText(item.summary || 'Onbekend event');
    const plaats = cleanText(item.location || 'niet vermeld');

    // Post-validatie: extern evenement?
    var externCheck = detecteerExternEvent(titel, plaats);
    if (externCheck.isExtern) {
      console.log(`    \u2717 Gefilterd (iCal): "${titel}" \u2014 ${externCheck.reden}`);
      gefilterd++;
      continue;
    }

    const event = {
      datum: formatDate(datum),
      titel: titel,
      plaats: plaats,
      tijd: formatTime(item),
      type: categoriseerType(item.summary, item.description, item.categories),
      bron: ICAL_BRONNEN[bronId]
    };

    // Einddatum als meerdaags
    if (item.end) {
      const eind = new Date(item.end);
      const verschilUren = (eind - datum) / (1000 * 60 * 60);
      if (verschilUren > 24) {
        event.datum_eind = formatDate(eind);
      }
    }

    events.push(event);
  }

  events.sort(function (a, b) {
    return new Date(a.datum) - new Date(b.datum);
  });

  if (events.length === 0) {
    throw new Error('Geen toekomstige events gevonden in iCal-feed (mogelijk leeg of alleen verlopen events)');
  }

  return { events: events, gefilterd: gefilterd };
}

// ════════════════════════════════════════════════════════════════
// WEB-SCRAPING VIA GEMINI
// ════════════════════════════════════════════════════════════════

async function fetchWebEvents(bronId, bronNaam, urls) {
  let alleHtml = '';

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; VerenigingenKalender/1.0)',
          'Accept': 'text/html'
        },
        signal: AbortSignal.timeout(15000)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const html = await response.text();

      if (html.length < 500) {
        throw new Error('Pagina bevat vrijwel geen content');
      }

      const stripped = stripHtml(html);
      alleHtml += `\n\n--- PAGINA: ${url} ---\n${stripped}`;

    } catch (err) {
      console.log(`    Subpagina ${url}: ${err.message}`);
    }
  }

  if (alleHtml.trim().length < 100) {
    throw new Error(`Geen bruikbare HTML opgehaald van ${urls.length} pagina('s)`);
  }

  // ── AANGESCHERPTE GEMINI PROMPT ──
  const vandaag = new Date().toISOString().split('T')[0];

  const prompt = `Je bent een data-extractie assistent voor een kalender van Nederlandse verenigingen in Frankrijk.

OPDRACHT: Extraheer ALLEEN echte KALENDER-EVENEMENTEN die door de vereniging "${bronNaam}" zelf worden georganiseerd uit onderstaande HTML.

KRITIEKE FILTERREGELS — LEES DEZE ZORGVULDIG:
- Vandaag is ${vandaag}. Geef ALLEEN events vanaf vandaag.
- NEGEER VOLLEDIG alle content die GEEN georganiseerd evenement van deze vereniging is:
  * Nieuwsberichten en nieuwskoppen (bijv. van NU.nl, NOS, RTL, BBC etc.)
  * Blogposts, artikelen, opiniestukken
  * Externe evenementen die niet door "${bronNaam}" worden georganiseerd
  * Nieuwsbrieven, podcasts, social media posts
  * Advertenties, banners, sidebar-content
  * Boekrecensies, filmrecensies
- Een GELDIG evenement heeft ALTIJD:
  * Een specifieke datum
  * Een activiteit die door "${bronNaam}" wordt georganiseerd (bijv. borrel, lunch, wandeling, lezing, excursie, vergadering, feest, cursus, concert, kerkdienst, spelletjesmiddag)
- Als een item geen concrete datum heeft of geen verenigingsactiviteit is: SLAAG HET OVER.
- Bij twijfel: NIET opnemen. Liever te weinig dan rommel.

OUTPUTFORMAAT:
- JSON array (geen markdown, geen backticks, geen uitleg).
- Elk object:
  {
    "datum": "YYYY-MM-DD",
    "titel": "korte naam van het event (max 80 tekens)",
    "plaats": "locatie of 'niet vermeld'",
    "tijd": "HH:MM of HH:MM-HH:MM of 'niet vermeld'",
    "type": "sociaal|sportief|cultureel|informatief|bestuurlijk|zakelijk|kerkdienst"
  }
- Geen events? Geef: []
- ALLEEN de JSON array, niets anders.

HTML CONTENT:
${alleHtml}`;

  const geminiResponse = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 8192
      }
    }),
    signal: AbortSignal.timeout(60000)
  });

  if (!geminiResponse.ok) {
    const errText = await geminiResponse.text();
    throw new Error(`Gemini API fout HTTP ${geminiResponse.status}: ${errText.substring(0, 200)}`);
  }

  const geminiData = await geminiResponse.json();

  let responseText = '';
  try {
    responseText = geminiData.candidates[0].content.parts[0].text;
  } catch (e) {
    throw new Error('Onverwacht Gemini response-formaat');
  }

  responseText = responseText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

  var jsonStart = responseText.indexOf('[');
  var jsonEnd = responseText.lastIndexOf(']');
  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error('Geen JSON array gevonden in Gemini response');
  }
  responseText = responseText.substring(jsonStart, jsonEnd + 1);
  responseText = responseText.replace(/,\s*]/g, ']').replace(/,\s*}/g, '}');

  var events;
  try {
    events = JSON.parse(responseText);
  } catch (e) {
    throw new Error('Gemini gaf geen valide JSON terug: ' + responseText.substring(0, 100) + '...');
  }

  if (!Array.isArray(events)) {
    throw new Error('Gemini response is geen array');
  }

  // ── Valideer, normaliseer en filter events ──
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  const validated = [];
  let gefilterd = 0;

  events.forEach(function (ev) {
    if (!ev.datum || !ev.titel) return;

    const datum = new Date(ev.datum);
    if (isNaN(datum.getTime())) return;
    if (datum < now) return;

    const titel = cleanText(ev.titel);

    // Post-validatie: nieuwskop?
    var nieuwsCheck = detecteerNieuwskop(titel);
    if (nieuwsCheck.isNieuws) {
      console.log(`    \u2717 Gefilterd (nieuws): "${titel.substring(0, 60)}..." \u2014 ${nieuwsCheck.reden}`);
      gefilterd++;
      return;
    }

    // Post-validatie: extern evenement?
    var externCheck = detecteerExternEvent(titel, ev.plaats);
    if (externCheck.isExtern) {
      console.log(`    \u2717 Gefilterd (extern): "${titel.substring(0, 60)}..." \u2014 ${externCheck.reden}`);
      gefilterd++;
      return;
    }

    validated.push({
      datum: formatDate(datum),
      titel: titel,
      plaats: cleanText(ev.plaats || 'niet vermeld'),
      tijd: cleanText(ev.tijd || 'niet vermeld'),
      type: normaliseType(ev.type),
      bron: urls[0]
    });
  });

  validated.sort(function (a, b) {
    return new Date(a.datum) - new Date(b.datum);
  });

  return { events: validated, gefilterd: gefilterd };
}

// ════════════════════════════════════════════════════════════════
// DATA MERGE
// ════════════════════════════════════════════════════════════════

function updateVereniging(data, id, nieuwEvents) {
  const ver = data.verenigingen.find(function (v) { return v.id === id; });
  if (!ver) {
    console.log(`    \u26a0 Vereniging "${id}" niet gevonden in JSON \u2014 events overgeslagen`);
    return;
  }
  ver.events = nieuwEvents;
}

// ════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════

function formatDate(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function formatTime(icalEvent) {
  const start = icalEvent.start;
  if (!start) return 'niet vermeld';

  if (start.dateOnly) return 'hele dag';

  const uur = String(start.getHours()).padStart(2, '0');
  const min = String(start.getMinutes()).padStart(2, '0');
  let tijd = uur + ':' + min;

  if (icalEvent.end && !icalEvent.end.dateOnly) {
    const eindUur = String(icalEvent.end.getHours()).padStart(2, '0');
    const eindMin = String(icalEvent.end.getMinutes()).padStart(2, '0');
    tijd += '-' + eindUur + ':' + eindMin;
  }

  return tijd;
}

/**
 * Categoriseer het type van een iCal-event.
 * 
 * VOLGORDE IS CRUCIAAL — specifiekere checks eerst:
 * 1. iCal CATEGORIES-veld (als aanwezig, meest betrouwbaar)
 * 2. Bestuurlijk (ALV, ledenvergadering) — VOOR sportief
 * 3. Kerkdienst — alleen expliciete kerkwoorden
 *    NIET "ds." (false positive door adressen)
 *    NIET los "dienst" (te generiek)
 * 4. Sportief
 * 5. Cultureel
 * 6. Informatief
 * 7. Zakelijk
 * 8. Sociaal (default/vangnet)
 */
function categoriseerType(summary, description, categories) {
  // ── Stap 1: probeer iCal CATEGORIES-veld ──
  if (categories) {
    var cats = '';
    if (Array.isArray(categories)) {
      cats = categories.join(' ').toLowerCase();
    } else if (typeof categories === 'string') {
      cats = categories.toLowerCase();
    }

    if (cats) {
      if (/kerk|religie|church|liturgi/i.test(cats)) return 'kerkdienst';
      if (/sport|golf|wandel|petanque|zeil|padel|tennis|fiet/i.test(cats)) return 'sportief';
      if (/bestuur|alv|vergadering|board/i.test(cats)) return 'bestuurlijk';
      if (/cultuur|expo|concert|museum|kunst|music/i.test(cats)) return 'cultureel';
      if (/info|workshop|cursus|educati/i.test(cats)) return 'informatief';
      if (/zakelijk|business|netwerk/i.test(cats)) return 'zakelijk';
      if (/sociaal|borrel|lunch|diner|feest/i.test(cats)) return 'sociaal';
    }
  }

  // ── Stap 2: keyword-matching op titel + beschrijving ──
  var tekst = ((summary || '') + ' ' + (description || '')).toLowerCase();

  // 2a. Bestuurlijk EERST — voorkomt dat "ALV met aansluitend borrel" sociaal wordt
  //     of dat "ledenvergadering in het golfclubhuis" sportief wordt
  if (/\balv\b|ledenvergadering|bestuursvergadering/i.test(tekst)) return 'bestuurlijk';

  // 2b. Kerkdienst — STRIKT: alleen ondubbelzinnige kerkwoorden
  if (/\bkerkdienst\b|\bpreek\b|\bdominee\b|\bliturg/i.test(tekst)) return 'kerkdienst';
  if (/\b(protestantse?|gereformeerde?|katholieke?|oecumenische?)\s+(dienst|viering|mis)\b/i.test(tekst)) return 'kerkdienst';
  if (/\bpaas(?:dienst|viering|wake)\b|\bkerst(?:dienst|viering|nachtmis)\b|\bpinkster(?:dienst|viering)\b/i.test(tekst)) return 'kerkdienst';

  // 2c. Sportief
  if (/\bgolf\b|\bwandel|\bjeu de boules\b|\bp(?:e|\u00e9)tanque\b|\bpadel\b|\bzeil|\bski\b|\bsport|\btrail\b|\brally\b|\bfiet|\btennis\b|\bzwem|\byoga\b|\btoernooi\b/i.test(tekst)) return 'sportief';

  // 2d. Cultureel
  if (/\bexpo|\bconcert\b|\bmuseum\b|\bcultuur|\blezing\b|\bdictee\b|\bmusic|\bkunst|\bboek(?:en)?\b|\bfilm\b|\bkoor\b|\btheater\b|\brondleiding\b|\bschilder|\bbeeldhouw/i.test(tekst)) return 'cultureel';

  // 2e. Informatief
  if (/\bworkshop\b|\bcursus|\bpresentatie\b|\bcauserie\b|\bmindfulness\b|\binformatie|\bspreek/i.test(tekst)) return 'informatief';

  // 2f. Zakelijk
  if (/\bshowroom\b|\bfashion\b|\bbusiness\b|\bzakelijk|\bnetwerk/i.test(tekst)) return 'zakelijk';

  // 2g. Sociaal (ruimer net)
  if (/\bborrel|\blunch|\bdiner|\bbijpraat|\bpaas|\bnieuwjaar|\bpuzzel|\bbridge\b|\bfeest|\bbbq\b|\bpicknick\b|\bstamtafel\b|\baperiti/i.test(tekst)) return 'sociaal';

  return 'sociaal'; // default
}

function normaliseType(type) {
  if (!type) return 'sociaal';
  var lower = type.toLowerCase().trim();
  if (GELDIGE_TYPES.indexOf(lower) !== -1) return lower;
  return 'sociaal';
}

function cleanText(str) {
  if (!str) return '';
  return str
    .replace(/\\n/g, ' ')
    .replace(/\\,/g, ',')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripHtml(html) {
  // Verwijder scripts, styles, nav, footer, aside, sidebars — behoud alleen content
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '')
    .replace(/<div[^>]*class="[^"]*(?:sidebar|widget|news|blog|comment|social|share|cookie|banner|popup|modal|advertisement|ad-)[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 15000);
}

// ════════════════════════════════════════════════════════════════
// RUN
// ════════════════════════════════════════════════════════════════

main().catch(function (err) {
  console.error('FATALE FOUT:', err);
  process.exit(2);
});
