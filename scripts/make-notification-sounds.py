"""Synthesize the Cetus notification sounds into backend/sounds/ (needs numpy).

Usage: python3 scripts/make-notification-sounds.py
The .aiff files are checked in; rerun only when changing a sound. Each one is
copied to the top of the bundle's Resources (see package-electron.mjs), which
is where macOS looks up a notification sound by file name.
"""
import os, subprocess, tempfile, wave
import numpy as np

SR = 48000
rng = np.random.default_rng(7)


def t_axis(dur):
    return np.arange(int(SR * dur)) / SR


def attack(n_ms, n):
    a = np.ones(n)
    k = max(1, int(SR * n_ms / 1000))
    a[:k] = 0.5 - 0.5 * np.cos(np.pi * np.arange(k) / k)
    return a


def place(buf, sig, at):
    i = int(SR * at)
    buf[i : i + len(sig)] += sig[: len(buf) - i]


def reverb(x, decay=0.5, mix=0.12, tail=0.9):
    """Small diffuse room: convolve with band-limited decaying noise."""
    n = int(SR * tail)
    ir = rng.standard_normal(n) * np.exp(-np.arange(n) / (SR * decay / 3))
    # darken the tail: simple one-pole lowpass
    out = np.zeros(n)
    acc = 0.0
    for i in range(n):
        acc += 0.18 * (ir[i] - acc)
        out[i] = acc
    ir = out / np.sqrt(np.sum(out**2))
    L = len(x) + n
    wet = np.fft.irfft(np.fft.rfft(x, L) * np.fft.rfft(ir, L), L)
    dry = np.concatenate([x, np.zeros(n)])
    return dry + mix * wet


def finish(x, peak=0.5, fade_ms=40):
    k = int(SR * fade_ms / 1000)
    # drop the inaudible end of the tail (below -60 dB of peak), then fade
    loud = np.nonzero(np.abs(x) > np.max(np.abs(x)) * 1e-3)[0]
    x = x[: loud[-1] + 1].copy()
    x[-k:] *= np.linspace(1, 0, k) ** 2
    return x / np.max(np.abs(x)) * peak


def tone(freq, dur, tau, partials=((1, 1.0),), atk=3):
    t = t_axis(dur)
    s = np.zeros_like(t)
    for mult, amp, *rest in partials:
        ptau = tau * (rest[0] if rest else 1)
        s += amp * np.sin(2 * np.pi * freq * mult * t) * np.exp(-t / ptau)
    return s * attack(atk, len(t))


# 1. Drop — a single water drop: quick upward pitch glide, short body.
def drop():
    t = t_axis(0.35)
    f = 1250 - (1250 - 430) * np.exp(-t / 0.028)
    phase = 2 * np.pi * np.cumsum(f) / SR
    s = np.sin(phase) * np.exp(-t / 0.06) * attack(2, len(t))
    buf = np.zeros(int(SR * 0.5))
    place(buf, s, 0.0)
    return finish(reverb(buf, decay=0.35, mix=0.10, tail=0.5))


# 2. Sonar — one clear ping with two fading echoes.
def sonar():
    ping = tone(1046.5, 0.9, 0.16, ((1, 1.0), (2, 0.12, 0.5), (3, 0.04, 0.3)), atk=4)
    buf = np.zeros(int(SR * 1.5))
    place(buf, ping, 0.0)
    place(buf, ping * 0.22, 0.30)
    place(buf, ping * 0.07, 0.60)
    return finish(reverb(buf, decay=0.7, mix=0.14, tail=0.9))


# 3. Chime — two mallet notes, a rising fifth.
def chime():
    bar = ((1, 1.0), (4, 0.18, 0.25), (10, 0.05, 0.08))
    buf = np.zeros(int(SR * 1.2))
    place(buf, tone(784.0, 0.9, 0.20, bar), 0.0)
    place(buf, tone(1174.7, 1.0, 0.26, bar), 0.115)
    return finish(reverb(buf, decay=0.6, mix=0.12, tail=0.8))


# 4. Bloom — three soft electric-piano notes opening upward.
def bloom():
    def ep(freq, dur, tau):
        t = t_axis(dur)
        index = 1.6 * np.exp(-t / 0.09)
        s = np.sin(2 * np.pi * freq * t + index * np.sin(2 * np.pi * freq * 2 * t))
        return s * np.exp(-t / tau) * attack(8, len(t))

    buf = np.zeros(int(SR * 1.5))
    for i, (f, g) in enumerate(((587.3, 0.8), (880.0, 0.9), (1108.7, 1.0))):
        place(buf, g * ep(f, 1.1, 0.30), i * 0.085)
    return finish(reverb(buf, decay=0.8, mix=0.16, tail=1.0), peak=0.45)


# 5. Tap — two muted wooden knocks, the second a little higher.
def tap():
    def knock(freq):
        t = t_axis(0.12)
        f = freq * (1 + 0.5 * np.exp(-t / 0.004))
        body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.022)
        click = rng.standard_normal(len(t)) * np.exp(-t / 0.002) * 0.15
        return (body + click) * attack(1, len(t))

    buf = np.zeros(int(SR * 0.4))
    place(buf, knock(620) * 0.8, 0.0)
    place(buf, knock(830), 0.095)
    return finish(reverb(buf, decay=0.25, mix=0.08, tail=0.35))


if __name__ == "__main__":
    out = os.path.join(os.path.dirname(__file__), "..", "backend", "sounds")
    for name, fn in (("drop", drop), ("sonar", sonar), ("chime", chime), ("bloom", bloom), ("tap", tap)):
        x = fn()
        pcm = (np.clip(x, -1, 1) * 32767).astype("<i2")
        with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
            with wave.open(tmp.name, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(SR)
                w.writeframes(pcm.tobytes())
            dst = os.path.join(out, f"cetus-{name}.aiff")
            subprocess.run(["/usr/bin/afconvert", "-f", "AIFF", "-d", "BEI16", tmp.name, dst], check=True)
        print(f"cetus-{name}.aiff: {len(x)/SR:.2f}s")
