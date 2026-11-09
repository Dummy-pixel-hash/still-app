"""Original, deterministic 120-BPM score and picture-locked sound design.

All sounds are synthesized here. No downloaded music, samples, or license ambiguity.
"""
from pathlib import Path
import json
import wave
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SR = 48000
DURATION = 30
RNG = np.random.default_rng(74019)
music = np.zeros((SR * DURATION, 2), dtype=np.float64)
effects = np.zeros_like(music)


def add(track, sound, at, gain=1, pan=0):
    i = int(at * SR)
    sound = np.asarray(sound)
    if i < 0:
        sound = sound[-i:]
        i = 0
    size = min(len(sound), len(track) - i)
    if size <= 0:
        return
    signal = sound[:size] * gain
    track[i:i + size, 0] += signal * np.sqrt((1 - pan) / 2)
    track[i:i + size, 1] += signal * np.sqrt((1 + pan) / 2)


def t_for(seconds):
    return np.arange(int(seconds * SR)) / SR


def kick():
    t = t_for(.42)
    f = 47 + 110 * np.exp(-t * 38)
    phase = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(phase) * np.exp(-t * 12) * np.minimum(1, t * 1300)


def hat(opened=False):
    t = t_for(.2 if opened else .065)
    noise = RNG.standard_normal(len(t))
    noise = np.r_[0, np.diff(noise)] / 3
    metallic = sum(np.sin(2 * np.pi * f * t) for f in (5230, 6710, 8240)) / 6
    return (noise + metallic) * np.exp(-t * (28 if opened else 90))


def clap():
    t = t_for(.2)
    noise = RNG.standard_normal(len(t))
    noise = np.r_[0, np.diff(noise)] / 3
    env = sum(np.where(t >= x, np.exp(-np.maximum(0, t - x) * 70), 0) for x in (0, .012, .027))
    return noise * env + np.sin(2 * np.pi * 172 * t) * np.exp(-t * 45) * .24


def note(midi, duration, bass=False):
    t = t_for(duration)
    frequency = 440 * 2 ** ((midi - 69) / 12)
    if bass:
        tone = np.sin(2 * np.pi * frequency * t) + .24 * np.sin(2 * np.pi * frequency * 2 * t)
        env = np.minimum(1, t * 230) * np.minimum(1, (duration - t) * 40) * np.exp(-t * 3.3)
    else:
        tone = np.sin(2 * np.pi * frequency * t) + .35 * np.sin(2 * np.pi * frequency * 2.003 * t) + .10 * np.sin(2 * np.pi * frequency * 3 * t)
        env = (1 - np.exp(-t * 500)) * np.exp(-t * 10)
    return tone * env


def click(at, pitched=1250, gain=.17):
    t = t_for(.055)
    signal = (.3 * RNG.standard_normal(len(t)) + np.sin(2 * np.pi * pitched * t)) * np.exp(-t * 115)
    add(effects, signal, at, gain, .05)


def whoosh(at, length=.3, direction=1, gain=.18):
    t = t_for(length)
    n = RNG.standard_normal(len(t))
    low = np.convolve(n, np.ones(12) / 12, mode='same')
    env = np.sin(np.pi * t / length) ** 2
    signal = (n * .13 + low * .8) * env
    add(effects, signal, at, gain, -.4 * direction)
    add(effects, signal, at + .018, gain * .7, .4 * direction)


# Pitched hook: deliberate accents at 0, 1, and 2.5 seconds.
for at, midi in [(0, 74), (1, 69), (2.5, 77)]:
    add(music, note(midi, .7), at, .22)
    add(music, kick(), at, .45)

roots = [38, 38, 41, 36, 38, 43, 41, 36]
melody = [74, 77, 81, 77, 72, 69, 77, 74]
for beat in range(5, 55):
    at = beat * .5
    # A short intentional break for the coffee card, not a wall of sound.
    if 29 <= beat < 32:
        continue
    bar = (beat - 5) // 4
    pos = (beat - 5) % 4
    root = roots[bar % len(roots)]
    if pos in (0, 2):
        add(music, kick(), at, .56)
    if pos in (1, 3):
        add(music, clap(), at, .24, -.06)
    for off in (0, .25):
        add(music, hat(opened=pos == 3 and off == .25), at + off, .105, .22 if off else -.22)
    add(music, note(root + (12 if pos == 3 else 0), .32, bass=True), at + (.125 if pos == 3 else 0), .30)
    if pos in (0, 2, 3):
        n = melody[(beat + bar) % len(melody)]
        add(music, note(n, .65), at + .25, .135, .25)
        add(music, note(n, .65), at + .5, .04, -.35)
    if pos == 3:
        add(music, note(root + 7, .16, bass=True), at + .375, .16)

# A resolved, spacious logo sting instead of cutting off the loop.
for at, midi, level in [(27, 62, .27), (27.15, 69, .20), (27.3, 77, .20)]:
    add(music, note(midi, 2.5), at, level)
add(music, kick(), 27, .5)

for frame in [75, 210, 315, 480, 585, 720, 810]:
    # The polished picture overlaps shots over 0.47–0.60s. Let the quieter sweep
    # travel WITH the transition rather than finishing before the reveal starts.
    whoosh(frame / 30 + .025, length=.45, gain=.13, direction=1 if frame % 2 else -1)
for at in [0, 1, 2.5, 7, 10.5, 14.5, 16, 19.5, 24, 27]:
    click(at, pitched=780 if at in (1, 14.5) else 1250, gain=.16)

native_path = ROOT / 'public/captures/v4/manifest.json'
manifest = json.loads(native_path.read_text()) if native_path.exists() else json.loads((ROOT / 'public/captures/v3/manifest.json').read_text())
rates = {
    'compose': (2.5, .8, 1.35),
    'search': (7, .65, 1.2),
    'todos': (10.5, .5, 1.25),
    'approval': (16, .5, 1.15),
    'changes': (19.5, .45, 1.2),
}
for name, (offset, trim, rate) in rates.items():
    data = manifest['clips'][name]
    if manifest.get('version') == 4:
        for at in data['cursor']['clicks']:
            click(offset + at, gain=.12)
        for i, at in enumerate(data.get('keyTimes', [])):
            click(offset + at, pitched=1500 + (i % 5) * 87, gain=.032)
        continue
    for event in data['events']:
        if event['label'] in ['model-open', 'model-selected', 'expanded', 'approved', 'review-open', 'css-open']:
            at = offset + (event['at'] - trim) / rate
            click(at, gain=.13)
    if name in ('compose', 'search'):
        first = next(e['at'] for e in data['events'] if e['label'] == 'type')
        last = next(e['at'] for e in data['events'] if e['label'] == ('typed' if name == 'compose' else 'filtered'))
        count = 38 if name == 'compose' else 9
        for i in range(count):
            at = offset + (first + (last-first) * i/count - trim) / rate
            click(at, pitched=1500 + (i % 5) * 87, gain=.035)

# A porcelain clink on the coffee beat, and a restrained laptop closure.
for midi in (91, 98):
    add(effects, note(midi, .45), 14.5, .10, .2)
click(25.95, pitched=210, gain=.27)
whoosh(25.1, length=.7, gain=.12)

def save(name, track):
    peak = float(np.max(np.abs(track)))
    if peak > .85:
        track *= .85 / peak
    fade = np.minimum(1, np.arange(len(track)) / (SR * .01))
    fade *= np.minimum(1, (len(track)-np.arange(len(track))) / (SR * .3))
    pcm = (np.clip(track * fade[:,None], -1, 1) * 32767).astype('<i2')
    with wave.open(str(ROOT / 'public/audio' / name), 'wb') as out:
        out.setnchannels(2)
        out.setsampwidth(2)
        out.setframerate(SR)
        out.writeframes(pcm.tobytes())
    print(f'{name}: 30 seconds, peak {peak:.3f}')

(ROOT / 'public/audio').mkdir(exist_ok=True)
save('still-groove.wav', music)
save('still-picture-sfx.wav', effects)
