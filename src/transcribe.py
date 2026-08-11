#!/usr/bin/env python3
"""
Murmur — Gerçek zamanlı Whisper transkripsiyon
Anti-halüsinasyon filtreleri ile güçlendirilmiş.
"""

import sys, os, signal, subprocess, tempfile, warnings
warnings.filterwarnings("ignore")

LANG  = sys.argv[1] if len(sys.argv) > 1 else "tr"
MODEL = sys.argv[2] if len(sys.argv) > 2 else "base"

# ─── Whisper modelini yükle ───────────────────────────────────────────────────
import whisper
_model = None

def get_model():
    global _model
    if _model is None:
        _model = whisper.load_model(MODEL)
    return _model

# ─── Bilinen halüsinasyonlar — Türkçe ────────────────────────────────────────
# Whisper sessizlikte veya gürültüde bunları üretiyor
TR_HALLUCINATIONS = {
    "bu dizinin betimlemesi trt tarafından sesli betimleme derneği'ne yaptırılmıştır",
    "bu dizi trt tarafından sesli betimleme",
    "altyazı m.k.",
    "altyazı",
    "çeviri",
    "çeviri ve seslendirme",
    "teşekkürler",
    "teşekkür ederim",
    "iyi seyirler",
    "bizi izlediğiniz için teşekkürler",
    "abone olmayı unutmayın",
    "beğenmeyi unutmayın",
    "görüşmek üzere",
    "subtitle",
    "subtitles",
    "thank you for watching",
    "thanks for watching",
    "please subscribe",
}

EN_HALLUCINATIONS = {
    "thank you for watching", "thanks for watching",
    "please subscribe", "like and subscribe",
    "don't forget to subscribe",
}

def is_hallucination(text):
    """Bilinen halüsinasyon mu?"""
    lower = text.lower().strip(".,!? \n")
    hallucinations = TR_HALLUCINATIONS if LANG == "tr" else EN_HALLUCINATIONS
    for h in hallucinations:
        if h in lower or lower in h:
            return True
    # Çok kısa veya tekrar eden karakterler
    if len(lower) < 3:
        return True
    # Sadece noktalama
    if all(c in '.,!?-_:;"\' ' for c in lower):
        return True
    return False

# ─── Sinyal işleme ───────────────────────────────────────────────────────────
import threading
stop_event = threading.Event()

def cleanup(sig=None, frame=None):
    stop_event.set()
    sys.exit(0)

signal.signal(signal.SIGTERM, cleanup)
signal.signal(signal.SIGINT, cleanup)

# ─── Ses kaydı ───────────────────────────────────────────────────────────────
def record_chunk(duration=3.5):
    """Sabit süreli parça kaydet"""
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    path = tmp.name

    cmd = ["sox", "-d", "-r", "16000", "-c", "1", "-b", "16", path,
           "trim", "0", str(duration)]
    try:
        proc = subprocess.Popen(cmd, stderr=subprocess.DEVNULL)
        proc.wait(timeout=duration + 2)
    except Exception:
        pass
    return path

def audio_has_speech(path):
    """Dosyada gerçek ses var mı? sox ile RMS enerji kontrolü."""
    try:
        if os.path.getsize(path) < 5000:   # çok küçük = sessizlik
            return False
        # sox ile ortalama güç seviyesini ölç
        result = subprocess.run(
            ["sox", path, "-n", "stat"],
            capture_output=True, text=True
        )
        output = result.stderr
        for line in output.split("\n"):
            if "RMS amplitude" in line:
                val = float(line.split()[-1])
                return val > 0.002   # eşik altı = sessizlik
        return True
    except:
        size = os.path.getsize(path) if os.path.exists(path) else 0
        return size > 6000

# ─── Transkripsiyon ───────────────────────────────────────────────────────────
def transcribe_chunk(path):
    """Tek parçayı yazıya çevir — halüsinasyon filtreli."""
    try:
        model = get_model()

        # Türkçe doğruluğunu artıran prompt
        initial_prompt = (
            "Kullanıcının konuşması, doğal Türkçe cümleler." if LANG == "tr"
            else "Natural English speech."
        )

        result = model.transcribe(
            path,
            language=LANG,
            fp16=False,
            task="transcribe",
            temperature=0.0,            # deterministik
            condition_on_previous_text=False,
            no_speech_threshold=0.6,    # sessizliği daha agresif filtrele
            logprob_threshold=-1.2,     # düşük güvenli sonuçları at
            compression_ratio_threshold=2.2,
            initial_prompt=initial_prompt,
        )

        text = result["text"].strip()

        # Halüsinasyon kontrolü
        if not text or is_hallucination(text):
            return ""

        # Güven skoru kontrolü — çok düşükse at
        if "segments" in result:
            segs = result["segments"]
            if segs:
                avg_logprob = sum(s.get("avg_logprob", 0) for s in segs) / len(segs)
                no_speech   = max(s.get("no_speech_prob", 0) for s in segs)
                if avg_logprob < -1.0 or no_speech > 0.7:
                    return ""

        return text

    except Exception as e:
        return ""
    finally:
        try: os.unlink(path)
        except: pass

# ─── Ana döngü ────────────────────────────────────────────────────────────────
def main():
    print("INTERIM:Dinliyorum...", flush=True)

    try:
        get_model()
    except Exception as e:
        print(f"ERROR:Model yüklenemedi", flush=True)
        sys.exit(1)

    while not stop_event.is_set():
        path = record_chunk(3.5)

        if stop_event.is_set():
            try: os.unlink(path)
            except: pass
            break

        # Önce ses seviyesi kontrolü — boş parçaları Whisper'a gönderme
        if not audio_has_speech(path):
            try: os.unlink(path)
            except: pass
            continue

        print("INTERIM:İşleniyor...", flush=True)
        text = transcribe_chunk(path)

        if text:
            print(f"CHUNK:{text}", flush=True)
            print("INTERIM:Dinliyorum...", flush=True)

if __name__ == "__main__":
    main()
