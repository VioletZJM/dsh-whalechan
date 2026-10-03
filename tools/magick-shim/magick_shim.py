#!/usr/bin/env python3
"""A Pillow-backed stand-in for the `magick` calls the Whale-chan oracle makes.

Why this exists: the frozen Python oracle identifies reference images through
ImageMagick, which DSH does not ship and which this machine does not have. That
one missing binary takes 20 of `test_manage_run.py`'s 38 tests offline — and
those tests are the safety net the plugin rewrite is measured against, so they
have to run.

Scope is deliberately narrow: the four inspection shapes the oracle uses, plus the
one drawing shape `measure-form.py` needs to render a measurement overlay. Anything
else is refused loudly rather than approximated, because a half-faithful shape is
worse than an error.

Call it through `oracle_bootstrap.install()` rather than as an executable: the
format strings contain `%` and `|`, which cmd.exe mangles when a `.cmd` wrapper
forwards them through `%*`. Intercepting `shutil.which` and `subprocess.run`
in-process avoids the shell entirely.

Fidelity caveat, split in two because the two halves have different consequences:

- **Reading** (`identify`, `-alpha extract`). This makes the oracle *internally*
  consistent again. It does NOT prove Pillow agrees with ImageMagick on every
  image, and that claim would need a real `magick`. What it does cover is checked
  by running the oracle's own suite against it.
- **Drawing** (the overlay). Pillow's strokes are not byte-identical to
  ImageMagick's: antialiasing and outline placement differ. Nothing in the engine
  compares an overlay against a reference rendering — the digest recorded in the
  evidence is computed from the file that was just written, by the same process
  that wrote it — so the difference is not invisible-but-load-bearing, it is
  genuinely cosmetic. It is stated here because a human comparing two overlays
  side by side would otherwise be the one to discover it.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw


@dataclass(frozen=True)
class Result:
    """What a `magick` invocation would have produced."""

    code: int
    stdout: str
    stderr: str


def _error(message: str) -> Result:
    return Result(1, "", f"magick-shim: {message}\n")


def has_alpha(image: Image.Image) -> bool:
    """Does this image carry an alpha channel, by ImageMagick's reckoning?"""
    if image.mode in ("RGBA", "LA", "PA"):
        return True
    return image.mode == "P" and "transparency" in image.info


def im_format(image: Image.Image) -> str:
    """ImageMagick's `%m`: the magic name, so `JPEG` rather than `JPG`."""
    name = (image.format or "").upper()
    return "JPEG" if name == "JPG" else name


def im_colorspace(image: Image.Image) -> str:
    """ImageMagick's `%[colorspace]`, narrowed to what the oracle compares."""
    if image.mode in ("L", "LA", "1"):
        return "Gray"
    if image.mode == "CMYK":
        return "CMYK"
    return "sRGB"


def im_channels(image: Image.Image) -> str:
    """ImageMagick's `%[channels]`, which `validate-image.py` lowercases."""
    if image.mode in ("L", "1"):
        return "gray"
    if image.mode == "LA":
        return "graya"
    if image.mode == "CMYK":
        return "cmyk"
    return "srgba" if has_alpha(image) else "srgb"


def alpha_channel(image: Image.Image) -> Image.Image:
    """The alpha plane, or an error — the oracle only asks when alpha exists."""
    if not has_alpha(image):
        raise ValueError("image has no alpha channel")
    return image.convert("RGBA").getchannel("A")


def expand_identify(image: Image.Image, template: str) -> str:
    """Substitute the `%` escapes the oracle's two `identify` calls use."""
    tokens = {
        "%m": im_format(image),
        "%w": str(image.width),
        "%h": str(image.height),
        "%[colorspace]": im_colorspace(image),
        "%[channels]": im_channels(image),
    }
    out = template
    for token, value in tokens.items():
        out = out.replace(token, value)
    return out


def fx_minima(image: Image.Image) -> str:
    """`-alpha extract -format %[fx:minima]`: the smallest alpha, normalized."""
    lowest = alpha_channel(image).getextrema()[0]
    return f"{lowest / 255.0:g}"


def fx_transparent_fraction(image: Image.Image) -> str:
    """`-alpha extract -threshold 5% -format %[fx:1-mean]`.

    `-threshold` paints every pixel above the cutoff white and the rest black, so
    `1-mean` is the share of pixels at or below 5% alpha — the oracle compares it
    against 0.01 to catch an image that is nominally transparent but has no
    actually-transparent area.
    """
    alpha = alpha_channel(image)
    cutoff = 0.05 * 255.0
    histogram = alpha.histogram()
    above = sum(count for value, count in enumerate(histogram) if value > cutoff)
    mean = above / (image.width * image.height)
    return f"{1.0 - mean:g}"


def invoke(argv: list[str]) -> Result:
    """Run one `magick` invocation against Pillow.

    @param argv - arguments as they would follow the `magick` executable.
    @returns the exit code and the two output streams.
    """
    if not argv:
        return _error("no arguments")

    if argv[0] == "identify":
        rest = [item for item in argv[1:] if item != "-quiet"]
        if "-format" not in rest:
            return _error("only `identify -quiet -format <template> <path>` is supported")
        template = rest[rest.index("-format") + 1]
        try:
            with Image.open(Path(rest[-1])) as image:
                # **No trailing newline.** ImageMagick's `identify -format` emits the
                # template and nothing else, and the difference is visible in a real
                # recorded run of the upstream skill: its own `validate-assignment`
                # output records `"colorspace": "sRGB"` rather than `"sRGB\n"`. The
                # engine splits that line without stripping (`manage-run.py`,
                # `identify_reference`), so a newline here would have been recorded.
                # It was not, so the shim must not add one.
                return Result(0, expand_identify(image, template), "")
        except OSError as exc:
            return _error(f"cannot decode {rest[-1]}: {exc}")

    if "-alpha" in argv and "extract" in argv and "info:" in argv:
        try:
            with Image.open(Path(argv[0])) as image:
                value = fx_transparent_fraction(image) if "-threshold" in argv else fx_minima(image)
                return Result(0, f"{value}\n", "")
        except (OSError, ValueError) as exc:
            return _error(f"cannot inspect {argv[0]}: {exc}")

    if "-size" in argv and any(item.startswith("xc:") for item in argv):
        return _render_canvas(argv)

    if "-draw" in argv:
        return _draw_over_image(argv)

    return _error(f"unsupported invocation: {' '.join(argv)}")


# ImageMagick's `png:color-type` numbers, mapped to the Pillow mode each one means.
PNG_COLOR_TYPE_MODES = {0: "L", 2: "RGB", 3: "P", 4: "LA", 6: "RGBA"}

# The named colours the fixtures use. `xc:` accepts far more; unknown names fail loudly.
NAMED_COLORS = {
    "black": (0, 0, 0, 255),
    "white": (255, 255, 255, 255),
    "red": (255, 0, 0, 255),
    "green": (0, 128, 0, 255),
    "lime": (0, 255, 0, 255),
    "blue": (0, 0, 255, 255),
    "yellow": (255, 255, 0, 255),
    "cyan": (0, 255, 255, 255),
    "magenta": (255, 0, 255, 255),
    "gray": (128, 128, 128, 255),
    "grey": (128, 128, 128, 255),
    "none": (0, 0, 0, 0),
    "transparent": (0, 0, 0, 0),
}


def parse_color(spec: str) -> tuple[int, int, int, int]:
    """Parse the `xc:` and `-fill` colours the fixtures use."""
    lowered = spec.strip().lower()
    if lowered in NAMED_COLORS:
        return NAMED_COLORS[lowered]
    if lowered.startswith("#"):
        digits = lowered[1:]
        if len(digits) == 3:
            return (*(int(digit * 2, 16) for digit in digits), 255)
        if len(digits) == 6:
            return (*(int(digits[index:index + 2], 16) for index in (0, 2, 4)), 255)
        if len(digits) == 8:
            return (*(int(digits[index:index + 2], 16) for index in (0, 2, 4, 6)),)
    functional = re.fullmatch(r"(rgba?)\(([^)]*)\)", lowered)
    if functional is not None:
        parts = [part.strip() for part in functional.group(2).split(",")]
        if len(parts) not in (3, 4):
            raise ValueError(f"unsupported colour: {spec}")
        red, green, blue = (int(float(part)) for part in parts[:3])
        # ImageMagick spells alpha as a 0..1 fraction here, unlike the 0..255 channels.
        alpha = round(float(parts[3]) * 255) if len(parts) == 4 else 255
        return (red, green, blue, alpha)
    raise ValueError(f"unsupported colour: {spec}")


def _draw_rectangle(image: Image.Image, geometry: str, fill: tuple[int, int, int, int] | None) -> str | None:
    """Apply one `rectangle x1,y1 x2,y2` primitive; return an error, or None on success."""
    numbers = re.fullmatch(r"\s*(-?\d+)\s*,\s*(-?\d+)\s+(-?\d+)\s*,\s*(-?\d+)\s*", geometry)
    if numbers is None:
        return f"unsupported draw primitive: rectangle {geometry}"
    if fill is None:
        return None
    left, top, right, bottom = (int(item) for item in numbers.groups())
    ImageDraw.Draw(image).rectangle([left, top, right, bottom], fill=fill)
    return None


def _render_canvas(argv: list[str]) -> Result:
    """`-size <WxH> xc:<colour> [-fill <colour> -draw <primitive>]... [-define png:color-type=N] <out.png>`.

    The oracle's fixtures use this to manufacture candidate PNGs, so the file only
    has to be a real PNG of the requested geometry, channel layout, and paint.
    """
    size: tuple[int, int] | None = None
    color = ""
    color_type: int | None = None
    fill: tuple[int, int, int, int] | None = None
    draws: list[str] = []
    output = ""
    index = 0
    while index < len(argv):
        item = argv[index]
        if item == "-size" and index + 1 < len(argv):
            width, _, height = argv[index + 1].lower().partition("x")
            size = (int(width), int(height))
            index += 2
            continue
        if item == "-define" and index + 1 < len(argv):
            definition = argv[index + 1]
            if definition.startswith("png:color-type="):
                color_type = int(definition.split("=", 1)[1])
            index += 2
            continue
        if item == "-fill" and index + 1 < len(argv):
            spec = argv[index + 1]
            fill = None if spec.strip().lower() in ("none", "transparent") else parse_color(spec)
            index += 2
            continue
        if item == "-draw" and index + 1 < len(argv):
            draws.append(argv[index + 1])
            index += 2
            continue
        if item.startswith("xc:"):
            color = item[3:]
            index += 1
            continue
        output = item
        index += 1

    if size is None or color == "" or output == "":
        return _error(f"incomplete canvas invocation: {' '.join(argv)}")
    try:
        rgba = parse_color(color)
        mode = PNG_COLOR_TYPE_MODES.get(color_type, "RGBA" if rgba[3] != 255 else "RGB")
        image = Image.new("RGBA", size, rgba)
        for primitive in draws:
            verb, _, geometry = primitive.partition(" ")
            if verb == "rectangle":
                problem = _draw_rectangle(image, geometry, fill)
                if problem is not None:
                    return _error(problem)
            else:
                return _error(f"unsupported draw primitive: {verb}")
        if mode == "RGB":
            image = image.convert("RGB")
        elif mode == "L":
            image = image.convert("L")
        elif mode == "LA":
            image = image.convert("LA")
        elif mode == "P":
            image = image.convert("P")
        image.save(output, format="PNG")
    except (OSError, ValueError) as exc:
        return _error(f"cannot write {output}: {exc}")
    return Result(0, "", "")


# The draw primitives ImageMagick's `-draw` accepts and this port implements.
PRIMITIVE = re.compile(r"\b(line|circle|rectangle)\b", re.IGNORECASE)

# A coordinate, as ImageMagick's `%g` writes it.
NUMBER = re.compile(r"-?\d+(?:\.\d+)?")

# ImageMagick spells "do not paint" as a colour name; `-fill none` is the common one.
NO_PAINT = ("none", "transparent")


@dataclass(frozen=True)
class Paint:
    """The drawing state in force when one `-draw` was read."""

    stroke: tuple[int, int, int, int] | None
    fill: tuple[int, int, int, int] | None
    width: float


def split_primitives(text: str) -> list[tuple[str, str]]:
    """Split one `-draw` payload into `(verb, geometry)` pairs.

    A single `-draw` argument carries a *sequence* of primitives — `measure-form.py`
    passes three `line`s and five `circle`s in one string each — so the payload has
    to be tokenized before it can be drawn.
    """
    starts = list(PRIMITIVE.finditer(text))
    if not starts:
        raise ValueError(f"unsupported draw primitive: {text.strip()}")
    if text[: starts[0].start()].strip():
        raise ValueError(f"unsupported draw primitive: {text.strip()}")
    parts: list[tuple[str, str]] = []
    for index, match in enumerate(starts):
        end = starts[index + 1].start() if index + 1 < len(starts) else len(text)
        parts.append((match.group(1).lower(), text[match.end():end].strip()))
    return parts


def parse_points(geometry: str, expected: int, verb: str) -> list[tuple[float, float]]:
    """Read `x1,y1 x2,y2 …` into number pairs, refusing anything else."""
    numbers = [float(item) for item in NUMBER.findall(geometry)]
    if len(numbers) != expected * 2:
        raise ValueError(f"unsupported {verb} geometry: {geometry}")
    return [(numbers[index * 2], numbers[index * 2 + 1]) for index in range(expected)]


def _paint_primitive(
    draw: ImageDraw.ImageDraw,
    verb: str,
    geometry: str,
    paint: Paint,
) -> str | None:
    """Draw one primitive; return an error, or None on success."""
    try:
        if verb == "line":
            start, end = parse_points(geometry, 2, verb)
            if paint.stroke is not None:
                draw.line([start, end], fill=paint.stroke, width=max(1, round(paint.width)))
            return None
        if verb == "circle":
            centre, through = parse_points(geometry, 2, verb)
            radius = ((through[0] - centre[0]) ** 2 + (through[1] - centre[1]) ** 2) ** 0.5
            if radius <= 0:
                return f"unsupported circle geometry: {geometry}"
            box = [
                centre[0] - radius,
                centre[1] - radius,
                centre[0] + radius,
                centre[1] + radius,
            ]
            draw.ellipse(
                box,
                fill=paint.fill,
                outline=paint.stroke,
                width=max(1, round(paint.width)) if paint.stroke is not None else 0,
            )
            return None
        if verb == "rectangle":
            first, second = parse_points(geometry, 2, verb)
            draw.rectangle(
                [first, second],
                fill=paint.fill,
                outline=paint.stroke,
                width=max(1, round(paint.width)) if paint.stroke is not None else 0,
            )
            return None
    except ValueError as exc:
        return str(exc)
    return f"unsupported draw primitive: {verb}"


def _draw_over_image(argv: list[str]) -> Result:
    """`<input> [-stroke C] [-strokewidth N] [-fill C] [-draw <primitives>]… <output>`.

    The overlay shape: an existing image, annotated in place. Setting order matters
    and is preserved — `measure-form.py` strokes the head axis red, then the body
    chain blue, then paints the joint markers yellow on top — so the paint state is
    captured *when each* `-draw` is read rather than applied from the final state.
    """
    source = ""
    output = ""
    stroke: tuple[int, int, int, int] | None = (0, 0, 0, 255)  # ImageMagick's default
    fill: tuple[int, int, int, int] | None = None
    width = 1.0
    draws: list[tuple[Paint, str]] = []

    index = 0
    while index < len(argv):
        item = argv[index]
        if item in ("-stroke", "-fill", "-strokewidth") and index + 1 < len(argv):
            value = argv[index + 1]
            try:
                if item == "-strokewidth":
                    width = float(value)
                else:
                    parsed = None if value.strip().lower() in NO_PAINT else parse_color(value)
                    if item == "-stroke":
                        stroke = parsed
                    else:
                        fill = parsed
            except ValueError as exc:
                return _error(str(exc))
            index += 2
            continue
        if item == "-draw" and index + 1 < len(argv):
            draws.append((Paint(stroke, fill, width), argv[index + 1]))
            index += 2
            continue
        if item in ("-stroke", "-fill", "-strokewidth", "-draw"):
            return _error(f"{item} needs a value: {' '.join(argv)}")
        if source == "":
            source = item
        elif output == "":
            output = item
        else:
            return _error(f"unsupported invocation: {' '.join(argv)}")
        index += 1

    if source == "" or output == "":
        return _error(f"incomplete drawing invocation: {' '.join(argv)}")
    if not draws:
        return _error(f"drawing invocation has no -draw: {' '.join(argv)}")

    try:
        with Image.open(source) as opened:
            # An overlay is the candidate plus annotations, so the channel layout is
            # the candidate's: drawing happens in RGBA and is folded back afterwards.
            original = opened.convert("RGBA")
            opaque = not has_alpha(opened)
        canvas = original.copy()
        pen = ImageDraw.Draw(canvas)
        for paint, payload in draws:
            try:
                primitives = split_primitives(payload)
            except ValueError as exc:
                return _error(str(exc))
            for verb, geometry in primitives:
                problem = _paint_primitive(pen, verb, geometry, paint)
                if problem is not None:
                    return _error(problem)
        canvas.convert("RGB" if opaque else "RGBA").save(output, format="PNG")
    except (OSError, ValueError) as exc:
        return _error(f"cannot draw {output}: {exc}")
    return Result(0, "", "")


def main(argv: list[str]) -> int:
    """CLI entry point, for calling the shim directly rather than by interception."""
    result = invoke(argv)
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    return result.code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
