# The face the work report is drawn in

`yan ui` writes one offline page and puts these two files next to it, so anyone
who has yan installed sees the report in the face it was designed for without
installing a font. The page's `@font-face` names an installed copy first and
these files second, so a reader who already has ChillRoundF keeps using theirs,
and either way the page fetches nothing from the network.

| | |
| --- | --- |
| Face | ChillRoundF 3.200 (寒蝉全圆体), by ChillType — [Warren2060/ChillRound](https://github.com/Warren2060/ChillRound) |
| Licence | SIL Open Font License 1.1, `OFL.txt` beside this file |
| Shipped as | `yan-round-regular.woff2` 737,008 bytes · `yan-round-bold.woff2` 804,580 bytes |
| Cut from | `~/Library/Fonts/ChillRoundFRegular.ttf` 6,205,268 bytes, sha256 `7ccfc2cd0e971edeac7f65516df8db379f0f84d0d8ff79ee4dfe377956418d3b` |
| | `~/Library/Fonts/ChillRoundFBold.ttf` 7,004,128 bytes, sha256 `f2c4f9295d9d04a1eb6392ae3c51ecf2a9ffab355a45c6686eeec5eede3381ec` |
| Cut with | fontTools 4.60.2, brotli, Python 3.9.6, on 2026-09-19 |

The whole files are 5.9 and 6.7 MB, too heavy to keep in git; as a subset they
are 0.7 and 0.8 MB, which is why the subset exists.

## What is in them

5,722 codepoints asked for, 4,879 of them present in the face, 5,076 glyphs.
`subset-unicodes.txt` is the definition, commented range by range — printable
ASCII and European Latin, the punctuation and arrows a report draws, CJK
punctuation and the full-width forms, hiragana and katakana, and level 1 of
GB 2312-80: the 3,755 hanzi of everyday written Chinese.

**A character outside that list falls back on its own**, to the next family in
the page's stack, for that character only — the rest of the line stays in this
face. That is ordinary browser behaviour, not a special case, and it is why a
missing glyph costs a mismatched character rather than a broken page. Level 2 of
GB 2312 (3,008 rarer hanzi, `冥` among them) is *not* in the subset; adding it
would roughly double both files. Nothing in yan's own vault needs it today: the
25 CJK characters the real report draws are all inside the subset.

The layout features the page asks of the font are kept, `tnum` above all — the
report sets `font-variant-numeric: tabular-nums`, and a subsetter keeps only the
default-on features unless told otherwise. Vertical writing (`vhea`, `vmtx`,
`vert`, `vkna`) and the now-meaningless `DSIG` are dropped.

## The name, and why it is not ChillRoundF

ChillType declares `'ChillRoundF'` and `'ChillRoundM'` as Reserved Font Names
(the first line of `OFL.txt`; the font's own name table does not say so, the
upstream `LICENSE` does). A subset is a Modified Version, and clause 3 of the
OFL forbids one from using a Reserved Font Name. So these two files, and the
`@font-face` family in `templates/ui/report.html`, are called **Yan Round**.
That name means these files and nothing else; it is not a typeface anyone
designed and not a claim about anything installed. Name ID 10 in each file
records what it was cut from, which the licence allows — the restriction is on
the font's *name*, not on saying where it came from.

`local("ChillRoundFRegular")` in the page still uses the real name, because
there it refers to the reader's own unmodified installed copy.

## Remaking them

`make.py` does the whole job — subset, rename, fix the Bold's weight bits, write
woff2 — and prints the checksum of everything it reads and writes:

```sh
python3 -m pip install 'fonttools>=4.60' brotli
python3 templates/ui/fonts/make.py                    # from ~/Library/Fonts
python3 templates/ui/fonts/make.py --from /path/to/ttf
```

It runs by hand, when the face or the character list changes. **yan never runs
it**: the output is committed, so yan has no subsetter in `package.json`, no
build step for the page, and nothing to install beyond yan itself.

The hanzi in `subset-unicodes.txt` are generated, not kept by hand. These four
lines derive them from the standard, so the committed list can be checked rather
than trusted:

```python
lv1 = [bytes([hi, lo]).decode('gb2312') for hi in range(0xB0, 0xD8) for lo in range(0xA1, 0xFF)]
print(len(lv1))                                       # 3755
print(' '.join(f'U+{ord(c):04X}' for c in lv1[:8]))   # U+554A U+963F U+57C3 ...
```

If `make.py` is ever run against a different version of the face, or a different
fontTools, the byte-for-byte output will differ even when nothing visible does.
The table at the top is the record of which inputs produced the files in git.

## Where they end up

`src/cli/ui/fonts.ts` copies `yan-round-regular.woff2`,
`yan-round-bold.woff2` and `OFL.txt` into a `fonts/` directory beside the page
`yan ui` writes — `~/.yan/ui/fonts/` by default, and next to `--out <file>` when
that is given. It rewrites a file only when it is missing or its bytes differ,
so repeated runs touch nothing. `OFL.txt` travels with them because clause 1 of
the licence says the notice goes with every copy of the font.
