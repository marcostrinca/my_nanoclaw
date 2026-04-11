#!/usr/bin/env python3
"""
Yume TTS — unified wrapper
Usage:
  python3 tts.py "text here" [lang] [output.wav]

  lang: pt-br (default) | en-us | ja
  output: path for output file (default: /tmp/yume_tts.wav)

Examples:
  python3 tts.py "Olá Marcos!" pt-br
  python3 tts.py "Hello there!" en-us /tmp/hello.wav
  python3 tts.py "こんにちは" ja /tmp/ja.wav
"""
import sys
import os
import subprocess

TTS_DIR = "/usr/local/share/tts"
PIPER_BIN = os.path.join(TTS_DIR, "piper/piper")
PIPER_LIBS = os.path.join(TTS_DIR, "piper")
PIPER_ESPEAK = os.path.join(TTS_DIR, "piper/espeak-ng-data")
PIPER_MODEL = os.path.join(TTS_DIR, "voices/pt_BR-faber-medium.onnx")
KOKORO_DIR = os.path.join(TTS_DIR, "kokoro")

text = sys.argv[1] if len(sys.argv) > 1 else "Olá!"
lang = sys.argv[2] if len(sys.argv) > 2 else "pt-br"
output = sys.argv[3] if len(sys.argv) > 3 else "/tmp/yume_tts.wav"

if lang == "pt-br":
    env = os.environ.copy()
    env["LD_LIBRARY_PATH"] = PIPER_LIBS
    env["ESPEAK_DATA_PATH"] = PIPER_ESPEAK
    proc = subprocess.run(
        [PIPER_BIN, "--model", PIPER_MODEL, "--output_file", output],
        input=text.encode(),
        env=env,
        capture_output=True,
    )
    if proc.returncode != 0:
        print(f"Piper error: {proc.stderr.decode()}", file=sys.stderr)
        sys.exit(1)
else:
    os.chdir(KOKORO_DIR)
    from kokoro_onnx import Kokoro
    import soundfile as sf

    voice_map = {
        "en-us": "af_heart",
        "ja": "jf_alpha",
    }
    voice = voice_map.get(lang, "af_heart")
    kokoro = Kokoro("kokoro-v1.0.onnx", "voices-v1.0.bin")
    samples, sr = kokoro.create(text, voice=voice, speed=1.0, lang=lang)
    sf.write(output, samples, sr)

print(output)
