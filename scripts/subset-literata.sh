#!/usr/bin/env bash
# Rebuilds src/assets/fonts/literata-{latin,latin-ext}-wght-normal.woff2
# from upstream Literata (google/fonts), keeping the old-style figures and
# small caps (onum, smcp, c2sc) that fontsource strips. The reader uses
# them for figures in book text and the small-caps first line of a chapter.
#
# A one-off tool, not part of the build: the output files are committed and
# CI doesn't run this. It needs fonttools with brotli for Python
# (`apt install fonttools python3-brotli`, or `pip install fonttools[woff]`
# in a venv). Run from the repo root; PYTHON picks the interpreter:
#
#   PYTHON=~/venvs/fonttools/bin/python scripts/subset-literata.sh

set -euo pipefail

PYTHON="${PYTHON:-python3}"
# google/fonts at "Literata: Version 3.103", the version fontsource bundled.
COMMIT=c8018e986708f2aed63c928b1e9026826da1553d
URL="https://raw.githubusercontent.com/google/fonts/$COMMIT/ofl/literata/Literata%5Bopsz,wght%5D.ttf"
OUT=src/assets/fonts

# Copied from the Literata @font-face rules in src/fonts.css; keep them in
# step. The latin range leaves out U+0304 (fonts.css says why).
LATIN="U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0308,U+0329,\
U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD"
LATIN_EXT="U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,\
U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,\
U+A720-A7FF"

if [ ! -d "$OUT" ]; then
  echo "run from the repo root" >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

curl -fsSL "$URL" -o "$work/Literata.ttf"

# Pin the optical size at 12, the default, as fontsource did: the bundled
# files have only the weight axis.
"$PYTHON" -m fontTools.varLib.instancer "$work/Literata.ttf" opsz=12 -o "$work/Literata-wght.ttf"

subset() {
  # The GSUB closure brings each letter's small cap along with it, so
  # amacron.sc lands in the latin-ext file with "ā".
  "$PYTHON" -m fontTools.subset "$work/Literata-wght.ttf" \
    --flavor=woff2 \
    --layout-features+=onum,lnum,pnum,tnum,smcp,c2sc \
    --unicodes="$2" \
    --output-file="$OUT/literata-$1-wght-normal.woff2"
}

subset latin "$LATIN"
subset latin-ext "$LATIN_EXT"

ls -l "$OUT"/literata-*.woff2
