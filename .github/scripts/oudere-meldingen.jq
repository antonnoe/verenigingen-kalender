# Invoer: lijst open issues (gh issue list --json number,title,author,comments,createdAt)
# Argument $vandaag: datum van deze run (YYYY-MM-DD).
# Uitvoer: nummers van oudere, reactieloze bot-meldingen die gesloten mogen worden, plus het nieuwste nummer.
def is_melding: (.title | startswith("⚠️ Kalender bronnen omgevallen") or startswith("🔴 Kalender update FATAAL"))
                and (.author.login | test("^(app/)?github-actions(\\[bot\\])?$"));
[ .[] | select(is_melding) ] as $m
| ($m | map(select(.createdAt | startswith($vandaag))) | map(.number) | max) as $nieuw
| if $nieuw == null then {nieuw: null, sluiten: []}
  else {nieuw: $nieuw, sluiten: [ $m[] | select(.number < $nieuw and ((.comments | length) == 0)) | .number ]} end
