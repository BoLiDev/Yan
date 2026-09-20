#!/usr/bin/env python3
"""Cut the two woff2 files `yan ui` ships from the installed ChillRoundF.

    python3 templates/ui/fonts/make.py [--from <dir>] [--out <dir>]

`--from` is where ChillRoundFRegular.ttf and ChillRoundFBold.ttf are, and
defaults to ~/Library/Fonts. It prints the checksum of every file it read and
wrote, so what is committed can be traced back to what it came from.

This runs by hand, once, when the face or the character list changes, and
nothing in yan calls it: the subsets are committed, so yan has no subsetter to
install and no build step to run. It needs fontTools and brotli:

    python3 -m pip install 'fonttools>=4.60' brotli

The subset is a Modified Version under the SIL Open Font License, and
'ChillRoundF' is a Reserved Font Name, so the output may not carry that name.
Every name record is rewritten to the family below; OFL.txt and README.md say
the rest.
"""

import argparse
import hashlib
import sys
from pathlib import Path

from fontTools.subset import Options, Subsetter, load_font, parse_unicodes, save_font
from fontTools.ttLib import TTFont

HERE = Path(__file__).resolve().parent

# The family the page's @font-face declares. Not a claim about a real installed
# font: it names these two files and nothing else.
FAMILY = 'Yan Round'
POSTSCRIPT = 'YanRound'

# Regular first, so a failure on the Bold still leaves a readable pair.
WEIGHTS = [
    # style, source file, output file, usWeightClass
    ('Regular', 'ChillRoundFRegular.ttf', 'yan-round-regular.woff2', 400),
    ('Bold', 'ChillRoundFBold.ttf', 'yan-round-bold.woff2', 700),
]

# Everything the page's own layout asks of the font. `tnum` is the one that
# would be missed: the report sets font-variant-numeric: tabular-nums, and
# pyftsubset keeps only the features that are on by default without this list.
LAYOUT_FEATURES = [
    'calt', 'ccmp', 'liga', 'locl', 'kern', 'mark', 'mkmk', 'rclt', 'rlig',
    'case', 'tnum', 'pnum', 'frac', 'numr', 'dnom', 'sups', 'subs', 'ordn',
    'fwid', 'hwid', 'pwid',
]

# Vertical writing and the (now meaningless) signature. The page is horizontal.
DROP_TABLES = ['DSIG', 'vhea', 'vmtx', 'VORG']

# Windows / Unicode BMP / English, the only platform pyftsubset leaves behind.
PLATFORM = (3, 1, 0x409)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def codepoints() -> list[int]:
    """The subset, read from subset-unicodes.txt exactly as pyftsubset reads it."""
    unicodes: list[int] = []
    for line in (HERE / 'subset-unicodes.txt').read_text(encoding='utf-8').splitlines():
        unicodes.extend(parse_unicodes(line.split('#')[0]))
    return unicodes


def rename(font: TTFont, style: str, source_version: str) -> None:
    """Give the subset its own name, and keep the notices the licence requires.

    Clause 3 of the OFL forbids a Modified Version from using a Reserved Font
    Name, so nothing here may say ChillRoundF or 寒蝉全圆体 in a *name* field.
    Clause 1 requires the copyright notice and the licence to travel with it,
    so IDs 0, 13 and 14 are kept exactly as the face carries them, and ID 10
    records what this was cut from — a description, not a name.
    """
    names = font['name']
    # Drop every record, including the Chinese (langID 0x804) ones that still
    # read 寒蝉全圆体, then write the few that are true of the subset.
    names.names = [r for r in names.names if r.nameID in (0, 13, 14)
                   and (r.platformID, r.platEncID, r.langID) == PLATFORM]
    full = FAMILY if style == 'Regular' else f'{FAMILY} {style}'
    written = {
        1: FAMILY,
        2: style,
        3: f'{source_version};YANR;{POSTSCRIPT}-{style}',
        4: full,
        5: f'Version {source_version}; subset',
        6: f'{POSTSCRIPT}-{style}',
        10: (
            f'A subset of ChillRoundF {source_version} by ChillType, cut to the characters '
            f"yan's work report draws (templates/ui/fonts/subset-unicodes.txt). Renamed "
            f'because ChillRoundF is a Reserved Font Name under the SIL Open Font License, '
            f'which a modified version may not use.'
        ),
    }
    for name_id, value in written.items():
        names.setName(value, name_id, *PLATFORM)


def cut(src: Path, dest: Path, style: str, weight: int, unicodes: list[int]) -> None:
    options = Options()
    options.flavor = 'woff2'
    options.layout_features = LAYOUT_FEATURES
    options.drop_tables += DROP_TABLES
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 10, 13, 14]
    options.name_legacy = False
    options.notdef_outline = True          # a box, not a blank, for a glyph outside the subset
    options.recalc_bounds = True
    options.recalc_average_width = True
    options.ignore_missing_unicodes = True

    font = load_font(str(src), options)
    source_version = font['name'].getDebugName(5) or 'Version ?'
    source_version = source_version.replace('Version ', '')
    subsetter = Subsetter(options=options)
    subsetter.populate(unicodes=unicodes)
    subsetter.subset(font)

    rename(font, style, source_version)
    # The Bold file declares itself Regular — the same lie that makes the page
    # name both installed files by their PostScript names. Fix it here, so the
    # shipped pair is an ordinary two-style family.
    bold = weight >= 600
    font['OS/2'].usWeightClass = weight
    font['OS/2'].fsSelection = (font['OS/2'].fsSelection & ~0x60) | (0x20 if bold else 0x40)
    font['head'].macStyle = (font['head'].macStyle & ~0x01) | (0x01 if bold else 0x00)

    save_font(font, str(dest), options)
    font.close()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--from', dest='src', default=str(Path.home() / 'Library' / 'Fonts'),
                    help='where the two ChillRoundF .ttf files are')
    ap.add_argument('--out', dest='out', default=str(HERE),
                    help='where to write the woff2 files')
    args = ap.parse_args()

    src_dir, out_dir = Path(args.src).expanduser(), Path(args.out).expanduser()
    unicodes = codepoints()
    print(f'{len(set(unicodes))} codepoints from subset-unicodes.txt')

    for style, src_name, out_name, weight in WEIGHTS:
        src, dest = src_dir / src_name, out_dir / out_name
        if not src.is_file():
            print(f'not found: {src}', file=sys.stderr)
            return 1
        print(f'\n{src}\n  {src.stat().st_size:>9,} bytes  sha256 {sha256(src)}')
        cut(src, dest, style, weight, unicodes)
        cut_font = TTFont(dest)
        print(f'{dest}\n  {dest.stat().st_size:>9,} bytes  sha256 {sha256(dest)}'
              f'\n  {cut_font["maxp"].numGlyphs} glyphs, {len(cut_font.getBestCmap())} mapped, '
              f'family {cut_font["name"].getDebugName(1)!r}, '
              f'weight {cut_font["OS/2"].usWeightClass}')
        cut_font.close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
