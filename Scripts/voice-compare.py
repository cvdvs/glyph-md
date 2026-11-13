"""Compare speech-to-text setups on real recordings, side by side.

The phone server keeps recordings only while ~/.config/glyph/voice-samples
exists (its owner makes it). This runs each kept recording through several
setups and writes one HTML page: the recording, then what each setup heard and
how long it took. The person who spoke judges, since only they know what was said.

  python3 Scripts/voice-compare.py [samples dir] [report.html]

Setups:
  Glyph now           server/whisper-worker.py itself: large-v3, and on Auto the
                      language chosen per stretch of speech
  large-v3-turbo      the model Glyph used before (its decoder cut from 32 layers to 4)
  large-v3            the full model, Auto choosing one language per recording
  large-v3 + words    the same, with ~/.config/glyph/voice-words.txt as a hint
  OpenAI whisper-1    OpenAI's hosted Whisper (large-v2)
  OpenAI gpt-4o       gpt-4o-transcribe, with the word list as its prompt

The two OpenAI rows run only when ~/.config/glyph/openai-key exists, and send
the recordings to OpenAI. The key is read from that file and never printed.
Run it with the Python that has mlx_whisper (~/.config/glyph/python).
"""
import html
import importlib.util
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.expanduser("~/.config/glyph")
SAMPLES = sys.argv[1] if len(sys.argv) > 1 else os.path.join(CONFIG, "voice-samples")
REPORT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(SAMPLES, "comparison.html")
AUDIO_EXT = (".m4a", ".aac", ".webm", ".ogg", ".wav", ".mp3", ".aiff")

TURBO = "mlx-community/whisper-large-v3-turbo"
LARGE = "mlx-community/whisper-large-v3-mlx"

os.environ.setdefault("HF_HUB_OFFLINE", "1")
spec = importlib.util.spec_from_file_location("worker", os.path.join(HERE, "..", "server", "whisper-worker.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
sys.stdout = sys.__stdout__  # the worker module points stdout at stderr for its protocol

import mlx.core as mx  # noqa: E402
import mlx_whisper  # noqa: E402
import numpy as np  # noqa: E402
from mlx_whisper.audio import N_FRAMES, N_SAMPLES, SAMPLE_RATE, load_audio, log_mel_spectrogram, pad_or_trim  # noqa: E402
from mlx_whisper.transcribe import ModelHolder  # noqa: E402


def words():
    try:
        with open(os.path.join(CONFIG, "voice-words.txt"), encoding="utf-8") as f:
            lines = [l.strip() for l in f if l.strip() and not l.lstrip().startswith("#")]
    except OSError:
        return []
    return lines[:80]


# A hint in the language being spoken, written the way the notes should come out:
# Romanian with its diacritics, so the model leans towards writing them.
def hint(lang, terms):
    if not terms:
        return None
    if lang == "ro":
        return "O notiță dictată. Cuvinte care pot apărea: " + ", ".join(terms) + "."
    return "A dictated note. Words that may come up: " + ", ".join(terms) + "."


def pick(model_path, audio):
    model = ModelHolder.get_model(model_path, mx.float16)
    mel = log_mel_spectrogram(audio, n_mels=model.dims.n_mels, padding=N_SAMPLES)
    mel = pad_or_trim(mel, N_FRAMES, axis=-2).astype(mx.float16)
    _, probs = model.detect_language(mel)
    return max(worker.AUTO_LANGUAGES, key=lambda c: probs.get(c, 0.0))


def local(path, model_path, asked, prompt_terms):
    audio = load_audio(path)
    pcm = np.array(audio)
    if worker.loudest_db(pcm, np) < worker.SILENCE_DBFS:
        return "", None
    lang = asked if asked in ("en", "ro") else pick(model_path, audio)
    result = mlx_whisper.transcribe(
        audio, path_or_hf_repo=model_path, language=lang,
        initial_prompt=hint(lang, prompt_terms) if prompt_terms else None,
        condition_on_previous_text=False, word_timestamps=True,
        hallucination_silence_threshold=2.0, verbose=None,
    )
    kept = [s for s in result.get("segments", []) if worker.keep(s, pcm, SAMPLE_RATE, np)]
    return " ".join(s["text"].strip() for s in kept).strip(), lang


# What the phone server does now: the worker's own code, so this row is Glyph.
def glyph(path, model_path, asked):
    audio = load_audio(path)
    pcm = np.array(audio)
    if worker.loudest_db(pcm, np) < worker.SILENCE_DBFS:
        return "", None
    lang = asked if asked in ("en", "ro") else None
    segments, mostly = worker.transcribe(audio, pcm, lang, model_path, mx, np)
    return " ".join(seg["text"].strip() for seg in segments).strip(), mostly


def openai(path, model, asked, prompt_terms, key):
    fields = {"model": model, "response_format": "json"}
    if asked in ("en", "ro"):
        fields["language"] = asked
    if prompt_terms:
        fields["prompt"] = hint(asked if asked == "ro" else "en", prompt_terms)
    boundary = uuid.uuid4().hex
    body = b""
    for k, v in fields.items():
        body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
    with open(path, "rb") as f:
        data = f.read()
    body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"note{os.path.splitext(path)[1]}\"\r\n"
             "Content-Type: application/octet-stream\r\n\r\n").encode() + data + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request("https://api.openai.com/v1/audio/transcriptions", data=body, method="POST",
                                 headers={"Authorization": "Bearer " + key,
                                          "Content-Type": "multipart/form-data; boundary=" + boundary})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read().decode("utf-8")).get("text", "").strip(), None
    except urllib.error.HTTPError as e:
        return "", f"OpenAI said {e.code}"
    except OSError as e:
        return "", type(e).__name__


def main():
    recordings = sorted(n for n in os.listdir(SAMPLES) if n.lower().endswith(AUDIO_EXT))
    if not recordings:
        print("No recordings in", SAMPLES)
        return 1
    terms = words()
    key = None
    try:
        with open(os.path.join(CONFIG, "openai-key"), encoding="utf-8") as f:
            key = f.read().strip() or None
    except OSError:
        pass

    setups = [("Glyph now (large-v3, Auto by stretch of speech)", "glyph", worker.MODEL, False),
              ("large-v3-turbo (Glyph before)", "local", TURBO, False),
              ("large-v3, one language per recording", "local", LARGE, False)]
    if terms:
        setups.append(("large-v3 + your words", "local", LARGE, True))
    if key:
        setups += [("OpenAI whisper-1 (hosted large-v2)", "openai", "whisper-1", False),
                   ("OpenAI gpt-4o-transcribe" + (" + your words" if terms else ""), "openai", "gpt-4o-transcribe", True)]

    rows = {n: [] for n in recordings}
    # One model at a time: loading one costs seconds and the cache holds one.
    for name, kind, model, use_words in setups:
        print("—", name)
        for n in recordings:
            path = os.path.join(SAMPLES, n)
            meta = {}
            try:
                with open(os.path.splitext(path)[0] + ".json", encoding="utf-8") as f:
                    meta = json.load(f)
            except (OSError, ValueError):
                pass
            asked = meta.get("asked")
            t0 = time.time()
            if kind == "local":
                text, lang = local(path, model, asked, terms if use_words else None)
                note = lang or ""
            elif kind == "glyph":
                text, lang = glyph(path, model, asked)
                note = lang or ""
            else:
                text, problem = openai(path, model, asked, terms if use_words else None, key)
                note = problem or ""
            rows[n].append((name, text, time.time() - t0, note))
            print(f"   {n}: {time.time() - t0:.1f}s")

    out = ["<!doctype html><meta charset=utf-8><title>Voice comparison</title>",
           "<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:920px;margin:32px auto;padding:0 16px;color:#222}"
           "h1{font-size:26px}h2{font-size:15px;color:#666;font-weight:600;margin:40px 0 6px}"
           "table{border-collapse:collapse;width:100%}td{border-top:1px solid #ddd;padding:10px 8px;vertical-align:top}"
           "td:first-child{width:220px;color:#555;font-size:14px}td.t{white-space:pre-wrap}"
           "small{color:#888}audio{width:100%;margin:6px 0}"
           "@media(prefers-color-scheme:dark){body{background:#1c1c20;color:#ddd}td{border-color:#333}td:first-child,h2{color:#aaa}}</style>",
           "<h1>Voice comparison</h1>",
           f"<p>{len(recordings)} recordings. Each row is one setup: what it heard, and how long it took on this Mac "
           "(or on OpenAI's servers). Listen, then read which rows say what you said.</p>"]
    for n in recordings:
        out.append(f"<h2>{html.escape(n)}</h2><audio controls preload=none src=\"{html.escape(n)}\"></audio><table>")
        for name, text, secs, note in rows[n]:
            extra = f" · {html.escape(note)}" if note else ""
            out.append(f"<tr><td>{html.escape(name)}<br><small>{secs:.1f}s{extra}</small></td>"
                       f"<td class=t>{html.escape(text) or '<small>(nothing)</small>'}</td></tr>")
        out.append("</table>")
    with open(REPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(out) + "\n")
    os.chmod(REPORT, 0o600)
    print("Report:", REPORT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
