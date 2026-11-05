# CLAUDE.md

Repo: verenigingen-kalender

## Wat dit is

Statische evenementenkalender en contacttegels van Nederlandse verenigingen in Frankrijk. Een script haalt op ma, wo en vr de evenementen en het nieuws van de verenigingen op en schrijft ze naar JSON-bestanden in `data/`.

## Live adres

https://antonnoe.github.io/verenigingen-kalender/ (staat in `scripts/update-events.js`, constante `TOOL_URL`). GitHub Pages, geen CNAME.

## Opbouw

- `index.html`: de kalender, leest `data/verenigingen.json`, `data/locaties.json` en `data/nieuws.json`
- `tegels.html`: contacttegels
- `data/`: verenigingen.json (bronrecords en evenementen), health.json (gezondheid per bron), nieuws.json, locaties.json
- `scripts/update-events.js` en `scripts/package.json`: de updater (Node)
- `.github/workflows/update-kalender.yml`: geplande run
- `.github/scripts/oudere-meldingen.jq`: selectie voor het sluiten van oudere meldingen
- `.github/dependabot.yml`: wekelijkse npm-updates voor `/scripts`
- `vendor/leaflet/`: Leaflet, lokaal meegeleverd
- `.claude/skills/verenigingen-kalender/SKILL.md`: werkwijze voor bronnen
- `lessen-uit-incidenten.md`: lessen uit eerdere incidenten
- `robots.txt` (Disallow alles) en `.nojekyll`

## Techniek

Plain HTML en JavaScript zonder bouwstap. De updater draait op Node 22 en gebruikt het pakket `node-ical`. Bronnentypes: iCal, WordPress REST of RSS, deterministische parsers (onder meer Cercle Néerlandais, latulipe, dbcra) en web-extractie via een Claude-model met bronanker-verificatie.

## Externe diensten en namen van omgevingsvariabelen

- `ANTHROPIC_API_KEY` (GitHub Actions secret, alleen voor web-extractie)
- `GH_TOKEN` (uit `secrets.GITHUB_TOKEN`, voor het aanmaken en sluiten van meldingen in de workflow)
- Anthropic API, GitHub Actions en GitHub Pages, plus de sites van de verenigingen zelf als bron

## Hoe het live gaat

GitHub Pages serveert de repo. De workflow `Verenigingen Kalender Update` draait ma, wo en vr om 07:00 UTC en handmatig, voert `node update-events.js` uit in `scripts/`, commit `data/verenigingen.json`, `data/health.json` en `data/nieuws.json` naar main en maakt een melding aan bij waarschuwingen (exitcode 1) of een fatale fout (exitcode 2). Oudere meldingen worden daarna gesloten.

## Regels en besluiten

Bron: `.claude/skills/verenigingen-kalender/SKILL.md` en `lessen-uit-incidenten.md`. Lees die eerst bij elke nieuwe of kapotte bron.

- Datum verplicht, tijd niet. Jaar ontbreekt: afleiden uit de weekdag of de eerstvolgende toekomstige datum, lukt dat niet dan overslaan en loggen, nooit gokken.
- Verlopen evenementen niet overnemen. De eventlink is de pagina of het bericht van het evenement zelf.
- Nooit overnemen: IBAN, RIB, BIC, telefoonnummers, e-mailadressen, namen van particulieren. Thuisadres wordt alleen de plaats.
- Een bron met 0 evenementen terwijl de site pagina's linkt is een waarschuwing in `health.json`, nooit "ok".
- Verkeer minimaal, met de vaste user-agent en pauzes tussen verzoeken. Bij een blokkade niet omheen werken (geen proxy, geen andere route), rapporteren en de live test als openstaand melden.
- Kies het goedkoopste bronnentype dat werkt. Web-extractie via een model alleen als iCal, WordPress/RSS en een deterministische parser niet kunnen, en dan blijft bronanker-verificatie aan.
- Een label als `geen_online_agenda` betekent alleen dat er geen agendapagina is gevonden, niet dat er geen evenementen zijn.
- Na elk incident wordt `lessen-uit-incidenten.md` aangevuld.

Laatst nagelopen: 5 november 2026
