"""Render the Reef Feed & Water brand PNGs with Pillow.

Same design as docs/logo/icon.svg: gradient rounded square, wave bands,
three feed pellets falling, fish rising to meet them. Drawn at 4x and
downscaled for antialiasing.
"""
from PIL import Image, ImageDraw, ImageFont
import math
import os

S = 2048  # supersampled master size (4x of 512)
OUT = r"C:\Claude\ha-feedandwater-cards\custom_components\feedandwater\brand"

TOP = (0x22, 0xB8, 0xCF)     # bright aqua
BOTTOM = (0x18, 0x64, 0xAB)  # deep blue


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def make_mark(size=S):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    k = size / 512.0  # design coords are the SVG's 512 grid

    # vertical gradient background
    grad = Image.new("RGBA", (size, size))
    gd = ImageDraw.Draw(grad)
    for y in range(size):
        gd.line([(0, y), (size, y)], fill=lerp(TOP, BOTTOM, y / size) + (255,))
    # rounded-square mask (112/512 corner radius, HA brand convention-ish)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=int(112 * k), fill=255
    )
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img)

    # wave bands: light crest then darker water body
    def wave_polygon(base_y, amp, wavelength, phase=0.0):
        pts = []
        for x in range(0, size + 1, max(1, size // 512)):
            y = base_y + amp * math.sin((x / wavelength) * 2 * math.pi + phase)
            pts.append((x, y))
        pts += [(size, size), (0, size)]
        return pts

    light = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(light).polygon(
        wave_polygon(232 * k, 14 * k, 172 * k), fill=(255, 255, 255, 41)
    )
    img.alpha_composite(Image.composite(light, Image.new("RGBA", img.size, (0,) * 4), mask))

    dark = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(dark).polygon(
        wave_polygon(252 * k, 14 * k, 172 * k, phase=0.6), fill=(11, 79, 138, 90)
    )
    img.alpha_composite(Image.composite(dark, Image.new("RGBA", img.size, (0,) * 4), mask))

    d = ImageDraw.Draw(img)

    # feed pellets
    for cx, cy, r, alpha in [(300, 118, 17, 255), (352, 168, 13, 230), (262, 178, 10, 205)]:
        d.ellipse(
            [(cx - r) * k, (cy - r) * k, (cx + r) * k, (cy + r) * k],
            fill=(255, 255, 255, alpha),
        )

    # fish: body ellipse, tail + dorsal fin triangles, eye
    d.ellipse([(225 - 98) * k, (345 - 56) * k, (225 + 98) * k, (345 + 56) * k],
              fill=(255, 255, 255, 255))
    d.polygon([(305 * k, 345 * k), (395 * k, 296 * k), (395 * k, 394 * k)],
              fill=(255, 255, 255, 255))
    d.polygon([(200 * k, 295 * k), (232 * k, 258 * k), (252 * k, 297 * k)],
              fill=(255, 255, 255, 255))
    d.ellipse([(168 - 11) * k, (331 - 11) * k, (168 + 11) * k, (331 + 11) * k],
              fill=(0x18, 0x64, 0xAB, 255))
    return img


def save(img, path, size):
    img.resize((size, size), Image.LANCZOS).save(path)
    print(path, size)


def find_font(size_px):
    for name in ["seguisb.ttf", "segoeuib.ttf", "arialbd.ttf"]:
        p = os.path.join(r"C:\Windows\Fonts", name)
        if os.path.exists(p):
            return ImageFont.truetype(p, size_px)
    return ImageFont.load_default()


def make_logo():
    """Mark with a wordmark underneath, transparent background."""
    mark = make_mark(1024)
    f1 = find_font(150)
    canvas = Image.new("RGBA", (1024, 1280), (0, 0, 0, 0))
    canvas.alpha_composite(mark, (0, 0))
    d = ImageDraw.Draw(canvas)
    text = "Reef Feed & Water"
    w = d.textlength(text, font=f1)
    # scale text to fit if needed
    if w > 1000:
        f1 = find_font(int(150 * 1000 / w))
        w = d.textlength(text, font=f1)
    d.text(((1024 - w) / 2, 1070), text, font=f1, fill=(0x18, 0x64, 0xAB, 255))
    return canvas


os.makedirs(OUT, exist_ok=True)
mark = make_mark()
save(mark, os.path.join(OUT, "icon.png"), 256)
save(mark, os.path.join(OUT, "icon@2x.png"), 512)

logo = make_logo()
logo.resize((256, 320), Image.LANCZOS).save(os.path.join(OUT, "logo.png"))
print(os.path.join(OUT, "logo.png"), "256x320")
logo.resize((512, 640), Image.LANCZOS).save(os.path.join(OUT, "logo@2x.png"))
print(os.path.join(OUT, "logo@2x.png"), "512x640")
