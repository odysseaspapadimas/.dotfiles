#!/usr/bin/env python3
"""Decode Herdr's original done sound, adding only Bluetooth silence padding.

Requires ffmpeg when rebuilding. Playback only needs pw-play and the built WAV.
See SOURCES.md and HERDR-LICENSE for the upstream asset's attribution/license.
"""
from pathlib import Path
import subprocess
import wave

RATE = 48000
LEAD_SECONDS = 0.5
TAIL_SECONDS = 0.8


def generate():
    source = Path(__file__).with_name("herdr-done.mp3")
    decoded = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(source), "-f", "s16le",
         "-acodec", "pcm_s16le", "-ac", "1", "-ar", str(RATE), "pipe:1"],
        check=True, capture_output=True,
    ).stdout
    if not decoded or len(decoded) % 2:
        raise ValueError("Expected nonempty 16-bit PCM audio")
    return (bytes(round(LEAD_SECONDS * RATE) * 2)
            + decoded
            + bytes(round(TAIL_SECONDS * RATE) * 2))


if __name__ == "__main__":
    with wave.open(str(Path(__file__).with_name("bb-notification.wav")), "wb") as sound:
        sound.setnchannels(1)
        sound.setsampwidth(2)
        sound.setframerate(RATE)
        sound.writeframes(generate())
