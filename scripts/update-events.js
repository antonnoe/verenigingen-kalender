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

// Nieuwsfeeds van verenigingen (RSS). Gevalideerd juli 2026; bronnen zonder
// werkende feed (NVLR, NEDAZUR, ANM, FANF — websitebuilders) staan er bewust niet in.
const NIEUWS_PATH = path.join(__dirname, '..', 'data', 'nieuws.json');
const NIEUWS_BRONNEN = {
  // type 'rss': standaard RSS-feed
  'nlvp':                { naam: 'NLVP',                type: 'rss', feed: 'https://nlvp.fr/feed/' },
  'latulipe':            { naam: 'La Tulipe',           type: 'rss', feed: 'https://www.latulipe.net/?format=feed&type=rss' },
  'atelier-neerlandais': { naam: 'Atelier N\u00e9erlandais', type: 'rss', feed: 'https://atelierneerlandais.com/feed/' },
  'ern-paris':           { naam: 'ERN Paris',           type: 'rss', feed: 'https://ernparis.fr/feed/' },
  'lotgenoten':          { naam: 'LOTgenoten',          type: 'rss', feed: 'https://www.lotgenoten.fr/feed/' },
  'neerlandia-toulouse': { naam: 'Neerlandia Toulouse', type: 'rss', feed: 'https://www.neerlandia.fr/?format=feed&type=rss' },
  // type 'congressus': verenigingsplatform zonder RSS maar met uniforme
  // /nieuws-pagina (publication-items met machine-leesbare datums)
  'nvlr':                { naam: 'NVLR',    type: 'congressus', feed: 'https://www.nvlr.eu/nieuws' },
  'nedazur':             { naam: 'NEDAZUR', type: 'congressus', feed: 'https://www.nedazur.org/nieuws' },
  'anm':                 { naam: 'ANM',     type: 'congressus', feed: 'https://www.a-n-m.nl/nieuws' },
  // Aanvullende RSS-bronnen (geverifieerd juli 2026)
  'bourgondische-zaken': { naam: 'Bourgondische Zaken', type: 'rss', feed: 'https://bourgondischezaken.com/feed/' },
  'dbcra':               { naam: 'DBCRA',               type: 'rss', feed: 'https://dbcra.nl/feed/' },
  // 'aap' UITGESCHAKELD 15-07-2026: alpespaysbas.fr is gecompromitteerd
  // (casino-spam in meerdere talen via hun WordPress). Pas heractiveren
  // nadat de vereniging haar site heeft opgeschoond.
  // 'aap':              { naam: 'Alpes\u2013Pays-Bas',     type: 'rss', feed: 'https://alpespaysbas.fr/?feed=rss2' },
  'praatje':             { naam: 'Praatje',             type: 'rss', feed: 'https://praatje.fr/feed/' },
  'cmunf':               { naam: 'CMUnf',               type: 'rss', feed: 'https://cmunf.fr/nieuws?format=feed&type=rss' },
  // type 'fanf': Joomla-site met uitgeschakelde feeds; deterministische
  // HTML-parser op de o-card-blokken van de nieuwsrubriek
  'fanf':                { naam: 'FANF', type: 'fanf', feed: 'https://www.fanf.fr/informatie/nieuws/fanf-nieuws' },
  // Ning-rubriek "Clubs, Verenigingen en Bijeenkomsten" op Nederlanders.fr.
  // NB: niet verifieerbaar vanuit de ontwikkelomgeving (netwerkblokkade richting
  // dit domein); de eerste workflow-run bevestigt. Faalt de URL, dan meldt
  // health.json dat met oorzaak-categorie — verwijder dan deze regel of pas de URL aan.
  // tagFilter: Ning's tag-parameter in de feed-URL is onbetrouwbaar (levert
  // vaak álle blogposts). Daarom filtert het script zelf op de <category>-tags
  // van elk item; alleen items met deze rubriek komen door.
  // userAgent-override: Ning weert verkeer met bot-achtige User-Agents (5xx);
  // met een volledige browser-UA maakt de fetch mogelijk wel kans.
  'nederlanders-fr':     { naam: 'Nederlanders.fr', type: 'rss',
    tagFilter: 'clubs, verenigingen en bij\u00e9\u00e9nkomsten',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    feed: 'https://www.nederlanders.fr/profiles/blog/feed?tag=Clubs%2C+Verenigingen+en+Bij%C3%A9%C3%A9nkomsten&xn_auth=no' }
};
const NIEUWS_MAX_LEEFTIJD_DAGEN = 60;
const NIEUWS_MAX_PER_BRON = 6;

// Spamdetectie voor nieuwsitems. Vrijwilligerssites worden geregeld gehackt
// (casino/gok/pharma-injecties); dit filter voorkomt dat zulke berichten in
// de nieuws-tab belanden. Meertalig, want spam-campagnes zijn dat ook.
const NIEUWS_SPAM_PATRONEN = [
  /casino/i, /kaszin\u00f3/i, /\u03ba\u03b1\u03b6\u03af\u03bd\u03bf/i, /kasyno/i,
  /\bslots\b/i, /slotgame/i, /\bjackpot\b/i, /\bgokk(en|ast)/i,
  /\bbonus\s?code/i, /free\s?spins/i, /\bwedden\b/i, /\bbookmaker/i, /\bbetting\b/i,
  /\bviagra\b/i, /\bcialis\b/i, /\bpayday\s?loan/i, /\bcrypto\s?(casino|betting)/i,
  /\u0431\u0443\u043a\u043c\u0435\u043a\u0435\u0440/i, /\u043a\u0430\u0437\u0438\u043d\u043e/i
];

function isNieuwsSpam(titel, excerpt) {
  var t = (titel + ' ' + (excerpt || '')).substring(0, 500);
  for (var i = 0; i < NIEUWS_SPAM_PATRONEN.length; i++) {
    if (NIEUWS_SPAM_PATRONEN[i].test(t)) return true;
  }
  return false;
}

// Bronnen met WordPress REST API (posts als event-aankondiging).
// Datum + titel worden DETERMINISTISCH uit de posttitel geparseerd
// (patroon "28 juni – Koffieochtend"); AI wordt alleen gebruikt voor
// plaats/tijd/type-verrijking en kan de datum niet beïnvloeden.
const WORDPRESS_BRONNEN = {
  'nlvp': {
    site: 'https://nlvp.fr',
    naam: 'NLVP'
  }
};

// Bronnen met webpagina-agenda (via Claude AI geëxtraheerd)
const WEB_BRONNEN = {
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
// ROBUUSTHEID: retry, foutclassificatie, data-retentie
// ════════════════════════════════════════════════════════════════

/**
 * fetch met automatische retry bij tijdelijke fouten (netwerk, timeout,
 * HTTP 429/5xx). Backoff: 2s, dan 6s. Definitieve fouten (404, 403, formaat)
 * worden NIET opnieuw geprobeerd — die zijn niet tijdelijk.
 * Gooide fouten dragen .categorie en .httpStatus voor classificatie.
 */
async function fetchMetRetry(url, options, maxPogingen) {
  maxPogingen = maxPogingen || 3;
  var laatsteFout;
  for (var poging = 1; poging <= maxPogingen; poging++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;

      var err = new Error('HTTP ' + response.status + ' bij ' + url);
      err.httpStatus = response.status;
      if (response.status === 404 || response.status === 410) {
        err.categorie = 'verplaatst';
        throw err; // definitief — retry is zinloos
      }
      if (response.status === 401 || response.status === 403) {
        err.categorie = 'geblokkeerd';
        throw err; // definitief
      }
      err.categorie = (response.status === 429) ? 'geblokkeerd' : 'server';
      laatsteFout = err; // 429/5xx: mogelijk tijdelijk → retry
    } catch (e) {
      if (e.categorie === 'verplaatst' || (e.categorie === 'geblokkeerd' && e.httpStatus !== 429)) throw e;
      if (!e.categorie) e.categorie = 'netwerk'; // DNS, timeout, connectie
      laatsteFout = e;
    }
    if (poging < maxPogingen) {
      var wacht = poging === 1 ? 2000 : 6000;
      console.log(`    \u21bb poging ${poging} mislukt (${laatsteFout.message}) \u2014 retry over ${wacht / 1000}s`);
      await new Promise(function (r) { setTimeout(r, wacht); });
    }
  }
  throw laatsteFout;
}

/**
 * Vertaalt een fout naar een mensleesbare diagnose met oorzaak-categorie.
 * Doel: in health.json en GitHub-issues staat WAT er aan de hand is
 * ("site verbouwd", "bot-blokkade") in plaats van een kale stacktrace
 * die op een scriptbug lijkt.
 */
function classificeerFout(err) {
  var cat = err.categorie || 'intern';
  var msg = String(err.message || err);

  // Nadere detectie als de categorie nog niet gezet is
  if (cat === 'intern') {
    if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|abort|timeout|fetch failed/i.test(msg)) cat = 'netwerk';
    else if (/geen geldige iCal|geen array|ander formaat|titelpatroon/i.test(msg)) cat = 'formaat';
    else if (/Claude|Anthropic|API/i.test(msg)) cat = 'ai';
  }

  var UITLEG = {
    'netwerk':    { oorzaak: 'Site van de vereniging tijdelijk onbereikbaar (netwerk/DNS/timeout).',
                    advies: 'Geen actie nodig; volgende run probeert het opnieuw. Houdt dit aan na 3 runs: site is echt offline.' },
    'verplaatst': { oorzaak: 'Pagina of feed bestaat niet meer (HTTP 404/410) \u2014 de vereniging heeft haar site-inrichting gewijzigd.',
                    advies: 'GEEN scriptbug. Zoek de nieuwe agenda-URL op de site van de vereniging en pas de bronconfiguratie aan.' },
    'geblokkeerd':{ oorzaak: 'Toegang geweigerd (HTTP 401/403/429) \u2014 de site blokkeert geautomatiseerde toegang of beperkt het tempo.',
                    advies: 'GEEN scriptbug. Vraag de vereniging om een iCal-feed, of accepteer dat deze bron wegvalt.' },
    'server':     { oorzaak: 'Server van de vereniging geeft een foutmelding (HTTP 5xx).',
                    advies: 'Probleem ligt bij de vereniging; geen actie nodig tenzij het aanhoudt.' },
    'formaat':    { oorzaak: 'Bron is bereikbaar maar levert een ander gegevensformaat dan voorheen \u2014 vrijwel zeker een gewijzigde site-inrichting.',
                    advies: 'GEEN scriptbug. Bekijk de bron handmatig en pas de bronconfiguratie of parser aan.' },
    'inhoud':     { oorzaak: 'Pagina is bereikbaar maar er zijn geen events meer herkend waar dat eerder wel lukte \u2014 vermoedelijk gewijzigde pagina-opbouw.',
                    advies: 'Waarschijnlijk GEEN scriptbug. Bekijk de bron handmatig; mogelijk is de agenda verplaatst binnen de site.' },
    'ai':         { oorzaak: 'De AI-extractiedienst (Anthropic API) gaf een fout of was overbelast.',
                    advies: 'Tijdelijk; volgende run herstelt dit meestal vanzelf. Check anders de API-key en het tegoed.' },
    'config':     { oorzaak: 'Configuratieprobleem in de eigen omgeving (bv. ontbrekende API-key of secret).',
                    advies: 'Controleer de repository-secrets en workflow-instellingen; dit ligt niet aan de bronnen.' },
    'intern':     { oorzaak: 'Onverwachte fout in het script zelf.',
                    advies: 'Dit KAN een scriptbug zijn \u2014 bekijk de log hieronder.' }
  };

  var u = UITLEG[cat] || UITLEG['intern'];
  return { categorie: cat, oorzaak: u.oorzaak, advies: u.advies, technisch: msg.substring(0, 300) };
}

/** Houdt van bestaande events alleen de toekomstige over (voor data-retentie bij uitval). */
function filterToekomstig(events) {
  if (!Array.isArray(events)) return [];
  var now = new Date(); now.setHours(0, 0, 0, 0);
  return events.filter(function (e) {
    var d = new Date(e.datum);
    return !isNaN(d.getTime()) && d >= now;
  });
}

/** Leest de health.json van de vorige run als baseline (event-aantallen, laatste succes). */
function leesVorigeHealth() {
  try {
    var h = JSON.parse(fs.readFileSync(HEALTH_PATH, 'utf-8'));
    var map = {};
    (h.bronnen || []).forEach(function (b) { map[b.id] = b; });
    return map;
  } catch (e) {
    return {};
  }
}

/**
 * Uniforme afhandeling van een uitgevallen bron:
 * 1. classificeer de oorzaak (site verbouwd? blokkade? scriptbug?)
 * 2. behoud de laatst-goede toekomstige events i.p.v. de bron leeg te publiceren
 * 3. registreer een rijke waarschuwing voor health.json en het GitHub-issue
 */
function registreerBronFout(warnings, vorigeHealth, data, id, naam, type, url, err) {
  var diagnose = classificeerFout(err);
  var ver = data.verenigingen.find(function (v) { return v.id === id; });
  var behouden = 0;
  if (ver && Array.isArray(ver.events)) {
    ver.events = filterToekomstig(ver.events);
    behouden = ver.events.length;
  }
  var vorig = vorigeHealth[id] || {};
  console.log(`  \u2717 FOUT [${diagnose.categorie}]: ${diagnose.oorzaak}`);
  console.log(`    \u2192 ${diagnose.advies}`);
  if (behouden > 0) {
    console.log(`    \u2192 ${behouden} eerder opgehaalde toekomstige events blijven zichtbaar`);
  }
  warnings.push({
    bron_id: id,
    bron_naam: naam,
    type: type,
    url: url,
    fout: err.message,
    diagnose: diagnose,
    events_behouden: behouden,
    laatste_succes: vorig.laatste_succes || null,
    datum: new Date().toISOString()
  });
}

/**
 * Verdacht-detectie: bron is technisch bereikbaar maar levert plots 0 events
 * waar de vorige run er meerdere had. Dat is geen storing (geen rood) maar
 * verdient observatie: seizoensstop óf stilletjes gewijzigde site-inrichting.
 */
function checkVerdacht(observaties, vorigeHealth, id, naam, type, url, aantalNieuw) {
  var vorig = vorigeHealth[id];
  if (!vorig || aantalNieuw > 0) return;

  if (vorig.status === 'ok' && (vorig.events || 0) >= 2) {
    var melding = 'Bron bereikbaar maar 0 events herkend, waar de vorige run er ' + vorig.events +
      ' had. Mogelijke oorzaken: seizoensstop (onschuldig) of stilletjes gewijzigde site-inrichting. Even handmatig kijken.';
    console.log(`  \u26a0 OBSERVATIE: ${melding}`);
    observaties.push({ bron_id: id, bron_naam: naam, type: type, url: url, melding: melding, baseline: vorig.events });
  } else if (vorig.status === 'verdacht') {
    // Observatie houdt aan totdat de bron weer events levert of iemand ingrijpt.
    var vorigeMelding = (vorig.diagnose && vorig.diagnose.oorzaak) || '';
    var melding2 = 'Observatie houdt aan: bron levert nog steeds 0 events. ' +
      (vorigeMelding.indexOf('houdt aan') === -1 ? vorigeMelding : '');
    console.log(`  \u26a0 OBSERVATIE (aanhoudend): ${id}`);
    observaties.push({ bron_id: id, bron_naam: naam, type: type, url: url, melding: melding2.trim(), baseline: null });
  }
}

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
  const observaties = [];
  const vorigeHealth = leesVorigeHealth();
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
      checkVerdacht(observaties, vorigeHealth, id, id.toUpperCase(), 'ical', url, result.events.length);
    } catch (err) {
      registreerBronFout(warnings, vorigeHealth, data, id, id.toUpperCase(), 'ical', url, err);
    }
  }

  // ── 1b. WordPress REST API-bronnen ──
  console.log('\n── WordPress-bronnen ophalen ──');
  for (const [id, config] of Object.entries(WORDPRESS_BRONNEN)) {
    console.log(`  ${id}: ${config.site}`);
    try {
      const result = await fetchWordpressEvents(id, config.naam, config);
      console.log(`  \u2713 ${result.events.length} toekomstige events via ${result.kanaal} (datums deterministisch uit posttitels)`);
      updateVereniging(data, id, result.events);
      checkVerdacht(observaties, vorigeHealth, id, config.naam, 'wordpress-api', config.site, result.events.length);
    } catch (err) {
      registreerBronFout(warnings, vorigeHealth, data, id, config.naam, 'wordpress-api', config.site, err);
    }
  }

  // ── 2. Web-bronnen via Claude ──
  if (!ANTHROPIC_API_KEY) {
    console.log('\n\u26a0 ANTHROPIC_API_KEY niet gevonden \u2014 web-bronnen worden overgeslagen');
    var keyErr = new Error('ANTHROPIC_API_KEY ontbreekt als environment variable');
    keyErr.categorie = 'config';
    warnings.push({
      bron_id: 'alle-web-bronnen',
      bron_naam: 'Alle web-bronnen',
      type: 'config',
      fout: keyErr.message,
      diagnose: classificeerFout(keyErr),
      datum: new Date().toISOString()
    });
    // Retentie ook hier: behoud laatst-goede toekomstige events per web-bron
    Object.keys(WEB_BRONNEN).forEach(function (wid) {
      var ver = data.verenigingen.find(function (v) { return v.id === wid; });
      if (ver && Array.isArray(ver.events)) ver.events = filterToekomstig(ver.events);
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
        checkVerdacht(observaties, vorigeHealth, id, config.naam, 'web-scraping', urls.join(', '), result.events.length);
      } catch (err) {
        registreerBronFout(warnings, vorigeHealth, data, id, config.naam, 'web-scraping', urls.join(', '), err);
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

  // ── 3b. Nieuws van de verenigingen (RSS) ──
  console.log('\n\u2500\u2500 Nieuwsfeeds ophalen \u2500\u2500');
  var nieuwsSamenvatting = null;
  try {
    nieuwsSamenvatting = await verzamelNieuws(warnings);
  } catch (err) {
    // Nieuws is secundair: een totale mislukking mag de kalender-update nooit blokkeren.
    console.log(`  \u2717 Nieuwsverzameling volledig mislukt: ${err.message}`);
    nieuwsSamenvatting = { status: 'degraded', items: 0, bronnen_down: Object.keys(NIEUWS_BRONNEN).length };
  }

  // ── 4. Meta bijwerken ──
  const vandaag = new Date().toISOString().split('T')[0];
  // Volgende geplande run: eerstvolgende maandag (1), woensdag (3) of vrijdag (5)
  // conform het cron-schema in .github/workflows/update-kalender.yml.
  const volgendeWeek = (function () {
    const d = new Date();
    do { d.setDate(d.getDate() + 1); } while ([1, 3, 5].indexOf(d.getDay()) === -1);
    return d.toISOString().split('T')[0];
  })();

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
  writeHealth(data, warnings, vandaag, volgendeWeek, totaalEvents, observaties, vorigeHealth, nieuwsSamenvatting);
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
  // ── Wekelijks patroon: elke <weekdag>, <aantal_weken> vooruit ──
  if (ritme.patroon === 'wekelijks') {
    const weekdagW = ritme.weekdag; // 0=zo .. 6=za
    const aantalWeken = ritme.aantal_weken || 8;
    const nu = new Date();
    nu.setHours(0, 0, 0, 0);
    const eerste = new Date(nu);
    eerste.setDate(nu.getDate() + ((weekdagW - nu.getDay() + 7) % 7)); // vandaag telt mee
    const eventsW = [];
    for (let w = 0; w < aantalWeken; w++) {
      const d = new Date(eerste);
      d.setDate(eerste.getDate() + w * 7);
      eventsW.push({
        titel: ritme.titel || 'Wekelijkse ontmoeting',
        datum: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'),
        tijd: ritme.tijd || '',
        plaats: ritme.plaats || '',
        type: ritme.type || 'sociaal',
        bron: ritme.bron_url || 'vast ritme (automatisch gegenereerd)'
      });
    }
    return eventsW;
  }

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
  const response = await fetchMetRetry(url, {
    headers: { 'User-Agent': 'VerenigingenKalender/1.0' },
    signal: AbortSignal.timeout(15000)
  });

  const text = await response.text();

  if (!text.includes('BEGIN:VCALENDAR')) {
    var err = new Error('Antwoord is geen geldige iCal-data (BEGIN:VCALENDAR ontbreekt)');
    err.categorie = 'formaat';
    throw err;
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

  // Een geldige maar lege feed (seizoensstop) is GEEN fout; de
  // verdacht-detectie in main() signaleert het als de bron eerder wél events had.
  return { events: events, gefilterd: gefilterd };
}

// ════════════════════════════════════════════════════════════════
// WORDPRESS REST API (posts als event-aankondiging)
// ════════════════════════════════════════════════════════════════

/**
 * Decodeert HTML-entities zoals de WordPress REST API die teruggeeft
 * (bv. "&#8211;" voor het streepje in "28 juni – Koffieochtend").
 * Zonder deze stap matcht de titelparser niet.
 */
function decodeEntities(str) {
  var NAMED = {
    'amp': '&', 'lt': '<', 'gt': '>', 'quot': '"', 'apos': "'",
    'nbsp': ' ', 'eacute': '\u00e9', 'egrave': '\u00e8', 'ecirc': '\u00ea',
    'agrave': '\u00e0', 'ccedil': '\u00e7', 'ucirc': '\u00fb', 'ocirc': '\u00f4',
    'ndash': '\u2013', 'mdash': '\u2014', 'hellip': '\u2026',
    'lsquo': '\u2018', 'rsquo': '\u2019', 'ldquo': '\u201c', 'rdquo': '\u201d'
  };
  return String(str || '')
    .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) { return String.fromCodePoint(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCodePoint(parseInt(d, 10)); })
    .replace(/&([a-zA-Z]+);/g, function (m, naam) { return NAMED[naam] !== undefined ? NAMED[naam] : m; });
}

/**
 * Parseert een event uit een WordPress-posttitel volgens het patroon
 * "28 juni – Koffieochtend" (streepje-variaties en hoofdletters toegestaan).
 * Het jaar wordt afgeleid van de publicatiedatum: de eerstvolgende
 * dag+maand op of na de publicatiedatum. Retourneert null bij geen match.
 */
function parseEventUitPostTitel(titelRaw, postDatum) {
  var titel = String(titelRaw || '').trim();
  // Ondersteunt ook bereiken: "24 en 25 mei – ...", "17->28 juli – ..." (startdag telt)
  var m = titel.match(/^(\d{1,2})(?:\s*(?:->|\u2192|t\/m|tot(?:\s+en\s+met)?|en|et|,|[\u2013\u2014-])\s*\d{1,2})?\s+([a-zA-Z\u00e0-\u00fc]+)\s*[\u2013\u2014-]\s*(.+)$/);
  if (!m) return null;

  var dag = parseInt(m[1], 10);
  var maand = MAAND_NAMEN[m[2].toLowerCase()];
  var eventTitel = m[3].trim();
  if (!maand || dag < 1 || dag > 31 || !eventTitel) return null;

  // Jaar: eerstvolgende voorkomen op of (vlak) na de publicatiedatum.
  var pub = new Date(postDatum);
  if (isNaN(pub.getTime())) return null;
  var slack = new Date(pub); slack.setDate(slack.getDate() - 1);

  var kandidaat = new Date(pub.getFullYear(), maand - 1, dag);
  if (kandidaat < slack) {
    kandidaat = new Date(pub.getFullYear() + 1, maand - 1, dag);
  }

  return { datum: kandidaat, titel: eventTitel };
}

async function fetchWordpressEvents(bronId, bronNaam, config) {
  const site = config.site.replace(/\/$/, '');
  let posts = null;
  let kanaal = 'wp-json';

  // ── Primair kanaal: REST API ──
  try {
    const apiUrl = site + '/wp-json/wp/v2/posts?per_page=30&_fields=date,title,link,content';
    const response = await fetchMetRetry(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; VerenigingenKalender/1.0)',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(15000)
    });
    const json = await response.json();
    if (!Array.isArray(json)) {
      var fErr = new Error('REST API gaf geen array terug \u2014 ander formaat dan verwacht');
      fErr.categorie = 'formaat';
      throw fErr;
    }
    posts = json.map(function (p) {
      return {
        date: p.date,
        titel: (p.title && p.title.rendered) || '',
        link: p.link || site,
        content: (p.content && p.content.rendered) || ''
      };
    });
  } catch (apiErr) {
    // ── Noodkanaal: RSS-feed (standaard aanwezig op elke WordPress-site) ──
    console.log(`    \u26a0 REST API faalde (${apiErr.message}) \u2014 val terug op RSS-feed`);
    try {
      posts = await fetchWordpressViaRss(site);
      kanaal = 'rss';
    } catch (rssErr) {
      // Beide kanalen dood → de oorspronkelijke (meest informatieve) fout gooien
      throw apiErr;
    }
  }

  const now = new Date();
  now.setHours(0, 0, 0, 0);

  // ── Stap 1: deterministisch datum + titel uit posttitels ──
  const kandidaten = [];
  const gezien = {};
  let herkend = 0;
  posts.forEach(function (post) {
    var titelRaw = cleanText(decodeEntities(post.titel));
    var parsed = parseEventUitPostTitel(titelRaw, post.date);
    if (!parsed) return;                 // geen event-aankondiging (bv. "Fijne feestdagen !")
    herkend++;
    if (parsed.datum < now) return;      // voorbij

    var sleutel = formatDate(parsed.datum) + '|' + parsed.titel.toLowerCase();
    if (gezien[sleutel]) return;         // dubbele aankondiging
    gezien[sleutel] = true;

    var content = post.content ? decodeEntities(stripHtml(post.content)) : '';
    kandidaten.push({
      datum: parsed.datum,
      titel: parsed.titel,
      content: content.substring(0, 1500),
      link: post.link
    });
  });

  // Structuurbewaking: veel posts maar nul herkende titels betekent dat het
  // titelpatroon ("28 juni – Koffieochtend") is losgelaten → site-inrichting gewijzigd.
  if (posts.length >= 10 && herkend === 0) {
    var pErr = new Error('Titelpatroon niet meer herkend in ' + posts.length + ' posts \u2014 aankondigingsformaat gewijzigd');
    pErr.categorie = 'formaat';
    throw pErr;
  }

  if (kandidaten.length === 0) {
    // Geen toekomstige aankondigingen is een geldig resultaat (bv. zomerstop),
    // géén fout — de bron werkt, er is alleen niets aangekondigd.
    return { events: [], gefilterd: 0, kanaal: kanaal };
  }

  // ── Stap 2: plaats/tijd/type-verrijking via Claude (optioneel) ──
  // De datum staat al vast en is voor het model onbereikbaar.
  var verrijking = {};
  if (ANTHROPIC_API_KEY) {
    try {
      verrijking = await verrijkWordpressEvents(kandidaten);
    } catch (err) {
      console.log(`    \u26a0 Verrijking mislukt (${err.message}) \u2014 events zonder plaats/tijd gepubliceerd`);
    }
  }

  const events = kandidaten.map(function (k, i) {
    var v = verrijking[i] || {};
    return {
      datum: formatDate(k.datum),
      titel: k.titel,
      plaats: cleanText(v.plaats || 'niet vermeld'),
      tijd: cleanText(v.tijd || 'niet vermeld'),
      type: normaliseType(v.type),
      bron: k.link
    };
  });

  events.sort(function (a, b) { return new Date(a.datum) - new Date(b.datum); });
  return { events: events, gefilterd: 0, kanaal: kanaal };
}

/**
 * Noodkanaal: leest events uit de standaard WordPress RSS-feed (/feed/).
 * Levert hetzelfde post-formaat als het REST API-pad, zodat de
 * deterministische titelparser ongewijzigd werkt.
 */
async function fetchWordpressViaRss(site) {
  const response = await fetchMetRetry(site + '/feed/', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VerenigingenKalender/1.0)' },
    signal: AbortSignal.timeout(15000)
  });
  const xml = await response.text();
  if (xml.indexOf('<rss') === -1 && xml.indexOf('<feed') === -1) {
    var err = new Error('RSS-feed levert geen geldige XML');
    err.categorie = 'formaat';
    throw err;
  }

  const posts = parseRssItems(xml).map(function (it) {
    return { date: it.date, titel: it.titel, link: it.link || site, content: it.content };
  });

  if (posts.length === 0) {
    var leeg = new Error('RSS-feed bevat geen items');
    leeg.categorie = 'formaat';
    throw leeg;
  }
  return posts;
}

/**
 * Verwijdert CMS-shortcodes die als platte tekst in feeds lekken,
 * zoals Joomla "{gallery}foto/x{/gallery}" en WordPress "[caption]...[/caption]".
 */
function stripShortcodes(tekst) {
  return String(tekst || '')
    // Gepaarde blokken inclusief inhoud: {gallery}foto/x{/gallery}, [caption]...[/caption]
    .replace(/\{(\w+)[^{}]*\}[\s\S]*?\{\/\1\}/g, ' ')
    .replace(/\[(\w+)[^\[\]]*\][\s\S]*?\[\/\1\]/g, ' ')
    // Losse resten: {loadposition x}, [embed x]
    .replace(/\{\/?[a-zA-Z][^{}]*\}/g, ' ')
    .replace(/\[\/?[a-zA-Z][^\[\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Generieke RSS-item-parser (WordPress- en Joomla-feeds). */
function parseRssItems(xml) {
  const result = [];
  const items = xml.split(/<item[\s>]/).slice(1);
  items.forEach(function (blok) {
    function pak(tag) {
      var m = blok.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>'));
      if (!m) return '';
      return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
    }
    var pub = new Date(pak('pubDate'));
    if (isNaN(pub.getTime())) return;
    // Alle <category>-elementen (Ning/WordPress zetten tags hierin)
    var categorieen = [];
    var reCat = /<category[^>]*>([\s\S]*?)<\/category>/g, cm;
    while ((cm = reCat.exec(blok)) !== null) {
      categorieen.push(cm[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim());
    }
    result.push({
      date: pub.toISOString(),
      titel: pak('title'),
      link: pak('link'),
      content: pak('content:encoded') || pak('description'),
      categorieen: categorieen
    });
  });
  return result;
}

/**
 * Parser voor Congressus-nieuwspagina's (NVLR, NEDAZUR, ANM).
 * Volledig deterministisch: datum uit <time data-datetime>, titel/link uit <h3>,
 * excerpt uit de eerste paragraaf. Geen AI nodig.
 */
function parseCongressusNieuws(html, basisUrl) {
  const result = [];
  const blokken = html.split(/class="row publication-item"/).slice(1);
  blokken.forEach(function (blok) {
    var mTijd = blok.match(/data-datetime="(\d{4}-\d{2}-\d{2})[^"]*"/);
    var mTitel = blok.match(/<h3>\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h3>/);
    if (!mTijd || !mTitel) return;
    var mExcerpt = blok.match(/<\/h3>\s*<p>([\s\S]*?)<\/p>/);
    var link = mTitel[1];
    if (link.indexOf('http') !== 0) {
      link = basisUrl.replace(/\/nieuws\/?$/, '') + link;
    }
    result.push({
      date: mTijd[1] + 'T12:00:00.000Z',
      titel: mTitel[2],
      link: link,
      content: mExcerpt ? mExcerpt[1] : ''
    });
  });
  return result;
}

/**
 * Parser voor de FANF-nieuwsrubriek (Joomla, feeds uitgeschakeld).
 * Deterministisch: o-card-blokken met titel in h2 en een Nederlandse
 * datum ("5 mei 2026") aan het begin van de beschrijving.
 */
function parseFanfNieuws(html, basisUrl) {
  const result = [];
  const basis = basisUrl.match(/^https?:\/\/[^\/]+/)[0];
  const blokken = html.split(/<article class="o-card/).slice(1);
  const maandAlt = Object.keys(MAAND_NAMEN).join('|');
  const reDatum = new RegExp('(\\d{1,2})\\s+(' + maandAlt + ')\\s+(\\d{4})', 'i');

  blokken.forEach(function (blok) {
    var mTitel = blok.match(/o-card__title">([\s\S]*?)<\/h2>/);
    if (!mTitel) return;
    var mBeschr = blok.match(/o-card__description">([\s\S]*?)<\/section>/);
    var beschrijving = mBeschr ? stripHtml(mBeschr[1]) : '';
    var mDatum = beschrijving.match(reDatum);
    if (!mDatum) return; // zonder datum geen betrouwbaar nieuwsitem
    var maand = MAAND_NAMEN[mDatum[2].toLowerCase()];
    if (!maand) return;
    var iso = mDatum[3] + '-' + String(maand).padStart(2, '0') + '-' + String(+mDatum[1]).padStart(2, '0');

    // Link: de "lees meer"-knop is het artikel zelf; links ín de tekst
    // verwijzen vaak extern (monumentenregisters, nieuwsbrief-CDN's)
    var mLink = blok.match(/<a[^>]*class="button"[^>]*href="([^"]+)"/) ||
                blok.match(/<a[^>]*href="([^"]*nieuws[^"]*)"/) ||
                blok.match(/<a[^>]*href="([^"]+)"/);
    var link = mLink ? mLink[1] : basisUrl;
    if (link.indexOf('http') !== 0) link = basis + '/' + link.replace(/^\//, '');

    // Datumregel uit de excerpt knippen; die staat al in het datumblok
    var excerpt = beschrijving.replace(reDatum, '').trim();

    result.push({
      date: iso + 'T12:00:00.000Z',
      titel: stripHtml(mTitel[1]),
      link: link,
      content: excerpt
    });
  });
  return result;
}

// ════════════════════════════════════════════════════════════════
// NIEUWS VAN DE VERENIGINGEN (RSS + Congressus + FANF → data/nieuws.json)
// ════════════════════════════════════════════════════════════════

/**
 * Verzamelt recent nieuws uit de RSS-feeds van verenigingen.
 * Zelfde robuustheid als de kalenderbronnen: retry, oorzaak-classificatie
 * en retentie (bij een kapotte feed blijven de eerder opgehaalde items staan).
 * Schrijft data/nieuws.json; de nieuws-tab in index.html leest die same-origin,
 * want de feeds zelf zijn door CORS niet direct vanuit de browser op te halen.
 */
async function verzamelNieuws(warnings) {
  // Vorige nieuws.json als retentiebasis
  var vorig = {};
  try {
    var v = JSON.parse(fs.readFileSync(NIEUWS_PATH, 'utf-8'));
    (v.items || []).forEach(function (it) {
      (vorig[it.bron_id] = vorig[it.bron_id] || []).push(it);
    });
  } catch (e) { /* eerste run: geen vorige data */ }

  var alleItems = [];
  var bronStatus = [];
  var grens = Date.now() - NIEUWS_MAX_LEEFTIJD_DAGEN * 24 * 60 * 60 * 1000;

  for (const [id, cfg] of Object.entries(NIEUWS_BRONNEN)) {
    console.log(`  ${id}: ${cfg.feed}`);
    try {
      const response = await fetchMetRetry(cfg.feed, {
        headers: { 'User-Agent': cfg.userAgent || 'Mozilla/5.0 (compatible; VerenigingenKalender/1.0)' },
        signal: AbortSignal.timeout(15000)
      });
      const body = await response.text();

      var ruweItems;
      if (cfg.type === 'congressus') {
        ruweItems = parseCongressusNieuws(body, cfg.feed);
        if (ruweItems.length === 0) {
          var cErr = new Error('Geen publication-items herkend \u2014 pagina-opbouw gewijzigd');
          cErr.categorie = 'formaat';
          throw cErr;
        }
      } else if (cfg.type === 'fanf') {
        ruweItems = parseFanfNieuws(body, cfg.feed);
        if (ruweItems.length === 0) {
          var fnErr = new Error('Geen o-card-nieuwsitems herkend \u2014 pagina-opbouw gewijzigd');
          fnErr.categorie = 'formaat';
          throw fnErr;
        }
      } else {
        if (body.indexOf('<rss') === -1 && body.indexOf('<feed') === -1) {
          var fErr = new Error('Feed levert geen geldige RSS/XML \u2014 formaat gewijzigd');
          fErr.categorie = 'formaat';
          throw fErr;
        }
        ruweItems = parseRssItems(body);
      }

      var items = ruweItems
        .filter(function (it) {
          // Rubriekfilter (indien geconfigureerd): item moet de tag dragen.
          if (!cfg.tagFilter) return true;
          var doel = cfg.tagFilter.toLowerCase();
          return (it.categorieen || []).some(function (c) {
            var cat = cleanText(decodeEntities(c)).toLowerCase();
            // accent-tolerant: 'bijeenkomsten' vs 'bij\u00e9\u00e9nkomsten'
            return cat === doel ||
                   cat.normalize('NFD').replace(/[\u0300-\u036f]/g, '') ===
                   doel.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          });
        })
        .filter(function (it) { return new Date(it.date).getTime() >= grens; })
        .filter(function (it) {
          // Nationale nieuwskoppen (NOS/NU.nl-embeds) weren, net als bij events
          var t = cleanText(decodeEntities(it.titel));
          return !detecteerNieuwskop(t).isNieuws;
        })
        .slice(0, NIEUWS_MAX_PER_BRON)
        .map(function (it) {
          var excerpt = stripShortcodes(cleanText(decodeEntities(stripHtml(it.content || ''))));
          if (excerpt.length > 280) excerpt = excerpt.substring(0, 277).replace(/\s+\S*$/, '') + '\u2026';
          return {
            bron_id: id,
            bron_naam: cfg.naam,
            datum: it.date.split('T')[0],
            titel: cleanText(decodeEntities(it.titel)).substring(0, 140),
            link: it.link,
            excerpt: excerpt
          };
        });

      // Spamfilter: gehackte bron mag nooit doorlekken naar de nieuws-tab.
      var voorSpam = items.length;
      items = items.filter(function (it) { return !isNieuwsSpam(it.titel, it.excerpt); });
      var spamGeweerd = voorSpam - items.length;

      alleItems = alleItems.concat(items);

      // Veel spam = bron vrijwel zeker gecompromitteerd → als verdacht markeren
      if (spamGeweerd >= 3 || (spamGeweerd > 0 && items.length === 0)) {
        var spamDiag = { categorie: 'formaat',
          oorzaak: spamGeweerd + ' van ' + voorSpam + ' items geweerd als spam \u2014 de site van deze vereniging is vermoedelijk gehackt.',
          advies: 'Informeer de vereniging (WordPress/Joomla-injectie). Overweeg de bron tijdelijk uit te schakelen.' };
        bronStatus.push({ id: id, naam: cfg.naam, status: 'verdacht', items: items.length,
                          spam_geweerd: spamGeweerd, feed: cfg.feed, diagnose: spamDiag });
        console.log(`  \u26a0 ${spamGeweerd} spam-items geweerd \u2014 bron vermoedelijk gecompromitteerd`);
      } else {
        bronStatus.push({ id: id, naam: cfg.naam, status: 'ok', items: items.length,
                          spam_geweerd: spamGeweerd, feed: cfg.feed, diagnose: null });
        console.log(`  \u2713 ${items.length} nieuwsberichten` + (spamGeweerd ? ` (${spamGeweerd} spam geweerd)` : ''));
      }
    } catch (err) {
      var diagnose = classificeerFout(err);
      var behouden = vorig[id] || [];
      alleItems = alleItems.concat(behouden);
      console.log(`  \u2717 FOUT [${diagnose.categorie}]: ${diagnose.oorzaak}`);
      if (behouden.length > 0) console.log(`    \u2192 ${behouden.length} eerdere nieuwsitems blijven zichtbaar`);
      bronStatus.push({ id: id, naam: cfg.naam, status: 'down', items: behouden.length,
                        stale: behouden.length > 0, feed: cfg.feed, diagnose: diagnose });
      warnings.push({
        bron_id: 'nieuws-' + id,
        bron_naam: cfg.naam + ' (nieuwsfeed)',
        type: 'rss-nieuws',
        url: cfg.feed,
        fout: err.message,
        diagnose: diagnose,
        datum: new Date().toISOString()
      });
    }
  }

  alleItems.sort(function (a, b) { return new Date(b.datum) - new Date(a.datum); });

  var nieuws = {
    generated_at: new Date().toISOString(),
    totaal: alleItems.length,
    bronnen: bronStatus,
    items: alleItems
  };
  fs.writeFileSync(NIEUWS_PATH, JSON.stringify(nieuws, null, 2), 'utf-8');
  console.log(`  nieuws.json geschreven: ${alleItems.length} items van ${bronStatus.filter(function (b) { return b.status === 'ok'; }).length}/${bronStatus.length} feeds`);

  return {
    status: bronStatus.some(function (b) { return b.status === 'down'; }) ? 'degraded' : 'ok',
    items: alleItems.length,
    bronnen_down: bronStatus.filter(function (b) { return b.status === 'down'; }).length
  };
}

/**
 * Vraagt Claude per kandidaat-event plaats, tijd en type uit de posttekst.
 * Elke claim moet vergezeld gaan van een letterlijk citaat (bron_tekst) dat
 * tegen de tekst van de betreffende post wordt geverifieerd. Niet-verifieerbare
 * claims worden genegeerd; het event zelf blijft altijd staan.
 */
async function verrijkWordpressEvents(kandidaten) {
  const lijst = kandidaten.map(function (k, i) {
    return `### EVENT ${i}\nTitel: ${k.titel}\nDatum: ${formatDate(k.datum)}\nPosttekst:\n${k.content}`;
  }).join('\n\n');

  const prompt = `Je krijgt aankondigingen van verenigingsevents. Per event: haal locatie, tijd en type uit de posttekst.

REGELS:
- De datum en titel staan al vast; die geef je NIET terug en wijzig je NIET.
- "bron_tekst": letterlijk citaat (max 150 tekens) uit de posttekst van DAT event waarin de plaats en/of tijd staat. Exact kopiëren, niet herformuleren.
- Staat er geen plaats of tijd in de tekst: gebruik "niet vermeld" en laat bron_tekst leeg.
- Tijd noteren als HH:MM of HH:MM-HH:MM ("half elf" = 10:30).

OUTPUT: alleen een JSON array, één object per event, in dezelfde volgorde:
[{"index": 0, "plaats": "...", "tijd": "...", "type": "sociaal|sportief|cultureel|informatief|bestuurlijk|zakelijk|kerkdienst", "bron_tekst": "..."}]

${lijst}`;

  let resp;
  try {
    resp = await fetchMetRetry(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 4096,
      temperature: 0.1,
      messages: [{ role: 'user', content: prompt }]
    }),
    signal: AbortSignal.timeout(60000)
    });
  } catch (e) {
    e.categorie = 'ai';
    e.message = 'Claude API: ' + e.message;
    throw e;
  }

  const data = await resp.json();
  let txt = (data.content && data.content[0] && data.content[0].text) || '';
  txt = txt.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const s = txt.indexOf('['), e = txt.lastIndexOf(']');
  if (s === -1 || e === -1) throw new Error('geen JSON array in response');
  const arr = JSON.parse(txt.substring(s, e + 1).replace(/,\s*]/g, ']').replace(/,\s*}/g, '}'));

  const result = {};
  arr.forEach(function (item) {
    var i = item.index;
    if (typeof i !== 'number' || !kandidaten[i]) return;

    var heeftClaim = (item.plaats && item.plaats !== 'niet vermeld') ||
                     (item.tijd && item.tijd !== 'niet vermeld');
    if (heeftClaim) {
      // Anker-check: citaat moet letterlijk in de posttekst van dít event staan.
      var anker = normaliseerVoorAnker(item.bron_tekst || '');
      var bron = normaliseerVoorAnker(kandidaten[i].content);
      if (anker.length < 3 || bron.indexOf(anker) === -1) {
        console.log(`    \u2717 Verrijking afgekeurd voor "${kandidaten[i].titel}": citaat niet in posttekst`);
        result[i] = { type: item.type };
        return;
      }
    }
    result[i] = { plaats: item.plaats, tijd: item.tijd, type: item.type };
  });
  return result;
}

// ════════════════════════════════════════════════════════════════
// WEB-SCRAPING VIA CLAUDE
// ════════════════════════════════════════════════════════════════

async function fetchWebEvents(bronId, bronNaam, urls) {
  let alleHtml = '';
  let laatstePaginaFout = null;

  for (const url of urls) {
    try {
      const response = await fetchMetRetry(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; VerenigingenKalender/1.0)',
          'Accept': 'text/html'
        },
        signal: AbortSignal.timeout(15000)
      });

      const html = await response.text();

      if (html.length < 500) {
        var kErr = new Error('Pagina bevat vrijwel geen content');
        kErr.categorie = 'formaat';
        throw kErr;
      }

      const stripped = stripHtml(html);
      alleHtml += `\n\n--- PAGINA: ${url} ---\n${stripped}`;

    } catch (err) {
      laatstePaginaFout = err;
      console.log(`    Subpagina ${url}: ${err.message}`);
    }
  }

  if (alleHtml.trim().length < 100) {
    var gErr = new Error(`Geen bruikbare HTML opgehaald van ${urls.length} pagina('s)` +
      (laatstePaginaFout ? ` \u2014 laatste fout: ${laatstePaginaFout.message}` : ''));
    gErr.categorie = laatstePaginaFout && laatstePaginaFout.categorie ? laatstePaginaFout.categorie : 'netwerk';
    throw gErr;
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
- KRITIEK — VERZIN NOOIT DATUMS: Als een event een volledige datum heeft (met jaar) die in het verleden ligt, dan is dat event VOORBIJ. Sla het over. Verschuif de datum NOOIT naar een latere maand of een later jaar om er een toekomstig event van te maken. Een pagina die alleen voorbije events bevat levert een lege array [] op. Een lege array is een correct en gewenst antwoord.
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
    "type": "sociaal|sportief|cultureel|informatief|bestuurlijk|zakelijk|kerkdienst",
    "bron_tekst": "LETTERLIJK citaat uit de HTML hierboven (max 150 tekens) waarin de datum van dit event staat. Kopieer exact, karakter voor karakter, inclusief de datumnotatie zoals die op de pagina staat. Niet parafraseren, niet vertalen, niet herformatteren."
  }
- Events zonder aanwijsbaar letterlijk datumcitaat: NIET opnemen.
- Geen events? Geef: []
- ALLEEN de JSON array, niets anders.

HTML CONTENT:
${alleHtml}`;

  let claudeResponse;
  try {
    claudeResponse = await fetchMetRetry(ANTHROPIC_URL, {
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
  } catch (e) {
    e.categorie = 'ai';
    e.message = 'Claude API: ' + e.message;
    throw e;
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

    // Post-validatie: bronanker — de datum moet verifieerbaar in de bron staan.
    // Dit blokkeert gehallucineerde/verschoven datums (bijv. 25 april → 25 augustus).
    var ankerCheck = verifieerEventTegenBron(ev, alleHtml, now);
    if (!ankerCheck.ok) {
      console.log(`    \u2717 Afgekeurd (bronanker): "${titel.substring(0, 50)}" (${ev.datum}) \u2014 ${ankerCheck.reden}`);
      gefilterd++;
      return;
    }

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

// ════════════════════════════════════════════════════════════════
// BRONANKER-VERIFICATIE
// Vertrouw het model niet: elke geëxtraheerde datum moet
// deterministisch herleidbaar zijn tot letterlijke brontekst.
// ════════════════════════════════════════════════════════════════

function normaliseerVoorAnker(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, '-')   // alle streepjes → '-'
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

var MAAND_NAMEN = {
  // Nederlands
  'januari': 1, 'februari': 2, 'maart': 3, 'april': 4, 'mei': 5, 'juni': 6,
  'juli': 7, 'augustus': 8, 'september': 9, 'oktober': 10, 'november': 11, 'december': 12,
  'jan': 1, 'feb': 2, 'mrt': 3, 'apr': 4, 'jun': 6, 'jul': 7, 'aug': 8,
  'sep': 9, 'sept': 9, 'okt': 10, 'nov': 11, 'dec': 12,
  // Frans
  'janvier': 1, 'f\u00e9vrier': 2, 'fevrier': 2, 'mars': 3, 'avril': 4, 'mai': 5,
  'juin': 6, 'juillet': 7, 'ao\u00fbt': 8, 'aout': 8, 'septembre': 9,
  'octobre': 10, 'novembre': 11, 'd\u00e9cembre': 12, 'decembre': 12
};

/**
 * Haal alle herkenbare datums uit een stukje tekst.
 * Retourneert [{dag, maand, jaar|null}, ...]
 * Ondersteunt: 2026-04-25 | 25-04-2026 | 25/4 | 25/04/2026 | 25 april (2026)
 */
function parseDatumsUitTekst(tekst) {
  var t = normaliseerVoorAnker(tekst);
  var gevonden = [];
  var m;

  // ISO: YYYY-MM-DD
  var reIso = /(\d{4})-(\d{1,2})-(\d{1,2})/g;
  while ((m = reIso.exec(t)) !== null) {
    gevonden.push({ jaar: +m[1], maand: +m[2], dag: +m[3] });
  }

  // Numeriek Europees: DD-MM-YYYY, DD/MM/YYYY, DD/MM, DD-MM
  var reEu = /(?:^|[^\d-])(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?(?![\d\-])/g;
  while ((m = reEu.exec(t)) !== null) {
    var dag = +m[1], maand = +m[2];
    var jaar = m[3] ? +m[3] : null;
    if (jaar !== null && jaar < 100) jaar += 2000;
    // Sla ISO-matches over die hier nogmaals matchen (jaar op dag-positie)
    if (dag >= 1 && dag <= 31 && maand >= 1 && maand <= 12) {
      gevonden.push({ jaar: jaar, maand: maand, dag: dag });
    }
  }

  // Tekstueel: "25 april", "25 april 2026", "1er avril"
  var maandAlt = Object.keys(MAAND_NAMEN).join('|');
  var reTxt = new RegExp('(\\d{1,2})(?:er|e)?\\s+(' + maandAlt + ')\\.?(?:\\s+(\\d{4}))?', 'g');
  while ((m = reTxt.exec(t)) !== null) {
    gevonden.push({
      jaar: m[3] ? +m[3] : null,
      maand: MAAND_NAMEN[m[2]],
      dag: +m[1]
    });
  }

  return gevonden;
}

/**
 * Controleer een door het model geëxtraheerd event tegen de brontekst.
 * Eisen:
 *  1. bron_tekst is aanwezig en komt letterlijk voor in de bron-HTML.
 *  2. Uit bron_tekst is minstens één datum te parsen die qua dag+maand
 *     overeenkomt met ev.datum (jaar alleen gecheckt als de bron het noemt).
 *  3. Een brondatum mét jaar die in het verleden ligt → afkeuren
 *     (het model mag voorbije events niet naar de toekomst schuiven).
 */
function verifieerEventTegenBron(ev, bronHtml, vandaag) {
  if (!ev.bron_tekst || String(ev.bron_tekst).trim().length < 3) {
    return { ok: false, reden: 'geen bron_tekst meegeleverd' };
  }

  var anker = normaliseerVoorAnker(ev.bron_tekst);
  var bron = normaliseerVoorAnker(bronHtml);

  if (bron.indexOf(anker) === -1) {
    return { ok: false, reden: 'bron_tekst niet letterlijk in bron gevonden' };
  }

  var evDatum = new Date(ev.datum);
  var evDag = evDatum.getDate();
  var evMaand = evDatum.getMonth() + 1;
  var evJaar = evDatum.getFullYear();

  var datums = parseDatumsUitTekst(anker);
  if (datums.length === 0) {
    return { ok: false, reden: 'geen parseerbare datum in bron_tekst' };
  }

  for (var i = 0; i < datums.length; i++) {
    var d = datums[i];
    if (d.dag !== evDag || d.maand !== evMaand) continue;
    if (d.jaar !== null && d.jaar !== evJaar) continue;
    // Dag+maand (en evt. jaar) matchen. Laatste check: als de bron een
    // volledig jaar noemt en die datum ligt in het verleden → afkeuren.
    if (d.jaar !== null) {
      var bronDatum = new Date(d.jaar, d.maand - 1, d.dag);
      if (bronDatum < vandaag) {
        return { ok: false, reden: 'brondatum ligt in het verleden' };
      }
    }
    return { ok: true, reden: null };
  }

  return { ok: false, reden: 'event-datum (' + ev.datum + ') komt niet overeen met datum(s) in bron_tekst' };
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
 *   - generated_at                  -> heartbeat; als dit > ~4 dagen oud is (schema: ma/wo/vr),
 *                                      draait de workflow zelf niet meer
 */
function writeHealth(data, warnings, vandaag, volgendeWeek, totaalEvents, observaties, vorigeHealth, nieuwsSamenvatting) {
  observaties = observaties || [];
  vorigeHealth = vorigeHealth || {};

  var downMap = {};
  var alleWebDown = null;
  warnings.forEach(function (w) {
    if (w.bron_id === 'alle-web-bronnen') { alleWebDown = w; return; }
    downMap[w.bron_id] = w;
  });
  var verdachtMap = {};
  observaties.forEach(function (o) { verdachtMap[o.bron_id] = o; });

  function eventsVoor(id) {
    var ver = data.verenigingen.find(function (v) { return v.id === id; });
    return (ver && ver.events) ? ver.events.length : 0;
  }

  /**
   * Bouwt één bron-regel. Semantiek:
   *  - status 'down'     : bron faalde; 'diagnose' vertelt de OORZAAK-categorie
   *                        (verplaatst/geblokkeerd/netwerk/... — dus site-wijziging
   *                        wordt als zodanig benoemd, niet als scriptbug).
   *  - status 'verdacht' : bron werkt maar leverde plots 0 events (observatie).
   *  - stale: true       : getoonde events zijn behouden uit een eerdere run.
   *  - laatste_succes    : laatste dag waarop deze bron succesvol is gelezen.
   */
  function bronRegel(id, naam, type, url) {
    var w = downMap[id] || (type === 'web-scraping' ? alleWebDown : null);
    var o = verdachtMap[id];
    var vorig = vorigeHealth[id] || {};
    var status = w ? 'down' : (o ? 'verdacht' : 'ok');
    return {
      id: id,
      naam: naam,
      type: type,
      status: status,
      events: eventsVoor(id),
      stale: !!w && eventsVoor(id) > 0,
      laatste_succes: w ? (vorig.laatste_succes || null) : vandaag,
      url: url,
      fout: w ? w.fout : null,
      diagnose: w ? (w.diagnose || classificeerFout(new Error(w.fout || 'onbekende fout')))
                  : (o ? { categorie: 'inhoud', oorzaak: o.melding,
        advies: 'Bekijk de bron handmatig; bij seizoensstop is geen actie nodig.' } : null)
    };
  }

  var bronnen = [];

  Object.keys(ICAL_BRONNEN).forEach(function (id) {
    bronnen.push(bronRegel(id, id.toUpperCase(), 'ical', ICAL_BRONNEN[id]));
  });

  Object.keys(WORDPRESS_BRONNEN).forEach(function (id) {
    bronnen.push(bronRegel(id, WORDPRESS_BRONNEN[id].naam, 'wordpress-api', WORDPRESS_BRONNEN[id].site));
  });

  Object.keys(WEB_BRONNEN).forEach(function (id) {
    var config = WEB_BRONNEN[id];
    var urls = config.urlGenerator ? config.urlGenerator() : config.urls;
    bronnen.push(bronRegel(id, config.naam, 'web-scraping', (urls || []).join(', ')));
  });

  var kapot = bronnen.filter(function (b) { return b.status === 'down'; });
  var verdacht = bronnen.filter(function (b) { return b.status === 'verdacht'; });

  var health = {
    generated_at: new Date().toISOString(),
    ok: kapot.length === 0,
    status: kapot.length > 0 ? 'degraded' : (verdacht.length > 0 ? 'attention' : 'ok'),
    laatst_bijgewerkt: vandaag,
    volgende_update: volgendeWeek,
    totaal_events: totaalEvents,
    bronnen_totaal: bronnen.length,
    bronnen_ok: bronnen.length - kapot.length - verdacht.length,
    bronnen_down: kapot.length,
    bronnen_verdacht: verdacht.length,
    kapotte_koppelingen: kapot.map(function (b) {
      return { id: b.id, naam: b.naam, type: b.type, url: b.url, fout: b.fout,
               diagnose: b.diagnose, laatste_succes: b.laatste_succes };
    }),
    observaties: verdacht.map(function (b) {
      return { id: b.id, naam: b.naam, type: b.type, url: b.url, diagnose: b.diagnose };
    }),
    nieuws: nieuwsSamenvatting || null,
    bronnen: bronnen
  };

  fs.writeFileSync(HEALTH_PATH, JSON.stringify(health, null, 2), 'utf-8');
  console.log('\nhealth.json: ' + health.status + ' (' + health.bronnen_down +
              ' kapot, ' + health.bronnen_verdacht + ' verdacht, van ' + health.bronnen_totaal + ' bronnen)');
}

main().catch(function (err) {
  console.error('FATALE FOUT:', err);
  process.exit(2);
});
