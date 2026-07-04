/**
 * update-events.js
 * 
 * Wekelijks script dat automatisch evenementen bijwerkt voor de
 * Verenigingen Kalender (https://antonnoe.github.io/verenigingen-kalender/)
 *
 * Drie methoden:
 * 1. iCal-feeds — direct parsen (NVLR, NedAzur, ANM)
 * 2. Web-scraping via Claude AI — HTML → events JSON (NLVP, La Tulipe, etc.)
 * 3. Handmatig — bronnen zonder online agenda worden niet aangeraakt
 *
 * Bij fouten: schrijft warnings.json zodat de GitHub Action een Issue aanmaakt.
 *
 * v2 — Fixes:
 * - AI-prompt aangescherpt: negeer nieuws/blogs/externe content
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
// Machine-leesbare gezondheidsstatus voor externe dashboards (bv. de Cockpit).
// Wordt elke run geschreven en meegecommit; bevat per bron de status + een
// heartbeat-timestamp zodat een dashboard ook kan zien of de workflow zélf nog draait.
const HEALTH_PATH = path.join(__dirname, '..', 'data', 'health.json');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Bronnen met iCal-feed (betrouwbaar, direct parseerbaar)
const ICAL_BRONNEN = {
  'nvlr':    'https://www.nvlr.eu/_ical/public.ics',
  'nedazur': 'https://www.nedazur.org/_ical/public.ics',
  'anm':     'https://www.a-n-m.nl/_ical/public.ics'
};

// Bronnen met webpagina-agenda (via Claude AI geëxtraheerd)
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
    urls: [
      'https://atelierneerlandais.com/kalender/',
      'https://atelierneerlandais.com/'
    ],
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
  'neerlandia-toulouse': {
    urls: ['https://www.neerlandia.fr/index.php/nl/agenda'],
    naam: 'Neerlandia Toulouse'
  },
  'fanf': {
    urls: ['https://www.fanf.fr/activiteiten/lijst'],
    naam: 'FANF'
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

  // ── 2. Web-bronnen via Claude ──
  if (!ANTHROPIC_API_KEY) {
    console.log('\n\u26a0 ANTHROPIC_API_KEY niet gevonden \u2014 web-bronnen worden overgeslagen');
    warnings.push({
      bron_id: 'alle-web-bronnen',
      bron_naam: 'Alle web-bronnen',
      type: 'config',
      fout: 'ANTHROPIC_API_KEY ontbreekt als environment variable',
      datum: new Date().toISOString()
    });
  } else {
    console.log('\n── Web-bronnen ophalen via Claude ──');
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

  // ── 3. Vast-ritme-bronnen (clubs zonder online agenda maar met vast schema) ──
  console.log('\n── Vast-ritme-events genereren ──');
  data.verenigingen.forEach(function (ver) {
    if (!ver.vast_ritme) return;
    try {
      const events = genereerRitmeEvents(ver.vast_ritme);
      ver.events = events;
      console.log(`  \u2713 ${ver.id}: ${events.length} events gegenereerd (${ver.vast_ritme.omschrijving || 'vast ritme'})`);
    } catch (err) {
      console.log(`  \u2717 ${ver.id}: FOUT bij ritme-generatie: ${err.message}`);
      warnings.push({
        bron_id: ver.id,
        bron_naam: ver.naam,
        type: 'vast-ritme',
        fout: err.message,
        datum: new Date().toISOString()
      });
    }
  });

  // ── 4. Meta bijwerken ──
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
    methode: 'Automatisch via GitHub Action (iCal feeds + Claude AI web-extractie)',
    warnings: warnings.length
  };

  // ── 4. Schrijf data terug ──
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf-8');

  // Gezondheidsstatus voor externe dashboards (Cockpit): per-bron status +
  // heartbeat. Afgeleid van warnings + de werkelijke event-tellingen.
  writeHealth(data, warnings, vandaag, volgendeWeek, totaalEvents);
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
// VAST-RITME GENERATIE
// ════════════════════════════════════════════════════════════════

/**
 * Genereert events voor verenigingen met een vast, voorspelbaar ritme
 * maar zonder online agenda (bv. RDVBergerac: elke eerste donderdag).
 *
 * Configuratie via veld `vast_ritme` in verenigingen.json:
 * {
 *   "patroon": "maandelijks",
 *   "weekdag": 4,              // 0=zo, 1=ma, ... 4=do
 *   "week_van_maand": 1,       // 1 = eerste <weekdag> van de maand
 *   "aantal_maanden": 6,       // hoeveel maanden vooruit genereren
 *   "plaats": "…",
 *   "type": "sociaal",
 *   "omschrijving": "…",       // alleen voor logging
 *   "seizoenen": [             // optioneel: titel/tijd per maandbereik
 *     { "maanden": [10,11,12,1,2,3], "tijd": "ca. 12:00", "titel": "…" },
 *     { "maanden": [4,5,6,7,8,9],    "tijd": "ca. 18:00", "titel": "…" }
 *   ],
 *   "titel": "…", "tijd": "…"  // fallback als er geen seizoenen zijn
 * }
 */
function genereerRitmeEvents(ritme) {
  if (ritme.patroon !== 'maandelijks') {
    throw new Error(`Onbekend patroon: ${ritme.patroon}`);
  }
  const weekdag = ritme.weekdag;
  const weekVanMaand = ritme.week_van_maand || 1;
  const aantalMaanden = ritme.aantal_maanden || 6;

  const now = new Date();
  now.setHours(0, 0, 0, 0);

  const events = [];
  // Start in de huidige maand; is de datum al voorbij, dan valt hij eruit
  // en vullen we aan tot `aantalMaanden` toekomstige events.
  let jaar = now.getFullYear();
  let maandIdx = now.getMonth(); // 0-based

  while (events.length < aantalMaanden) {
    const eersteDag = new Date(jaar, maandIdx, 1);
    const offset = (weekdag - eersteDag.getDay() + 7) % 7;
    const dag = 1 + offset + (weekVanMaand - 1) * 7;
    const eventDatum = new Date(jaar, maandIdx, dag);

    if (eventDatum >= now) {
      const maandNr = maandIdx + 1; // 1-based voor seizoensconfig
      let titel = ritme.titel || 'Maandelijkse ontmoeting';
      let tijd = ritme.tijd || '';
      if (Array.isArray(ritme.seizoenen)) {
        const seizoen = ritme.seizoenen.find(function (s) {
          return s.maanden.indexOf(maandNr) !== -1;
        });
        if (seizoen) {
          if (seizoen.titel) titel = seizoen.titel;
          if (seizoen.tijd) tijd = seizoen.tijd;
        }
      }
      const y = eventDatum.getFullYear();
      const m = String(eventDatum.getMonth() + 1).padStart(2, '0');
      const d = String(eventDatum.getDate()).padStart(2, '0');
      events.push({
        titel: titel,
        datum: `${y}-${m}-${d}`,
        tijd: tijd,
        plaats: ritme.plaats || '',
        type: ritme.type || 'sociaal',
        bron: 'vast ritme (automatisch gegenereerd)'
      });
    }

    maandIdx++;
    if (maandIdx > 11) { maandIdx = 0; jaar++; }
  }

  return events;
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
// WEB-SCRAPING VIA CLAUDE
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

  // ── AANGESCHERPTE PROMPT ──
  const vandaag = new Date().toISOString().split('T')[0];
  const huidigJaar = new Date().getFullYear();

  const prompt = `Je bent een data-extractie assistent voor een kalender van Nederlandse verenigingen in Frankrijk.

OPDRACHT: Extraheer ALLE kalender-evenementen die door de vereniging "${bronNaam}" worden georganiseerd uit onderstaande HTML. Wees ruimhartig: verenigingen publiceren hun agenda vaak in onconventionele vormen (jaarkalenders, nieuwsberichten met datum in de titel, tabellen, platte tekst).

BELANGRIJK — Zoek events in álle formaten, zoals:
- Gestructureerde agenda-lijsten met datum, tijd, locatie
- Jaarkalenders in platte tekst (bijv. "4/1 Wandeling", "27/4 Borrel" — dit zijn DD/M notaties voor ${huidigJaar})
- Nieuwsberichten waarvan de titel een event met datum aankondigt (bijv. "Expo Maxime Ansiau — 29-30 mei", "Koningsdagreceptie 20 mei")
- Tabellen, lijsten met data, of opsommingen
- Meerdaagse events (gebruik de startdatum)
- Events met datum in verleden opmerkingen worden overgeslagen, maar events met alleen dag+maand horen bij het lopende of volgende jaar

FILTERREGELS:
- Vandaag is ${vandaag}. Geef ALLE toekomstige events vanaf vandaag, ook events die ver in de toekomst liggen (december, volgend jaar, 2027). Geen maximum horizon — neem álles mee wat op de pagina staat.
- Als alleen dag en maand genoemd zijn (geen jaar): neem de eerstvolgende datum vanaf vandaag.
- NEGEER:
  * Nieuwskoppen van NU.nl/NOS/RTL/BBC etc. en algemene blogposts
  * Boekrecensies, filmrecensies zonder specifiek event
  * Archiefitems en al voorbije events
  * Advertenties en navigatie-elementen
  * Commerciële dienstverlening en cursussen (taallessen, webinars, workshops tegen betaling, coaching, adviesdiensten): deze zijn geen verenigingsactiviteiten
- Vermeldingen zoals "terugkerende maandelijkse borrel" ZONDER concrete datum: SLAAG OVER.

VOORBEELDEN VAN WÉL OPNEMEN:
- "27/4 AfterNetwork borrel" → datum: ${huidigJaar}-04-27, titel: "AfterNetwork borrel"
- "Expo Maxime Ansiau – 29-30 mei" → datum: ${huidigJaar}-05-29, titel: "Expo Maxime Ansiau"
- "Koningsdagreceptie woensdag 20 mei, 18:30" → datum: ${huidigJaar}-05-20, tijd: "18:30"
- "8, 9 en 10 juni 2026 Paspoort pop-up" → datum: 2026-06-08, titel: "Paspoort pop-up"

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

  const claudeResponse = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 16384,
      temperature: 0.1,
      messages: [
        { role: 'user', content: prompt }
      ]
    }),
    signal: AbortSignal.timeout(60000)
  });

  if (!claudeResponse.ok) {
    const errText = await claudeResponse.text();
    throw new Error(`Claude API fout HTTP ${claudeResponse.status}: ${errText.substring(0, 200)}`);
  }

  const claudeData = await claudeResponse.json();

  let responseText = '';
  try {
    responseText = claudeData.content[0].text;
  } catch (e) {
    throw new Error('Onverwacht Claude response-formaat');
  }

  responseText = responseText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

  var jsonStart = responseText.indexOf('[');
  var jsonEnd = responseText.lastIndexOf(']');
  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error('Geen JSON array gevonden in Claude response');
  }
  responseText = responseText.substring(jsonStart, jsonEnd + 1);
  responseText = responseText.replace(/,\s*]/g, ']').replace(/,\s*}/g, '}');

  var events;
  try {
    events = JSON.parse(responseText);
  } catch (e) {
    throw new Error('Claude gaf geen valide JSON terug: ' + responseText.substring(0, 100) + '...');
  }

  if (!Array.isArray(events)) {
    throw new Error('Claude response is geen array');
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
  // Verwijder scripts, styles, nav, footer, sidebars — behoud content én nieuwsstream-posts
  // NB: <header> en class="news"/"blog" worden NIET meer verwijderd, want WordPress-sites
  // zoals Atelier Néerlandais plaatsen events in nieuws-articles en blog-wrappers.
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '')
    .replace(/<div[^>]*class="[^"]*(?:sidebar|widget|comment|social|share|cookie|banner|popup|modal|advertisement|ad-)[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 40000);
}

// ════════════════════════════════════════════════════════════════
// RUN
// ════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════
// HEALTH / STATUS voor externe dashboards (Cockpit)
// ════════════════════════════════════════════════════════════════

/**
 * Schrijft data/health.json met een machine-leesbare gezondheidsstatus.
 * Een dashboard kan dit pollen:
 *   - ok=false / status="degraded"  -> minstens één koppeling is gebroken
 *   - kapotte_koppelingen[]         -> welke bron, welke URL, welke fout
 *   - generated_at                  -> heartbeat; als dit > ~8 dagen oud is,
 *                                      draait de wekelijkse workflow zelf niet meer
 */
function writeHealth(data, warnings, vandaag, volgendeWeek, totaalEvents) {
  var downMap = {};
  var alleWebDown = null;
  warnings.forEach(function (w) {
    if (w.bron_id === 'alle-web-bronnen') { alleWebDown = w; return; }
    downMap[w.bron_id] = w;
  });

  function eventsVoor(id) {
    var ver = data.verenigingen.find(function (v) { return v.id === id; });
    return (ver && ver.events) ? ver.events.length : 0;
  }

  var bronnen = [];

  Object.keys(ICAL_BRONNEN).forEach(function (id) {
    var w = downMap[id];
    bronnen.push({
      id: id,
      naam: id.toUpperCase(),
      type: 'ical',
      status: w ? 'down' : 'ok',
      events: w ? 0 : eventsVoor(id),
      url: ICAL_BRONNEN[id],
      fout: w ? w.fout : null
    });
  });

  Object.keys(WEB_BRONNEN).forEach(function (id) {
    var config = WEB_BRONNEN[id];
    var urls = config.urlGenerator ? config.urlGenerator() : config.urls;
    var w = downMap[id] || alleWebDown;
    bronnen.push({
      id: id,
      naam: config.naam,
      type: 'web-scraping',
      status: w ? 'down' : 'ok',
      events: w ? 0 : eventsVoor(id),
      url: (urls || []).join(', '),
      fout: w ? w.fout : null
    });
  });

  var kapot = bronnen.filter(function (b) { return b.status === 'down'; });

  var health = {
    generated_at: new Date().toISOString(),
    ok: kapot.length === 0,
    status: kapot.length === 0 ? 'ok' : 'degraded',
    laatst_bijgewerkt: vandaag,
    volgende_update: volgendeWeek,
    totaal_events: totaalEvents,
    bronnen_totaal: bronnen.length,
    bronnen_ok: bronnen.length - kapot.length,
    bronnen_down: kapot.length,
    kapotte_koppelingen: kapot.map(function (b) {
      return { id: b.id, naam: b.naam, type: b.type, url: b.url, fout: b.fout };
    }),
    bronnen: bronnen
  };

  fs.writeFileSync(HEALTH_PATH, JSON.stringify(health, null, 2), 'utf-8');
  console.log('\nhealth.json: ' + health.status + ' (' + health.bronnen_down +
              ' kapot van ' + health.bronnen_totaal + ' bronnen)');
}

main().catch(function (err) {
  console.error('FATALE FOUT:', err);
  process.exit(2);
});
