"""Vector master for the tile/icon (the "R" in a square).

This is a SOURCE file, on the same footing as rtile.png / wordmark_vector.py
- read by build.py, never hand-edited as an output. It exists because the
tile PNG has no vector original: the artwork was rebuilt from a ~470px
source, and above roughly 500px the raster tile starts to look soft (see
brand/README.txt's former "ONE THING STILL MISSING" note).

Where this came from: rtile.png's TILE_CROP region was decomposed with this
package's own pngkit.decompose() (the same call build.py makes) into its
white-coverage layer - the R glyph, which paint() maps to the surface colour
- isolated as a clean black-on-white bitmap. That bitmap was then traced
with potrace into the path data below, exactly the same technique used for
wordmark_vector.py. Nothing was redrawn: the path is the actual pixels of
the existing artwork, converted to outlines.

The small accent square (the mark's one red square) was NOT traced. Its
red-coverage layer is a clean, sharp-edged, perfectly axis-aligned 70x70
square with no curves - measured directly from the coverage data rather than
approximated by potrace, which is both simpler and truer to the "hard
corners everywhere" design system rule than a traced approximation would be.
TILE_DOT_RECT below is that measurement.

Coordinate space: the path sits in the same 470x470 box as TILE_CROP in
build.py.
"""

TILE_VECTOR_W = 470
TILE_VECTOR_H = 470

# (x, y, w, h), local to the same 470x470 box - measured from the red
# coverage layer's bounding box, not traced.
TILE_DOT_RECT = (352, 338, 70, 70)

TILE_R_PATH = (
    "M 49.487 65.184 C 49.212 65.908, 49.102 143.225, 49.243 237 L 49.500 "
    "407.500 87.742 407.762 L 125.984 408.024 126.242 349.262 L 126.500 "
    "290.500 156.523 290.236 L 186.547 289.971 214.508 339.736 C 229.887 "
    "367.106, 244.796 393.550, 247.638 398.500 L 252.807 407.500 294.903 "
    "407.761 C 318.056 407.904, 337 407.657, 337 407.211 C 337 406.765, "
    "336.585 405.973, 336.077 405.450 C 335.570 404.928, 327.094 390.550, "
    "317.241 373.500 C 299.017 341.964, 282.848 314.087, 270.274 292.522 "
    "L 263.290 280.545 274.895 274.838 C 314.901 255.167, 336.101 220.964, "
    "336.123 176.057 C 336.136 150.329, 330.908 130.529, 319.408 112.751 "
    "C 303.336 87.907, 277.590 72.878, 239.949 66.367 C 231.820 64.961, "
    "217.889 64.672, 140.244 64.300 C 66.228 63.945, 49.898 64.104, 49.487 "
    "65.184 M 126 178 L 126 224 168.912 224 C 202.695 224, 213.474 223.684, "
    "219.579 222.516 C 244.599 217.729, 259.046 201.280, 258.976 177.661 "
    "C 258.962 173.172, 258.496 167.527, 257.940 165.115 C 255.232 153.367, "
    "246.610 142.799, 235.411 137.501 C 224.648 132.410, 220.278 132.036, "
    "171.250 132.017 L 126 132 126 178"
)
