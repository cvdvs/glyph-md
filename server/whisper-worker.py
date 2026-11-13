"""Glyph's voice worker: speech to text with mlx_whisper, kept warm by the server.

server/glyph-server.mjs starts this on the first transcription, sends it one job
at a time, and stops it after 15 minutes with nothing to do. It speaks JSON, one
object per line:

  in:   {"id": 1, "path": "/…/glyph-voice-….m4a", "language": "en" | "ro" | null}
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
reports a no_speech_prob of 0.000 even for a file of pure zeros, so the classic
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
MODEL = os.environ.get("GLYPH_WHISPER_MODEL") or "mlx-community/whisper-large-v3-turbo"

# Whisper's well-known inventions on silence: subtitle credits and sign-offs it
# learned from video captions. Dropped only when a segment is nothing else.
EXACT = {
    "thank you for watching",
    "thanks for watching",
    "mulțumesc pentru vizionare",
    "vă mulțumesc pentru vizionare",
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
        import mlx_whisper
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
            result = mlx_whisper.transcribe(
                audio,
                path_or_hf_repo=MODEL,
                language=lang,
                condition_on_previous_text=False,
                word_timestamps=True,
                hallucination_silence_threshold=2.0,
                verbose=None,
            )
            segments = [
                {
                    "start": round(float(s["start"]), 2),
                    "end": round(float(s["end"]), 2),
                    "text": s["text"],
                }
                for s in result.get("segments", [])
                if keep(s, pcm, SAMPLE_RATE, np)
            ]
            reply({
                "id": jid,
                "language": result.get("language"),
                "duration": duration,
                "segments": segments,
            })
        except Exception as e:  # noqa: BLE001 - the class name only, never the text
            reply({"id": jid, "error": type(e).__name__})
    return 0


if __name__ == "__main__":
    sys.exit(main())
