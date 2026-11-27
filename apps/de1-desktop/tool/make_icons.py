"""Interim Dub app icon + launch images (iOS / Android). Usage: python3 tool/make_icons.py .
Replace with the designer's artwork when it is ready."""
import json, os, sys
from PIL import Image, ImageDraw

root = sys.argv[1]  # apps/de1-desktop
TOP = (0x33, 0x58, 0xe8)   # brand-500
BOTTOM = (0x1f, 0x37, 0x9e)  # brand-700
WHITE = (255, 255, 255, 255)

def gradient(size):
    img = Image.new("RGB", (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / (size - 1)
        d.line([(0, y), (size, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)))
    return img

def d_mark(size, scale=1.0):
    """White geometric 'D' on transparent, centered, occupying `scale` of a 58% box."""
    S = size * 4
    m = Image.new("L", (S, S), 0)
    d = ImageDraw.Draw(m)
    h = S * 0.58 * scale
    w = h * 0.86
    x0 = (S - w) / 2 + w * 0.02
    y0 = (S - h) / 2
    stroke = h * 0.2
    r = h / 2
    # outer D: straight left edge, half-circle right edge
    cx = x0 + w - r
    d.rectangle([x0, y0, cx, y0 + h], fill=255)
    d.pieslice([cx - r, y0, cx + r, y0 + h], -90, 90, fill=255)
    # inner cutout
    ir = r - stroke
    d.rectangle([x0 + stroke, y0 + stroke, cx, y0 + h - stroke], fill=0)
    d.pieslice([cx - ir, y0 + stroke, cx + ir, y0 + h - stroke], -90, 90, fill=0)
    m = m.resize((size, size), Image.LANCZOS)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(Image.new("RGBA", (size, size), WHITE), (0, 0), m)
    return out

def square_icon(size):
    bg = gradient(size).convert("RGBA")
    bg.alpha_composite(d_mark(size))
    return bg.convert("RGB")  # App Store: no alpha

def rounded(img, radius_ratio=0.2237):
    size = img.size[0]
    S = size * 4
    m = Image.new("L", (S, S), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, S - 1, S - 1], radius=S * radius_ratio, fill=255)
    m = m.resize((size, size), Image.LANCZOS)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img.convert("RGBA"), (0, 0), m)
    return out

master = square_icon(1024)

# iOS app icon
ios = os.path.join(root, "ios/Runner/Assets.xcassets/AppIcon.appiconset")
for e in json.load(open(os.path.join(ios, "Contents.json")))["images"]:
    px = round(float(e["size"].split("x")[0]) * int(e["scale"][0]))
    master.resize((px, px), Image.LANCZOS).save(os.path.join(ios, e["filename"]), optimize=True)

# iOS launch image: rounded icon, 100pt
launch = os.path.join(root, "ios/Runner/Assets.xcassets/LaunchImage.imageset")
for name, px in [("LaunchImage.png", 100), ("LaunchImage@2x.png", 200), ("LaunchImage@3x.png", 300)]:
    rounded(square_icon(px * 2).resize((px, px), Image.LANCZOS)).save(os.path.join(launch, name), optimize=True)

# Android legacy + adaptive icons
res = os.path.join(root, "android/app/src/main/res")
dens = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
for dname, k in dens.items():
    px = round(48 * k)
    rounded(square_icon(px * 2).resize((px, px), Image.LANCZOS), 0.18).save(
        os.path.join(res, f"mipmap-{dname}/ic_launcher.png"), optimize=True)
    fg = round(108 * k)  # adaptive foreground: mark inside the 66dp safe zone
    d_mark(fg, scale=0.62).save(os.path.join(res, f"mipmap-{dname}/ic_launcher_foreground.png"), optimize=True)
    ld = round(96 * k)
    os.makedirs(os.path.join(res, f"drawable-{dname}"), exist_ok=True)
    rounded(square_icon(ld * 2).resize((ld, ld), Image.LANCZOS), 0.2237).save(
        os.path.join(res, f"drawable-{dname}/launch_logo.png"), optimize=True)
print("done")
