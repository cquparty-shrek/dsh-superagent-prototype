#!/usr/bin/env python3
"""Transcribe one audio file to text on stdout with faster-whisper (CPU), for the Feishu Source's `asrCommand`.

Usage: asr-whisper.py <audio-file>
Environment: ASR_MODEL (whisper size or directory, default large-v3-turbo), ASR_MODEL_DIR (model cache,
default ~/models/faster-whisper-hub), ASR_THREADS (CTranslate2 CPU threads, default min(32, cores)),
HF_ENDPOINT (default https://hf-mirror.com so first use works in mainland China networks).
"""
import os
import sys

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

from faster_whisper import WhisperModel  # noqa: E402


def model_path() -> str:
    from huggingface_hub import snapshot_download

    model = os.environ.get("ASR_MODEL", "mobiuslabsgmbh/faster-whisper-large-v3-turbo")
    if os.path.isdir(model):
        return model
    cache = os.path.expanduser(os.environ.get("ASR_MODEL_DIR", "~/models/faster-whisper-hub"))
    repo = model if "/" in model else f"Systran/faster-whisper-{model}"
    return snapshot_download(repo, cache_dir=cache, local_files_only=True)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: asr-whisper.py <audio-file>", file=sys.stderr)
        return 2
    threads = int(os.environ.get("ASR_THREADS", str(min(32, os.cpu_count() or 8))))
    model = WhisperModel(model_path(), device="cpu", compute_type="int8", cpu_threads=threads)
    segments, _ = model.transcribe(sys.argv[1], vad_filter=True)
    print(" ".join(segment.text.strip() for segment in segments).strip())
    return 0


if __name__ == "__main__":
    sys.exit(main())
