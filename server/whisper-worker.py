"""Glyph's voice worker: speech to text with mlx_whisper, kept warm by the server.

server/glyph-server.mjs starts this on the first transcription, sends it one job
at a time, and stops it after 15 minutes with nothing to do. It speaks JSON, one
object per line:

  in:   {"id": 1, "path": "/…/glyph-voice-….m4a", "language": "en" | "ro" | null}
  then: {"id": 1, "heard": 7.4}       the recording's length, once it is opened
  out:  {"id": 1, "language": "en", "duration": 7.4,
         "segments": [{"start": 0.0, "end": 2.1, "text": "…"}]}
   or:  {"id": 1, "error": "RuntimeError"}

plus one {"ready": true} (or {"fatal": "ImportError"}) when it starts. stdout
carries nothing but those lines: anything a library prints is sent to stderr,
which the server discards. What was said appears only in the reply, never in an
error, so it cannot reach a log.

Nothing is downloaded. The model must already be in the Hugging Face cache, and
HF_HUB_OFFLINE is set before huggingface_hub is first imported. The paragraph
breaks, capitals and full stops are added by the server, not here.

Silence is judged by the audio as well as by Whisper, because large-v3-turbo
(the model before this one) reports a no_speech_prob of 0.000 even for a file of pure zeros, so the classic
guard alone never fires. Measured: digital silence and -64 dBFS hiss both came
back as "Thank you.", and -48 dBFS pink noise as "Продолжение следует...", while
speech peaking at -41 dBFS still transcribed word for word.
"""
import json
import os
import sys

PROTO = sys.stdout
sys.stdout = sys.stderr

os.environ["HF_HUB_OFFLINE"] = "1"
# The full model, not large-v3-turbo: on her own recordings the turbo garbled a
# Romanian sentence, dropped words and commas, and once repeated "else" two
# hundred times, where the full model got every one right (Scripts/voice-compare.py).
MODEL = os.environ.get("GLYPH_WHISPER_MODEL") or "mlx-community/whisper-large-v3-mlx"

# Whisper's well-known inventions on silence: subtitle credits and sign-offs it
# learned from video captions. Dropped only when a segment is nothing else.
EXACT = {
    "thank you for watching",
    "thanks for watching",
    "mulțumesc pentru vizionare",
    "vă mulțumesc pentru vizionare",
    "mulțumim pentru vizionare",
    "să vă mulțumim pentru vizionare",
    "bine ați venit la canalul meu",
    "продолжение следует",
}
PREFIX = (
    "subtitrarea realizată de",
    "subtitles by the amara.org community",
)
# Things people really say, so dropped only when Whisper itself was unsure of a
# word (on silence it gave "Thank" 0.2 and 0.08; said aloud, 0.9 and up).
SHAKY = {"thank you", "thanks", "you", "bye", "mulțumesc"}
SHAKY_PROB = 0.5

# The loudest 20 ms of anything spoken is far above this; a quiet room is below.
SILENCE_DBFS = -55.0

# "Auto" means one of the languages she speaks, never any of Whisper's 99: left
# to choose freely, a short English or Romanian clip came back as Icelandic
# ("Ok, það er test, hvað við?"). And it is chosen per stretch of speech, not
# per recording, because she switches mid-note, and because Whisper's own
# language detector hears her English as Romanian (it rated it 6-9% English),
# after which the English is dropped or quietly translated. See runs_for.
AUTO_LANGUAGES = ("en", "ro")


def reply(obj):
    PROTO.write(json.dumps(obj) + "\n")
    PROTO.flush()


def norm(text):
    t = text.casefold().replace("ş", "ș").replace("ţ", "ț")
    t = t.strip(" \t\r\n.!?…,;:\"'«»„“”-–—")
    return " ".join(t.split())


def loudest_db(pcm, np):
    """The level of the loudest 20 ms, in dB below full scale."""
    frame = 320  # 20 ms at 16 kHz
    if pcm.size == 0:
        return -120.0
    if pcm.size < frame:
        pcm = np.pad(pcm, (0, frame - pcm.size))
    frames = pcm[: pcm.size // frame * frame].astype(np.float64).reshape(-1, frame)
    rms = float(np.sqrt((frames * frames).mean(axis=1)).max())
    return 20.0 * np.log10(max(rms, 1e-6))


# The shortest stretch whose language is judged on its own; a shorter one joins
# the one before it. Her switch from English to Romanian came after a 2 s phrase,
# so 3 s glued the English onto the Romanian and Whisper dropped it.
MIN_PIECE_S = 2.0


def pieces(pcm, rate, np):
    """Stretches of speech, cut at pauses of half a second or more."""
    frame = rate // 50  # 20 ms
    n = pcm.size // frame
    if n < 2:
        return [(0, pcm.size)]
    frames = pcm[: n * frame].astype(np.float64).reshape(-1, frame)
    db = 20.0 * np.log10(np.maximum(np.sqrt((frames * frames).mean(axis=1)), 1e-6))
    quiet = db < max(float(db.max()) - 30.0, SILENCE_DBFS)
    cuts, i = [], 0
    while i < n:
        if not quiet[i]:
            i += 1
            continue
        j = i
        while j < n and quiet[j]:
            j += 1
        if j - i >= 25 and i > 0 and j < n:
            cuts.append((i + j) // 2 * frame)
        i = j
    bounds = [0] + cuts + [pcm.size]
    out = []
    for a, b in zip(bounds[:-1], bounds[1:]):
        if out and (b - a < MIN_PIECE_S * rate or out[-1][1] - out[-1][0] < MIN_PIECE_S * rate):
            out[-1] = (out[-1][0], b)
        else:
            out.append((a, b))
    return out


def runs_for(audio, pcm, lang, model_path, mx, np):
    """[(start, end, language)] in samples. A language that was asked for covers
    the whole recording. On Auto, each stretch of speech is written out both ways
    from one hearing of it, and keeps the language Whisper is surer of: a forced
    translation scores lower than the words actually said. Neighbours that agree
    are joined, so a note in one language is one run, transcribed as before."""
    if lang is not None:
        return [(0, pcm.size, lang)]
    from mlx_whisper.audio import N_FRAMES, N_SAMPLES, SAMPLE_RATE, log_mel_spectrogram, pad_or_trim
    from mlx_whisper.decoding import DecodingOptions, decode
    from mlx_whisper.transcribe import ModelHolder

    model = ModelHolder.get_model(model_path, mx.float16)
    if not model.is_multilingual:
        return [(0, pcm.size, "en")]
    spans = pieces(pcm, SAMPLE_RATE, np)
    codes = []
    # Listening to a stretch costs the same as to a full 30 s (about 0.75 s each
    # on the Mac mini), and that is most of what Auto adds. Eight go through at
    # a time, and 24 tokens of text are plenty to tell which language is surer.
    for k in range(0, len(spans), 8):
        group = spans[k:k + 8]
        mels = mx.stack([
            pad_or_trim(log_mel_spectrogram(audio[a:b], n_mels=model.dims.n_mels, padding=N_SAMPLES), N_FRAMES, axis=-2)
            for a, b in group
        ]).astype(mx.float16)
        heard = model.encoder(mels)
        sure = {
            code: [r.avg_logprob for r in decode(model, heard, DecodingOptions(
                language=code, without_timestamps=True, sample_len=24))]
            for code in AUTO_LANGUAGES
        }
        codes += [max(AUTO_LANGUAGES, key=lambda c: sure[c][i]) for i in range(len(group))]
    runs = []
    for (a, b), code in zip(spans, codes):
        if runs and runs[-1][2] == code:
            runs[-1] = (runs[-1][0], b, code)
        else:
            runs.append((a, b, code))
    return runs


def transcribe(audio, pcm, lang, model_path, mx, np):
    """The kept segments, timed from the start of the recording, and the language
    most of it was in."""
    import mlx_whisper
    from mlx_whisper.audio import SAMPLE_RATE

    segments, spoken = [], {}
    for a, b, code in runs_for(audio, pcm, lang, model_path, mx, np):
        result = mlx_whisper.transcribe(
            audio[a:b],
            path_or_hf_repo=model_path,
            language=code,
            condition_on_previous_text=False,
            word_timestamps=True,
            hallucination_silence_threshold=2.0,
            verbose=None,
        )
        shift = a / SAMPLE_RATE
        for s in result.get("segments", []):
            s = dict(s, start=float(s["start"]) + shift, end=float(s["end"]) + shift)
            if keep(s, pcm, SAMPLE_RATE, np):
                segments.append({"start": round(s["start"], 2), "end": round(s["end"], 2), "text": s["text"]})
        spoken[code] = spoken.get(code, 0) + (b - a)
    return segments, max(spoken, key=spoken.get) if spoken else lang


def keep(seg, pcm, rate, np):
    text = (seg.get("text") or "").strip()
    if not text:
        return False
    # The classic silence guard: Whisper is sure nobody spoke AND unsure of the words.
    if seg.get("no_speech_prob", 0.0) > 0.6 and seg.get("avg_logprob", 0.0) < -1.0:
        return False
    n = norm(text)
    if n in EXACT or n.startswith(PREFIX):
        return False
    words = seg.get("words") or []
    if n in SHAKY and words and min(w.get("probability", 1.0) for w in words) < SHAKY_PROB:
        return False
    # Words placed where the recording is silent were not said.
    a = int(max(0.0, float(seg["start"]) - 0.1) * rate)
    b = int((float(seg["end"]) + 0.1) * rate)
    return loudest_db(pcm[a:b], np) >= SILENCE_DBFS


def main():
    try:
        import mlx.core as mx
        import mlx_whisper  # noqa: F401 - fails here, before "ready", if it is missing
        import numpy as np
        from mlx_whisper.audio import SAMPLE_RATE, load_audio
    except Exception as e:  # noqa: BLE001 - any failure here means "no voice"
        reply({"fatal": type(e).__name__})
        return 1

    # Load the model now, so the first job does not pay for it twice over.
    try:
        from mlx_whisper.transcribe import ModelHolder

        ModelHolder.get_model(MODEL, mx.float16)
        reply({"ready": True})
    except Exception as e:  # noqa: BLE001 - each job will report it again
        reply({"ready": False, "error": type(e).__name__})

    for raw in sys.stdin.buffer:
        try:
            job = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(job, dict):
            continue
        jid = job.get("id")
        try:
            lang = job.get("language")
            if not (isinstance(lang, str) and lang.isalpha() and len(lang) <= 3):
                lang = None
            # Decoded once: its length is the duration, its level says whether
            # anyone spoke, and transcribe takes the array.
            audio = load_audio(str(job["path"]))
            pcm = np.array(audio)
            duration = round(pcm.size / SAMPLE_RATE, 2)
            if loudest_db(pcm, np) < SILENCE_DBFS:
                reply({"id": jid, "language": lang, "duration": duration, "segments": []})
                continue
            # So the server can give a long recording the time it needs.
            reply({"id": jid, "heard": duration})
            segments, language = transcribe(audio, pcm, lang, MODEL, mx, np)
            reply({"id": jid, "language": language, "duration": duration, "segments": segments})
        except Exception as e:  # noqa: BLE001 - the class name only, never the text
            reply({"id": jid, "error": type(e).__name__})
    return 0


if __name__ == "__main__":
    sys.exit(main())
