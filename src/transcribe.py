#!/usr/bin/env python3
"""
Murmur — Groq Whisper API ile ses tanıma
whisper-large-v3-turbo modeli — Türkçe'de mükemmel doğruluk
"""

import sys, os, signal, subprocess, tempfile, threading

LANG    = sys.argv[1] if len(sys.argv) > 1 else "tr"
API_KEY = sys.argv[2] if len(sys.argv) > 2 else ""

stop_event = threading.Event()

def cleanup(sig=None, frame=None):
    stop_event.set()
    sys.exit(0)

signal.signal(signal.SIGTERM, cleanup)
signal.signal(signal.SIGINT, cleanup)

# ─── Groq istemcisi ───────────────────────────────────────────────────────────
try:
    from groq import Groq
    client = Groq(api_key=API_KEY)
    USE_GROQ = True
except Exception:
    USE_GROQ = False

# ─── Ses kaydı ───────────────────────────────────────────────────────────────
def record_chunk(duration=4.0):
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    path = tmp.name
    cmd = ["sox", "-d", "-r", "16000", "-c", "1", "-b", "16",
           path, "trim", "0", str(duration)]
    try:
        proc = subprocess.Popen(cmd, stderr=subprocess.DEVNULL)
        proc.wait(timeout=duration + 2)
    except Exception:
        pass
    return path

def audio_has_speech(path):
    """RMS enerji kontrolü — sessiz parçaları filtrele"""
    try:
        if os.path.getsize(path) < 6000:
            return False
        result = subprocess.run(
            ["sox", path, "-n", "stat"],
            capture_output=True, text=True
        )
        for line in result.stderr.split("\n"):
            if "RMS amplitude" in line:
                return float(line.split()[-1]) > 0.003
        return True
    except:
        return os.path.getsize(path) > 8000 if os.path.exists(path) else False

# ─── Groq API ile transkripsiyon ──────────────────────────────────────────────
def transcribe_groq(path):
    try:
        with open(path, "rb") as f:
            result = client.audio.transcriptions.create(
                file=("audio.wav", f, "audio/wav"),
                model="whisper-large-v3-turbo",
                language=LANG,
                response_format="text",
                prompt=(
                    "Doğal Türkçe konuşma." if LANG == "tr"
                    else "Natural English speech."
                )
            )
        text = str(result).strip()
        return text if len(text) > 1 else ""
    except Exception as e:
        err = str(e)
        if "api_key" in err.lower() or "authentication" in err.lower():
            print("ERROR:Geçersiz API anahtarı", flush=True)
        elif "connection" in err.lower() or "network" in err.lower():
            print("ERROR:İnternet bağlantısı yok", flush=True)
        else:
            print(f"ERROR:{err[:60]}", flush=True)
        return ""
    finally:
        try: os.unlink(path)
        except: pass

# ─── Lokal Whisper (yedek) ────────────────────────────────────────────────────
_model = None

def transcribe_local(path):
    global _model
    try:
        import warnings, whisper
        warnings.filterwarnings("ignore")
        if _model is None:
            _model = whisper.load_model("base")
        result = _model.transcribe(
            path, language=LANG, fp16=False,
            temperature=0, no_speech_threshold=0.6,
            condition_on_previous_text=False,
            compression_ratio_threshold=1.8,
        )
        text = result["text"].strip()
        # Tekrarlayan kelime tespiti — halüsinasyon
        words = text.split()
        if len(words) > 4:
            unique = len(set(words))
            if unique / len(words) < 0.35:   # %35'ten az benzersiz = loop
                return ""
        return text if len(text) > 2 else ""
    except Exception:
        return ""
    finally:
        try: os.unlink(path)
        except: pass

# ─── Ana döngü ────────────────────────────────────────────────────────────────
def main():
    if not API_KEY and USE_GROQ:
        print("ERROR:API_KEY_MISSING", flush=True)
        sys.exit(1)

    print("INTERIM:Dinliyorum...", flush=True)

    while not stop_event.is_set():
        path = record_chunk(4.0)

        if stop_event.is_set():
            try: os.unlink(path)
            except: pass
            break

        if not audio_has_speech(path):
            try: os.unlink(path)
            except: pass
            continue

        print("INTERIM:İşleniyor...", flush=True)

        if USE_GROQ and API_KEY:
            text = transcribe_groq(path)
        else:
            text = transcribe_local(path)

        if text:
            print(f"CHUNK:{text}", flush=True)
            print("INTERIM:Dinliyorum...", flush=True)

if __name__ == "__main__":
    main()
