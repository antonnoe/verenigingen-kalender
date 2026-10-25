---
name: verenigingen-kalender
description: Werkwijze voor de Verenigingen Kalender (repo antonnoe/verenigingen-kalender). Gebruik bij elke nieuwe of kapotte evenementenbron, bij health.json-meldingen, bij scripts/update-events.js, en bij de vraag of een vereniging "geen events publiceert".
---

# Verenigingen Kalender

Statische tool (GitHub Pages) met data in `data/verenigingen.json`. `scripts/update-events.js` draait via `.github/workflows/update-kalender.yml` op ma, wo en vr 07:00 UTC en schrijft `verenigingen.json`, `health.json` en `nieuws.json`. Lessen uit eerdere incidenten staan in `lessen-uit-incidenten.md`: lees die eerst en vul ze aan na elk incident.

## Bronnentypes (kies de goedkoopste die werkt)
1. iCal (`ICAL_BRONNEN`): direct parsen.
2. WordPress REST of RSS (`WORDPRESS_BRONNEN`): datum deterministisch uit de posttitel.
3. Deterministische parser (Cercle Néerlandais, `fetchCercleEvents`): geen AI, geen API-sleutel, jaar afgeleid uit weekdag. Voorkeur voor sites met vaste opmaak.
4. Web-extractie via Claude (`WEB_BRONNEN`, `fetchWebEvents`): alleen als 1 tot 3 niet kunnen. Bronanker-verificatie blijft aan: elke datum moet herleidbaar zijn tot letterlijke brontekst.
5. Vast ritme (`vast_ritme` in het bronrecord) voor clubs met een bekend schema.

## Harde regels
- Datum verplicht, tijd niet. Tijd ontbreekt: plaatsen met "niet vermeld".
- Jaar ontbreekt: afleiden uit de weekdag (eerstvolgende jaar binnen 12 maanden waarin dag+maand op die weekdag valt) of de eerstvolgende toekomstige datum. Lukt dat niet: evenement overslaan en loggen, nooit gokken.
- Verlopen evenementen (datum voor vandaag) niet overnemen.
- Eventlink (`bron`) is de pagina of het bericht van het evenement zelf.
- Nooit overnemen: IBAN, RIB, BIC, telefoonnummers, e-mailadressen, namen van particulieren. Thuisadres wordt alleen de plaats. Plek onbekend: "plaats nog te bevestigen".
- Een bron met 0 events terwijl de site pagina's linkt is een waarschuwing in `health.json`, nooit "ok" (zie `registreerBronFout`, categorie `inhoud`).
- Verkeer minimaal: user-agent `Mozilla/5.0 (compatible; VerenigingenKalender/1.0)`, 2 seconden pauze tussen verzoeken, geen retries bovenop `fetchMetRetry`.
- Blokkade (403, 503, challenge, ECONNREFUSED): niet omheen werken, geen proxy, geen andere route. Rapporteren en de route via de beheerder van de vereniging kiezen (vrijgave op user-agent vragen). Live test dan als openstaand melden.

## Nieuwe bron toevoegen
1. Bereikbaarheid vanaf GitHub Actions testen met een tijdelijke `workflow_dispatch`-workflow (curl met de user-agent, per URL status, server, cf-ray, cf-mitigated, challenge-marker). Twee runs, andere runner. Slagen = 200, geen challenge. Faalt het: stoppen en rapporteren. Testworkflow daarna verwijderen.
2. Pagina's lokaal ophalen en de structuur bekijken (og:description, paginatekst, links). Eerst een deterministische parser overwegen.
3. Bron in het script zetten, buiten de `ANTHROPIC_API_KEY`-poort als er geen AI nodig is. Health-type en `bronRegel` bijwerken.
4. Bronrecord in `verenigingen.json` bijwerken (`agenda_url`, `agenda_toegankelijkheid`, `opmerking`).
5. Parser testen op de echte pagina's, daarna de workflow `update-kalender.yml` laten draaien en live controleren (raw `main` en de Pages-URL): aantal events, datum, tijd, plaats, link. Eventuele verlopen of overgeslagen evenementen moeten in het log staan.
6. Les toevoegen aan `lessen-uit-incidenten.md`.

## "Geen events" heroverwegen
De Cercle Néerlandais stond als `geen_online_agenda` ("alleen generieke beschrijvingen") terwijl de startpagina losse activiteitenpagina's linkt met datum, tijd en plaats. LOTgenoten stond op een lege `/agenda/` terwijl de activiteiten op de startpagina stonden. Een label `geen_online_agenda`, `beperkt`, `geen_eventkalender` of `facebook_only` betekent dus alleen dat er geen agendapagina is gevonden, niet dat er geen evenementen zijn.

Controle per vereniging, in deze volgorde, en stop zodra iets werkt:
1. Startpagina: tegels, banners, blok "aankomend", links naar losse pagina's (`aanmelden-*`, `info-*`, `activiteit*`, `evenement*`).
2. `og:description` en `og:title` van die pagina's (Weebly, Wix en WordPress zetten daar vaak datum en plek in), de sitemap (`/sitemap.xml`) en de RSS-feed (`/feed/`).
3. Nieuwsberichten met een datum in de titel (patroon "28 juni – ...").
4. Nieuwsbrief-archief of PDF-agenda.
5. Alleen Facebook of niets: label klopt, niet scrapen, wel noteren.

Uitkomst audit 25-10-2026 (details in het veld `opmerking` per bronrecord):
- Bouwen (er zijn gestructureerde gegevens): latulipe (publieke JSON-feed `leden.latulipe.net/api/agenda.json.php`, maand via parameter, vervangt de 404-URL's), dbcra (lijst "Planning DBCRA 2026" op dbcra.nl/nederlandse-club-lyon, jaar in de kop, geen tijd of plaats).
- Eerst onderzoeken: bourgondische-zaken (agendabourgogne.nl laadt client-side, onderliggende API zoeken).
- Label klopt, geen events: aneas, cmunf, nederlands-ondersteuningsfonds, nvso, praatje, clcv (iCal leeg), fanf (alleen doorlopende lessen).
- Niet beoordeeld: france-advies (HTTP 502), facebook-bronnen (nvm-montpellier, crefnec-combrailles) en bronnen zonder website (nzgf, pays-de-gex, perpignan, club-normandie).

Een grote uitleesklus over alle bronnen eerst in één regel melden aan Anton, en per bron na afloop de status in het bronrecord corrigeren.

## Modelkeuze
Sonnet voor bronnen toevoegen en repareren. Opus of Fable alleen voor een audit over alle bronnen of als de bronanker-verificatie zelf wijzigt.
