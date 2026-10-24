"""Builds the slide-ready crops in deck/img/ from the raw captures in deck/img/raw/ (see deck/SOURCES.md).

uv run --with pillow python deck/make_images.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

IMG = Path(__file__).resolve().parent / "img"
RAW = IMG / "raw"


def stack(parts, bg, gap=0, width=None):
    w = width or max(p.width for p in parts)
    h = sum(p.height for p in parts) + gap * (len(parts) - 1)
    out = Image.new("RGB", (w, h), bg)
    y = 0
    for p in parts:
        out.paste(p, (0, y))
        y += p.height + gap
    return out


def rgb(name):
    return Image.open(RAW / name).convert("RGB")


# tweet tiles: header and text only, fixed 956x400 card with X's border colour
for n in ["metazet", "dee_fvg", "goddyfx01", "solst1ne", "whitman", "eastenray", "ezyyren"]:
    im = rgb(f"x-{n}.png")
    im = im.crop((0, 0, im.width, im.height - 16))
    c = Image.new("RGB", (956, 400), (0, 0, 0))
    c.paste(im, (0, 0))
    ImageDraw.Draw(c).rectangle((0, 0, 955, 399), outline=(47, 51, 54), width=2)
    c.save(IMG / f"tile-{n}.png")

t = rgb("x-rh-agents.png")
c = Image.new("RGB", (t.width + 40, t.height + 40), (0, 0, 0))
c.paste(t, (20, 20))
c.save(IMG / "x-robinhood-agents.png")

n = rgb("nr-150k.png")
n.crop((0, 40, n.width, n.height)).save(IMG / "newsroom-150k.png")
rgb("nr-audit.png").save(IMG / "newsroom-audit.png")
rgb("newsroom.png").crop((260, 100, 1040, 270)).save(IMG / "newsroom-head.png")

# Phala attestation: verified banner + MRCONFIG row
full = rgb("phala-report-full.png")
bg = full.getpixel((5, 5))
p = stack([full.crop((190, 20, 2010, 230)), full.crop((190, 380, 2010, 790)), full.crop((190, 2060, 2010, 2200))], bg, gap=24)
p.save(IMG / "phala-attestation.png")
stack([p.crop((14, 420, 1810, 640)), p.crop((14, 668, 1810, 808))], bg).save(IMG / "phala-verified.png")

# admitting tx rows
a = rgb("ex-admit.png")
bgw = a.getpixel((5, 5))
stack([a.crop((0, 0, 1800, 100)), a.crop((0, 460, 1800, 565)), a.crop((0, 640, 1800, 735)), a.crop((0, 815, 1800, 910))], bgw).save(IMG / "explorer-admit.png")

# refusal tx rows
r = rgb("ex-refusal.png")
stack([r.crop((0, 0, 2060, 100)), r.crop((0, 465, 2060, 570)), r.crop((0, 640, 2060, 1000)), r.crop((0, 1010, 2060, 1095))], bgw).save(IMG / "explorer-refusal.png")

# trade logs: address strip, column header, six contiguous rows
t = rgb("ex-trade-log.png")
strip = Image.new("RGB", (1774, 90), t.getpixel((5, 5)))
strip.paste(t.crop((0, 0, 900, 90)), (0, 0))
tb = t.getpixel((600, 400))
stack([strip, t.crop((472, 372, 2246, 452)), t.crop((472, 860, 2246, 1340))], tb).save(IMG / "explorer-trade-logs.png")

# live leaderboard: heading and the table, without the explainer paragraph
l = rgb("live-app.png")
stack([l.crop((230, 1066, 2794, 1170)), l.crop((230, 1380, 2794, 1790))], l.getpixel((300, 1100))).save(IMG / "leaderboard-live.png")

for f in sorted(IMG.glob("*.png")):
    print(f.name, Image.open(f).size)
