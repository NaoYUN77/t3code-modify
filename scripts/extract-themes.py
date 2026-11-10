"""Pull T3 Code's built-in app themes out of its client bundle.

The client keeps them as JS objects: `{ id, label, appearance, colors: { token:
value, ... }, variants?: { dark: { token: value } } }`, where each token maps to
a `--app-theme-*` custom property that the app writes onto the root element at
runtime. This reads those objects so the demo can apply a real one.

Usage: python3 -I scripts/extract-themes.py [client-dir] > demo/themes.json
"""
import json
import pathlib
import re
import sys

CLIENT = pathlib.Path.home() / ".t3" / "runtime" / "versions" / "0.1.7" / "client"


def find_palette_file(client):
    for f in sorted((client / "assets").glob("themePalette-*.js")):
        if "app-theme-canvas" in f.read_text():
            return f
    sys.exit(f"no themePalette chunk under {client}/assets")


# `canvas` -> `--app-theme-canvas`: the naming convention the app itself uses.
TOKEN_VAR = {}
IDENT = re.compile(r"[A-Za-z_$][\w$]*")


def app_theme_var(name):
    """`surfaceRaised` -> `--app-theme-surface-raised`, as the bundle spells it."""
    if name not in TOKEN_VAR:
        TOKEN_VAR[name] = "--app-theme-" + re.sub(r"(?<!^)([A-Z])", r"-\1", name).lower()
    return TOKEN_VAR[name]


def read_object(text, start):
    """The `{...}` beginning at `start`, as raw source."""
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    raise ValueError("unbalanced braces")


def read_colors(text, start):
    """`{token: `value`, ...}` -> `{--app-theme-token: value}`."""
    body = read_object(text, start)[1:-1]
    colors = {}
    for m in re.finditer(r"([A-Za-z_$][\w$]*)\s*:\s*`([^`]*)`", body):
        colors[app_theme_var(m.group(1))] = m.group(2)
    return colors


def main():
    client = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else CLIENT
    text = find_palette_file(client).read_text()

    themes = {}
    header = re.compile(r"id\s*:\s*`([^`]+)`\s*,\s*label\s*:\s*`([^`]+)`\s*,\s*appearance\s*:\s*`(light|dark)`")
    for m in header.finditer(text):
        tid, label, appearance = m.groups()
        # Read the whole theme object, not the first `colors:{` after the header:
        # the object is `{id, label, appearance, colors, variants?}`, and a
        # sibling theme's `colors` follows within a few hundred characters, so a
        # forward search silently pairs one theme's header with another's palette.
        body = read_object(text, text.rfind("{", 0, m.start()))
        cm = re.search(r"colors\s*:\s*{", body)
        if not cm:
            continue
        colors = read_colors(body, cm.end() - 1)
        theme = {"id": tid, "label": label, "appearance": appearance, "colors": colors}
        vm = re.search(r"variants\s*:\s*{", body)
        if vm:
            variant = read_object(body, vm.end() - 1)
            theme["variants"] = {}
            for v in re.finditer(r"(light|dark)\s*:\s*{", variant):
                theme["variants"][v.group(1)] = read_colors(variant, v.end() - 1)
        themes[tid] = theme

    json.dump({"themes": themes}, sys.stdout, ensure_ascii=False, indent=1, sort_keys=True)
    print(file=sys.stderr)
    for t in sorted(themes.values(), key=lambda t: t["id"]):
        variants = ", ".join(f"{a}:{len(c)}" for a, c in t.get("variants", {}).items()) or "-"
        print(f"  {t['id']:8} {t['appearance']:5} colors={len(t['colors']):3}  variants={variants}", file=sys.stderr)


if __name__ == "__main__":
    main()
