"""
Serviciul `voce`: text-to-speech în română și transcriere (speech-to-text), totul local, pe CPU.

  GET  /health          ce e încărcat
  GET  /voci            vocile disponibile
  POST /tts             {text, voce, viteza} -> audio/mpeg
  POST /stt             fișier audio (webm/ogg/m4a/wav) -> {text, limba, durata}
  POST /vorbeste        {text, voce, viteza} + X-Token -> 202; sintetizează pentru difuzorul de pe PC
  GET  /urmator?dupa=N  long-poll pentru difuzor: ultimul WAV mai nou decât N (X-Id), altfel 204

Motoare:
  piper       vocile Liana / Sanda (eduardem, CC BY-NC) și Mihai (rhasspy) — rapide, locale
  supertonic  Supertonic 3, are română, 10 voci (F1–F5, M1–M5) — local
  edge        vocile Microsoft Alina / Emil prin serviciul gratuit Edge — neoficial, cere internet
STT: faster-whisper (VOCE_STT_MODEL, implicit large-v3-turbo, int8).
"""
import asyncio
import io
import os
import subprocess
import tempfile
import threading
import time
import wave

from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.responses import Response
from huggingface_hub import hf_hub_download
from pydantic import BaseModel

MODELS = os.environ.get("VOCE_MODELS_DIR", "/models")
STT_MODEL = os.environ.get("VOCE_STT_MODEL", "large-v3-turbo")
STT_THREADS = int(os.environ.get("VOCE_STT_THREADS", "6"))
STT_ON = os.environ.get("VOCE_STT", "1") != "0"
VORBESTE_TOKEN = os.environ.get("VORBESTE_TOKEN", "")
MAX_TEXT = 6000

# id -> (repo, fișier onnx)
PIPER_VOICES = {
    "liana-high": ("eduardem/piper-liana-romanian", "voices/liana-high/ro_RO-liana-high.onnx"),
    "liana-medium": ("eduardem/piper-liana-romanian", "voices/liana-medium/ro_RO-liana-medium.onnx"),
    "sanda-high": ("eduardem/piper-tts-romanian", "voices/sanda-high/ro_RO-sanda-high.onnx"),
    "mihai": ("rhasspy/piper-voices", "ro/ro_RO/mihai/medium/ro_RO-mihai-medium.onnx"),
}
VOICES = [
    {"id": "piper:liana-high", "motor": "piper", "nume": "Liana (calitate mare)", "gen": "f", "nota": "locală, foarte clară"},
    {"id": "piper:liana-medium", "motor": "piper", "nume": "Liana (rapidă)", "gen": "f", "nota": "locală, cea mai rapidă"},
    {"id": "piper:sanda-high", "motor": "piper", "nume": "Sanda", "gen": "f", "nota": "locală"},
    {"id": "piper:mihai", "motor": "piper", "nume": "Mihai", "gen": "m", "nota": "locală, mai robotică"},
    *[
        {"id": f"supertonic:{v}", "motor": "supertonic", "nume": f"Supertonic {v}", "gen": v[0].lower(), "nota": "locală"}
        for v in ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"]
    ],
    {"id": "edge:ro-RO-AlinaNeural", "motor": "edge", "nume": "Alina (Microsoft)", "gen": "f", "nota": "gratuit, neoficial, cere internet"},
    {"id": "edge:ro-RO-EmilNeural", "motor": "edge", "nume": "Emil (Microsoft)", "gen": "m", "nota": "gratuit, neoficial, cere internet"},
]
VOICE_IDS = {v["id"] for v in VOICES}
DEFAULT_VOICE = "piper:liana-high"

app = FastAPI(title="voce")
_piper = {}
_piper_lock = threading.Lock()
_supertonic = None
_supertonic_lock = threading.Lock()
_whisper = None
_whisper_lock = threading.Lock()
_ro_text = None
# Difuzorul: păstrează doar ultimul mesaj; unul nou îl înlocuiește pe cel vechi.
_ultim = {"id": 0, "wav": None}
_ultim_cond = threading.Condition()


def log(msg):
    print(f"{time.strftime('%Y-%m-%d %H:%M')} {msg}", flush=True)


# ---------- text ----------

def ro_text():
    """Front-end-ul de text al vocilor Liana (ro_text.py, doar bibliotecă standard)."""
    global _ro_text
    if _ro_text is None:
        try:
            import importlib.util

            path = hf_hub_download("eduardem/piper-liana-romanian", "ro_text.py")
            spec = importlib.util.spec_from_file_location("ro_text", path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            _ro_text = mod
        except Exception as e:  # fără el citim textul așa cum e
            log(f"ro_text.py indisponibil: {e}")
            _ro_text = False
    return _ro_text or None


def prepare_text(text, respell):
    mod = ro_text()
    if not mod:
        return text
    text = mod.normalize_text(text)
    text = mod.expand_abbreviations(text)
    # piper-tts are dicționarul espeak standard, nu pe cel patch-uit: respell ajută la eMAG, Trendyol...
    return mod.respell(text) if respell else text


# ---------- motoare ----------

def piper_voice(name):
    with _piper_lock:
        if name not in _piper:
            from piper import PiperVoice

            repo, filename = PIPER_VOICES[name]
            onnx = hf_hub_download(repo, filename)
            hf_hub_download(repo, filename + ".json")
            _piper[name] = PiperVoice.load(onnx)
            log(f"piper {name} încărcat")
        return _piper[name]


def synth_piper(name, text, speed):
    from piper import SynthesisConfig

    voice = piper_voice(name)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        voice.synthesize_wav(
            prepare_text(text, respell=True),
            wf,
            syn_config=SynthesisConfig(length_scale=1.0 / max(0.5, min(2.0, speed))),
        )
    return buf.getvalue(), "wav"


def synth_supertonic(style_name, text, speed):
    global _supertonic
    with _supertonic_lock:
        if _supertonic is None:
            from supertonic import TTS

            _supertonic = TTS(auto_download=True)
            log("supertonic încărcat")
        tts = _supertonic
        style = tts.get_voice_style(voice_name=style_name)
        wav, _ = tts.synthesize(
            text=prepare_text(text, respell=False),
            voice_style=style,
            total_steps=10,
            speed=max(0.7, min(2.0, speed)),
            lang="ro",
        )
        with tempfile.NamedTemporaryFile(suffix=".wav") as f:
            tts.save_audio(wav, f.name)
            return open(f.name, "rb").read(), "wav"


def synth_edge(voice, text, speed):
    import edge_tts

    pct = round((max(0.5, min(2.0, speed)) - 1) * 100)
    rate = f"{'+' if pct >= 0 else ''}{pct}%"

    async def run(path):
        await edge_tts.Communicate(text, voice, rate=rate).save(path)

    with tempfile.NamedTemporaryFile(suffix=".mp3") as f:
        asyncio.run(run(f.name))
        return open(f.name, "rb").read(), "mp3"


def to_mp3(data, fmt):
    if fmt == "mp3":
        return data
    out = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", fmt, "-i", "pipe:0",
         "-ac", "1", "-codec:a", "libmp3lame", "-q:a", "4", "-f", "mp3", "pipe:1"],
        input=data,
        capture_output=True,
        check=True,
    )
    return out.stdout


def to_wav(data, fmt):
    if fmt == "wav":
        return data
    out = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", fmt, "-i", "pipe:0", "-f", "wav", "pipe:1"],
        input=data,
        capture_output=True,
        check=True,
    )
    return out.stdout


def whisper():
    global _whisper
    with _whisper_lock:
        if _whisper is None:
            from faster_whisper import WhisperModel

            _whisper = WhisperModel(STT_MODEL, device="cpu", compute_type="int8", cpu_threads=STT_THREADS)
            log(f"whisper {STT_MODEL} încărcat")
        return _whisper


# ---------- API ----------

class TtsIn(BaseModel):
    text: str
    voce: str = DEFAULT_VOICE
    viteza: float = 1.0


@app.get("/health")
def health():
    return {
        "ok": True,
        "piper": sorted(_piper),
        "supertonic": _supertonic is not None,
        "whisper": STT_MODEL if _whisper is not None else None,
        "voce_implicita": DEFAULT_VOICE,
    }


@app.get("/voci")
def voci():
    return {"voci": VOICES, "implicita": DEFAULT_VOICE}


def sintetizeaza(text, voce, viteza):
    """-> (audio, format, voce folosită)"""
    voce = voce if voce in VOICE_IDS else DEFAULT_VOICE
    motor, name = voce.split(":", 1)
    if motor == "piper":
        data, fmt = synth_piper(name, text, viteza)
    elif motor == "supertonic":
        data, fmt = synth_supertonic(name, text, viteza)
    else:
        data, fmt = synth_edge(name, text, viteza)
    return data, fmt, voce


@app.post("/tts")
def tts(body: TtsIn):
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(400, "text gol")
    if len(text) > MAX_TEXT:
        text = text[:MAX_TEXT]
    t0 = time.time()
    try:
        data, fmt, voce = sintetizeaza(text, body.voce, body.viteza)
        mp3 = to_mp3(data, fmt)
    except Exception as e:
        log(f"tts {body.voce}: {e}")
        raise HTTPException(502, f"{body.voce}: {e}")
    log(f"tts {voce}: {len(text)} caractere în {time.time() - t0:.1f}s")
    return Response(mp3, media_type="audio/mpeg", headers={"X-Voce": voce})


def _pregateste(nr, text, voce, viteza):
    t0 = time.time()
    try:
        data, fmt, voce = sintetizeaza(text, voce, viteza)
        wav = to_wav(data, fmt)
    except Exception as e:
        log(f"vorbeste {voce}: {e}")
        return
    with _ultim_cond:
        if nr != _ultim["id"]:
            return  # între timp a venit alt mesaj
        _ultim["wav"] = wav
        _ultim_cond.notify_all()
    log(f"vorbeste #{nr}: {len(text)} caractere în {time.time() - t0:.1f}s")


@app.post("/vorbeste", status_code=202)
def vorbeste(body: TtsIn, x_token: str = Header("")):
    if VORBESTE_TOKEN and x_token != VORBESTE_TOKEN:
        raise HTTPException(401, "token greșit")
    text = (body.text or "").strip()[:MAX_TEXT]
    if not text:
        raise HTTPException(400, "text gol")
    with _ultim_cond:
        _ultim["id"] += 1
        _ultim["wav"] = None
        nr = _ultim["id"]
    threading.Thread(target=_pregateste, args=(nr, text, body.voce, body.viteza), daemon=True).start()
    return {"id": nr}


@app.get("/urmator")
def urmator(dupa: int = 0, timeout: float = 25):
    """Difuzorul întreabă de pe PC; răspunde când există un WAV mai nou decât `dupa`."""
    with _ultim_cond:
        if dupa > _ultim["id"]:
            dupa = 0  # serviciul a repornit
        _ultim_cond.wait_for(lambda: _ultim["id"] > dupa and _ultim["wav"] is not None, timeout=min(timeout, 60))
        if _ultim["id"] > dupa and _ultim["wav"] is not None:
            return Response(_ultim["wav"], media_type="audio/wav", headers={"X-Id": str(_ultim["id"])})
    return Response(status_code=204)


@app.post("/stt")
def stt(file: UploadFile = File(...)):
    t0 = time.time()
    suffix = os.path.splitext(file.filename or "")[1] or ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix) as f:
        f.write(file.file.read())
        f.flush()
        try:
            segments, info = whisper().transcribe(
                f.name,
                language="ro",
                beam_size=5,
                vad_filter=True,
                initial_prompt="eMAG, Trendyol, Base, SKU, EAN, ofertă, preț, stoc, poze, titlu, descriere.",
            )
            text = " ".join(s.text.strip() for s in segments).strip()
        except Exception as e:
            log(f"stt: {e}")
            raise HTTPException(400, f"nu am putut citi audio: {e}")
    log(f"stt: {info.duration:.1f}s audio în {time.time() - t0:.1f}s")
    return {"text": text, "limba": info.language, "durata": round(info.duration, 1)}


def preload():
    """Descarcă din timp vocea implicită și Whisper, ca prima cerere să nu aștepte minute."""
    try:
        ro_text()
        piper_voice(DEFAULT_VOICE.split(":", 1)[1])
        if STT_ON:
            whisper()
    except Exception as e:
        log(f"preîncărcare: {e}")


@app.on_event("startup")
def startup():
    threading.Thread(target=preload, daemon=True).start()
