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
    // Dynamische URL per maand — we pakken huidige + volgende 3 maanden
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
    urls: ['https://agendabourgogne.nl'],
    naam: 'Bourgondische Zaken'
  }
};

// Type-mapping voor normalisatie
const GELDIGE_TYPES = ['sociaal', 'sportief', 'cultureel', 'informatief', 'bestuurlijk', 'zakelijk', 'kerkdienst'];

// ════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════

async function main() {
  console.log('=== Verenigingen Kalender Update ===');
  console.log('Datum:', new Date().toISOString());
  console.log('');

  // Laad huidige data
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  const warnings = [];

  // ── 1. iCal-bronnen ──
  console.log('── iCal-bronnen ophalen ──');
  for (const [id, url] of Object.entries(ICAL_BRONNEN)) {
    console.log(`  ${id}: ${url}`);
    try {
      const events = await fetchIcalEvents(url, id);
      console.log(`  ✓ ${events.length} toekomstige events gevonden`);
      updateVereniging(data, id, events);
    } catch (err) {
      console.log(`  ✗ FOUT: ${err.message}`);
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
    console.log('\n⚠ GEMINI_API_KEY niet gevonden — web-bronnen worden overgeslagen');
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
        const events = await fetchWebEvents(id, config.naam, urls);
        console.log(`  ✓ ${events.length} toekomstige events geëxtraheerd`);
        updateVereniging(data, id, events);
      } catch (err) {
        console.log(`  ✗ FOUT: ${err.message}`);
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
    methode: 'Automatisch via GitHub Action (iCal feeds + Gemini AI web-extractie)',
    warnings: warnings.length
  };

  // ── 4. Schrijf data terug ──
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`\n✓ verenigingen.json bijgewerkt: ${totaalEvents} events van ${bronnenMetEvents} bronnen`);

  // ── 5. Warnings ──
  if (warnings.length > 0) {
    fs.writeFileSync(WARNINGS_PATH, JSON.stringify(warnings, null, 2), 'utf-8');
    console.log(`\n⚠ ${warnings.length} waarschuwing(en) — zie warnings.json`);
    warnings.forEach(function (w) {
      console.log(`  - ${w.bron_naam}: ${w.fout}`);
    });
    // Exit code 1 signaleert aan de workflow dat er warnings zijn
    process.exitCode = 1;
  } else {
    // Verwijder eventueel oud warnings-bestand
    if (fs.existsSync(WARNINGS_PATH)) fs.unlinkSync(WARNINGS_PATH);
    console.log('\n✓ Geen waarschuwingen');
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

  for (const key in parsed) {
    const item = parsed[key];
    if (item.type !== 'VEVENT') continue;

    const start = item.start;
    if (!start) continue;

    const datum = new Date(start);
    if (datum < now) continue; // alleen toekomstige events

    const event = {
      datum: formatDate(datum),
      titel: cleanText(item.summary || 'Onbekend event'),
      plaats: cleanText(item.location || 'niet vermeld'),
      tijd: formatTime(item),
      type: categoriseerType(item.summary, item.description),
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

  // Sorteer op datum
  events.sort(function (a, b) {
    return new Date(a.datum) - new Date(b.datum);
  });

  if (events.length === 0) {
    throw new Error('Geen toekomstige events gevonden in iCal-feed (mogelijk leeg of alleen verlopen events)');
  }

  return events;
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

      // Basisvalidatie: bevat de pagina überhaupt content?
      if (html.length < 500) {
        throw new Error('Pagina bevat vrijwel geen content');
      }

      // Strip onnodige HTML om tokens te besparen
      const stripped = stripHtml(html);
      alleHtml += `\n\n--- PAGINA: ${url} ---\n${stripped}`;

    } catch (err) {
      // Als één subpagina faalt, proberen we de rest nog
      console.log(`    Subpagina ${url}: ${err.message}`);
    }
  }

  if (alleHtml.trim().length < 100) {
    throw new Error(`Geen bruikbare HTML opgehaald van ${urls.length} pagina('s)`);
  }

  // Stuur naar Gemini
  const vandaag = new Date().toISOString().split('T')[0];

  const prompt = `Je bent een data-extractie assistent voor een Nederlandse evenementenkalender.

OPDRACHT: Extraheer ALLE toekomstige evenementen uit onderstaande HTML van de website van "${bronNaam}".

REGELS:
- Vandaag is ${vandaag}. Geef ALLEEN events vanaf vandaag.
- Geef het resultaat als een JSON array (geen markdown, geen backticks, geen uitleg).
- Elk object heeft exact deze velden:
  {
    "datum": "YYYY-MM-DD",
    "titel": "naam van het event",
    "plaats": "locatie of 'niet vermeld'",
    "tijd": "tijdstip of 'niet vermeld'",
    "type": "sociaal|sportief|cultureel|informatief|bestuurlijk|zakelijk|kerkdienst"
  }
- Als je GEEN events vindt, geef dan een lege array: []
- Geef ALLEEN de JSON array terug, niets anders.

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
    signal: AbortSignal.timeout(30000)
  });

  if (!geminiResponse.ok) {
    const errText = await geminiResponse.text();
    throw new Error(`Gemini API fout HTTP ${geminiResponse.status}: ${errText.substring(0, 200)}`);
  }

  const geminiData = await geminiResponse.json();

  // Extraheer tekst uit Gemini response
  let responseText = '';
  try {
    responseText = geminiData.candidates[0].content.parts[0].text;
  } catch (e) {
    throw new Error('Onverwacht Gemini response-formaat');
  }

  // Strip markdown backticks en eventuele tekst voor/na de JSON array
  responseText = responseText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

  // Zoek de JSON array in de response
  var jsonStart = responseText.indexOf('[');
  var jsonEnd = responseText.lastIndexOf(']');
  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error('Geen JSON array gevonden in Gemini response');
  }
  responseText = responseText.substring(jsonStart, jsonEnd + 1);

  // Fix veelvoorkomende JSON-fouten
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

  // Valideer en normaliseer events
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  const validated = [];
  events.forEach(function (ev) {
    if (!ev.datum || !ev.titel) return;

    const datum = new Date(ev.datum);
    if (isNaN(datum.getTime())) return;
    if (datum < now) return;

    validated.push({
      datum: formatDate(datum),
      titel: cleanText(ev.titel),
      plaats: cleanText(ev.plaats || 'niet vermeld'),
      tijd: cleanText(ev.tijd || 'niet vermeld'),
      type: normaliseType(ev.type),
      bron: urls[0] // eerste URL als bronvermelding
    });
  });

  validated.sort(function (a, b) {
    return new Date(a.datum) - new Date(b.datum);
  });

  return validated;
}

// ════════════════════════════════════════════════════════════════
// DATA MERGE
// ════════════════════════════════════════════════════════════════

function updateVereniging(data, id, nieuwEvents) {
  const ver = data.verenigingen.find(function (v) { return v.id === id; });
  if (!ver) {
    console.log(`    ⚠ Vereniging "${id}" niet gevonden in JSON — events overgeslagen`);
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

  // Als het een hele-dag-event is (geen uren)
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

function categoriseerType(summary, description) {
  const tekst = ((summary || '') + ' ' + (description || '')).toLowerCase();

  if (/kerk|dienst|preek|dominee|ds\./i.test(tekst)) return 'kerkdienst';
  if (/golf|wandel|jeu de boules|pétanque|petanque|padel|zeil|ski|sport|trail|rally/i.test(tekst)) return 'sportief';
  if (/ALV|ledenvergadering|bestuur/i.test(tekst)) return 'bestuurlijk';
  if (/expo|concert|museum|cultuur|lezing|dictee|music|kunst|boek/i.test(tekst)) return 'cultureel';
  if (/workshop|cursus|info|presentatie|causerie|mindfulness/i.test(tekst)) return 'informatief';
  if (/showroom|fashion|business|zakelijk/i.test(tekst)) return 'zakelijk';
  if (/borrel|lunch|diner|bijpraat|paas|nieuwjaar|puzzel|bridge/i.test(tekst)) return 'sociaal';

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
  // Verwijder scripts, styles, nav, footer — behoud de content
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 15000); // Beperk tokens naar Gemini
}

// ════════════════════════════════════════════════════════════════
// RUN
// ════════════════════════════════════════════════════════════════

main().catch(function (err) {
  console.error('FATALE FOUT:', err);
  process.exit(2);
});
