# Vocea lui Claude pe PC (Windows)

Hook-ul Stop de pe orice server (`~/.claude/hooks/vorbeste.js`) trimite textul la containerul `voce` de pe PC
(`POST /vorbeste`, cu `X-Token` și `sursa` = sesiunea Claude: id, titlu, server · proiect). `difuzor.ps1` ia WAV-ul
de pe `127.0.0.1:8100/urmator` și îl redă pe boxe.

## Widgetul „Voce Claude”
Tot `difuzor.ps1` arată, în dreapta-sus, câte un card pentru fiecare terminal sau bot care a vorbit în ultimele 12 ore
(unul nou apare dedesubt). **Stop** îl oprește (și mesajul de acum): serverul nu-i mai sintetizează nimic până apeși
**Pornește**. **×** ascunde cardul până vorbește din nou. Antetul se poate trage cu mouse-ul; „—” sau dublu-clic pe
iconița din tray îl ascunde/arată. Starea stă în container (`/models/surse.json`, `GET /surse`, `POST /surse/{id}`).
Oricine trimite la `/vorbeste` un câmp `sursa: {id, nume, detalii}` primește card propriu; fără el, „Altele”.

## Pe PC (o dată)
1. În `voce/`, fișierul `.env` cu `VORBESTE_TOKEN=...` și `docker compose -f docker-compose.pc.yml up -d --build`
2. Ca Administrator: `powershell -ExecutionPolicy Bypass -File pc\instaleaza.ps1`
   (task-ul „Claude voce” la logare + firewall 8100 doar pentru 192.168.1.0/24 și Tailscale)
3. Docker Desktop: „Start Docker Desktop when you sign in” activat.

## Pe un server nou
1. Copiază `vorbeste.js` și `vorbeste.env` în `~/.claude/hooks/`.
   `vorbeste.env`: `VOCE_URL=http://192.168.1.13:8100` acasă, `http://100.73.240.81:8100` prin Tailscale.
2. În `~/.claude/settings.json`:
   ```json
   "hooks": { "Stop": [ { "hooks": [ { "type": "command",
     "command": "node ~/.claude/hooks/vorbeste.js 2>/dev/null || true", "timeout": 120, "async": true } ] } ] }
   ```
3. Server fără Tailscale: `ssh -R 8100:192.168.1.13:8100 server` și `VOCE_URL=http://127.0.0.1:8100`.

Oprire: `touch ~/.claude/hooks/vorbeste.off` pe server.
