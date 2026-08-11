#!/usr/bin/env python3
"""
Murmur — Whisper tabanlı yerel ses tanıma
Kullanım: python3 transcribe.py [tr|en] [model: tiny|base|small]
Çıktı: INTERIM:... veya FINAL:... veya ERROR:...
"""

import sys
import os
import signal
import subprocess
import tempfile
import threading
import time

LANG  = sys.argv[1] if len(sys.argv) > 1 else "tr"
MODEL = sys.argv[2] if len(sys.argv) > 2 else "base"  # tiny < base < small < medium

# Geçici dosya
tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
tmp.close()
TMP_FILE = tmp.name

rec_proc = None

def cleanup(sig=None, frame=None):
    global rec_proc
    if rec_proc:
        rec_proc.terminate()
    try:
        os.unlink(TMP_FILE)
    except:
        pass
    sys.exit(0)

signal.signal(signal.SIGTERM, cleanup)
signal.signal(signal.SIGINT, cleanup)

def record_audio():
    """sox ile ses gelene kadar kayıt al, 1.5sn sessizlikte dur"""
    global rec_proc
    cmd = [
        "sox", "-d",
        "-r", "16000",   # Whisper 16kHz ister
        "-c", "1",       # mono
        "-b", "16",      # 16-bit
        TMP_FILE,
        "silence",
        "1", "0.3", "1%",   # ses başlayana kadar bekle (düşük eşik)
        "1", "1.5", "1%"    # 1.5sn sessizlikte dur
    ]
    try:
        rec_proc = subprocess.Popen(cmd, stderr=subprocess.DEVNULL)
        rec_proc.wait()
    except FileNotFoundError:
        print("ERROR:sox_not_found", flush=True)
        sys.exit(1)

def transcribe():
    """Whisper ile metne çevir"""
    try:
        import whisper
    except ImportError:
        print("ERROR:whisper_not_installed", flush=True)
        sys.exit(1)

    print("INTERIM:İşleniyor...", flush=True)

    try:
        model = whisper.load_model(MODEL)
        result = model.transcribe(
            TMP_FILE,
            language=LANG,
            fp16=False,
            task="transcribe",
            temperature=0,          # deterministik — daha tutarlı
            condition_on_previous_text=False,
            no_speech_threshold=0.4,
        )
        text = result["text"].strip()
        if text:
            print(f"FINAL:{text}", flush=True)
        else:
            print("FINAL:", flush=True)
    except Exception as e:
        print(f"ERROR:{e}", flush=True)

# Adım 1: Kayıt al
record_audio()

# Adım 2: Transkript et
if os.path.exists(TMP_FILE) and os.path.getsize(TMP_FILE) > 1000:
    transcribe()
else:
    print("FINAL:", flush=True)

cleanup()
