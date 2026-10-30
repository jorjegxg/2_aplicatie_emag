# Vocea lui Claude pe PC (Windows)

Hook-ul Stop de pe orice server (`~/.claude/hooks/vorbeste.js`) trimite textul la containerul `voce` de pe PC
(`POST /vorbeste`, cu `X-Token`). `difuzor.ps1` ia WAV-ul de pe `127.0.0.1:8100/urmator` și îl redă pe boxe.

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
