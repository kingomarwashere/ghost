#!/usr/bin/env python3
"""
GHOST — top-down car sprites. 256×256 PNG, 4× supersampled.
Each car type has a distinct silhouette via Catmull-Rom spline body outline.
Architecture:
  1. drop shadow  2. wheel tyres (behind body)  3. body fill  4. hood/trunk panels
  5. cabin roof  6. glass  7. lights  8. panel lines  9. mirrors  10. wheel rims
"""
from PIL import Image, ImageDraw, ImageFilter
import numpy as np
import math, os

OUT   = '/Users/maverick/radar/public/cars'
FINAL = 256
SS    = 4
SZ    = FINAL * SS

os.makedirs(OUT, exist_ok=True)


# ── Colour helpers ─────────────────────────────────────────────────────────────

def h2r(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

def lt(c, f):    return tuple(min(255, int(v + (255-v)*f)) for v in c)
def dk(c, f):    return tuple(max(0,   int(v*(1-f)))       for v in c)
def mix(a, b, t): return tuple(int(a[i]*(1-t) + b[i]*t)   for i in range(3))
def rgba(c, a=255): return c + (a,)

def scanline_gradient(stops, y, h):
    """stops: list of (fraction, rgb). Return rgb for scanline at y/h."""
    t = y / max(h-1, 1)
    for i in range(len(stops)-1):
        f0, c0 = stops[i]
        f1, c1 = stops[i+1]
        if f0 <= t <= f1:
            u = (t - f0) / max(f1 - f0, 1e-9)
            return mix(c0, c1, u)
    return stops[-1][1]


# ── Catmull-Rom spline ─────────────────────────────────────────────────────────

def catmull_rom(pts, n=8):
    """
    Smooth closed polygon through pts using Catmull-Rom.
    pts: list of [x,y]. Returns flat list of (x,y) suitable for draw.polygon.
    """
    pts = np.array(pts, dtype=float)
    N   = len(pts)
    out = []
    for i in range(N):
        p0 = pts[(i-1) % N]
        p1 = pts[i]
        p2 = pts[(i+1) % N]
        p3 = pts[(i+2) % N]
        for k in range(n):
            t  = k / n
            t2 = t*t; t3 = t2*t
            q  = 0.5 * ((2*p1)
                        + (-p0 + p2)*t
                        + (2*p0 - 5*p1 + 4*p2 - p3)*t2
                        + (-p0 + 3*p1 - 3*p2 + p3)*t3)
            out.append((float(q[0]), float(q[1])))
    return out


def scale_pts(pts, s):
    return [(x*s, y*s) for x, y in pts]


# ── Body silhouette control points (256-space, car faces UP = front at top) ───
#
#  Points go clockwise starting from front-centre.
#  Wheel arch positions are included to create subtle bulges.
#
#  Each shape also carries metadata:
#    axle_f / axle_r  — y position of front/rear axle (256-space)
#    whl_r            — tyre outer radius
#    rim_r            — alloy rim radius
#    cx               — horizontal centre
#    hood_end         — y where hood ends (windshield starts)
#    trunk_start      — y where trunk starts (rear window ends)
#    ws               — windshield rect (x,y,w,h)
#    rw               — rear window rect (x,y,w,h)
#    cab              — cabin roof rect (x,y,w,h)
#    mirror_y         — y of side mirrors
#    glass            — glass base colour override or None

SHAPES = {

'sports': dict(
    # Ferrari / Porsche — long narrow nose, wide rear haunches
    body=[
        [128, 24],                    # front tip
        [104, 34], [84, 48],          # left nose
        [70,  70], [64, 90],          # left wheel arch F
        [64, 108], [66, 128],         # left cabin pinch
        [66, 150], [68, 170],         # left wheel arch R
        [76, 196], [90, 214],         # left tail
        [128, 222],                   # rear centre
        [166, 214], [180, 196],       # right tail
        [188, 170], [190, 150],       # right wheel arch R
        [190, 128], [192, 108],       # right cabin pinch
        [192, 90],  [186, 70],        # right wheel arch F
        [172, 48],  [152, 34],        # right nose
    ],
    axle_f=82, axle_r=172, whl_r=22, rim_r=12,
    cx=128,
    hood_end=76, trunk_start=178,
    ws=(88, 78, 80, 30), rw=(90, 170, 76, 24),
    cab=(80, 114, 96, 58),
    mirror_y=96,
),

'hypercar': dict(
    # McLaren / Bugatti — extremely wide front splitter, teardrop cabin, long rear diffuser
    body=[
        [128, 20],
        [100, 30], [76, 44],
        [58,  64], [52, 88],
        [54, 110], [56, 132],
        [58, 154], [64, 176],
        [78, 200], [96, 216],
        [128, 224],
        [160, 216], [178, 200],
        [192, 176], [198, 154],
        [200, 132], [202, 110],
        [204,  88], [198,  64],
        [180,  44], [156,  30],
    ],
    axle_f=78, axle_r=170, whl_r=24, rim_r=13,
    cx=128,
    hood_end=72, trunk_start=174,
    ws=(80, 74, 96, 28), rw=(82, 166, 92, 22),
    cab=(74, 108, 108, 60),
    mirror_y=92,
),

'coupe': dict(
    # BMW M4 / Aston Martin — classic long bonnet fastback
    body=[
        [128, 26],
        [108, 36], [90, 50],
        [76,  74], [72, 96],
        [72, 118], [74, 140],
        [72, 162], [74, 184],
        [82, 208], [98, 218],
        [128, 226],
        [158, 218], [174, 208],
        [182, 184], [184, 162],
        [182, 140], [184, 118],
        [184,  96], [180,  74],
        [166,  50], [148,  36],
    ],
    axle_f=88, axle_r=176, whl_r=22, rim_r=12,
    cx=128,
    hood_end=82, trunk_start=180,
    ws=(86, 84, 84, 30), rw=(88, 172, 80, 26),
    cab=(80, 116, 96, 62),
    mirror_y=100,
),

'muscle': dict(
    # Challenger / Mustang — very wide, boxy, almost rectangular
    body=[
        [128, 28],
        [106, 36], [86, 50],
        [68,  72], [60, 96],
        [58, 118], [60, 140],
        [58, 164], [60, 184],
        [68, 210], [86, 222],
        [128, 228],
        [170, 222], [188, 210],
        [196, 184], [198, 164],
        [196, 140], [198, 118],
        [196,  96], [188,  72],
        [170,  50], [150,  36],
    ],
    axle_f=86, axle_r=180, whl_r=26, rim_r=14,
    cx=128,
    hood_end=80, trunk_start=184,
    ws=(78, 82, 100, 32), rw=(80, 176, 96, 28),
    cab=(68, 116, 120, 68),
    mirror_y=98,
),

'sedan': dict(
    # Rolls-Royce / Bentley — upright, wide cabin, long rear deck
    body=[
        [128, 28],
        [110, 38], [94, 52],
        [82,  74], [78, 98],
        [78, 120], [80, 142],
        [78, 166], [80, 188],
        [88, 212], [104, 222],
        [128, 228],
        [152, 222], [168, 212],
        [176, 188], [178, 166],
        [176, 142], [178, 120],
        [178,  98], [174,  74],
        [162,  52], [146,  38],
    ],
    axle_f=90, axle_r=182, whl_r=22, rim_r=12,
    cx=128,
    hood_end=84, trunk_start=186,
    ws=(88, 86, 80, 32), rw=(90, 178, 76, 26),
    cab=(82, 120, 92, 64),
    mirror_y=100,
),

'suv': dict(
    # Range Rover / Urus — tall wide body, squared off everywhere
    body=[
        [128, 22],
        [104, 30], [82, 44],
        [62,  66], [52, 92],
        [50, 118], [52, 142],
        [50, 168], [52, 190],
        [62, 214], [82, 226],
        [128, 232],
        [174, 226], [194, 214],
        [204, 190], [206, 168],
        [204, 142], [206, 118],
        [204,  92], [194,  66],
        [174,  44], [152,  30],
    ],
    axle_f=84, axle_r=178, whl_r=28, rim_r=16,
    cx=128,
    hood_end=76, trunk_start=182,
    ws=(72, 78, 112, 36), rw=(74, 174, 108, 30),
    cab=(62, 116, 132, 68),
    mirror_y=96,
),

'truck': dict(
    # Ford Raptor / Cybertruck — wide cab + long flat bed, tall
    body=[
        [128, 20],
        [100, 28], [76, 40],
        [54,  60], [46, 84],
        [44, 108], [46, 132],
        [48, 152], [50, 170],   # cab transitions to bed
        [50, 192], [52, 210],
        [66, 224], [86, 230],
        [128, 234],
        [170, 230], [190, 224],
        [204, 210], [206, 192],
        [206, 170], [208, 152],
        [210, 132], [212, 108],
        [210,  84], [202,  60],
        [180,  40], [156,  28],
    ],
    axle_f=78, axle_r=194, whl_r=28, rim_r=16,
    cx=128,
    hood_end=68, trunk_start=162,
    ws=(62, 70, 132, 36), rw=(64, 154, 128, 28),
    cab=(52, 108, 152, 52),
    mirror_y=86,
),

'offroad': dict(
    # Wrangler — very boxy, upright, big wheel arches
    body=[
        [128, 24],
        [100, 32], [76, 46],
        [54,  70], [44, 96],
        [42, 122], [44, 148],
        [42, 174], [44, 198],
        [58, 220], [82, 230],
        [128, 236],
        [174, 230], [198, 220],
        [212, 198], [214, 174],
        [212, 148], [214, 122],
        [212,  96], [202,  70],
        [180,  46], [156,  32],
    ],
    axle_f=90, axle_r=186, whl_r=30, rim_r=17,
    cx=128,
    hood_end=78, trunk_start=190,
    ws=(62, 80, 132, 36), rw=(64, 182, 128, 30),
    cab=(52, 118, 152, 72),
    mirror_y=98,
),

}


# ── Wheel drawing ──────────────────────────────────────────────────────────────

def draw_wheel(img_draw, cx, cy, wr, rr, tyre_col=(18,18,18)):
    # Tyre (dark rubber)
    img_draw.ellipse([cx-wr, cy-wr, cx+wr, cy+wr], fill=rgba(tyre_col))
    # Sidewall highlight
    img_draw.ellipse([cx-wr+3, cy-wr+2, cx+wr-2, cy+wr-4],
                     fill=(60, 60, 60, 40))

def draw_rim(img_draw, cx, cy, rr):
    # Alloy background
    img_draw.ellipse([cx-rr, cy-rr, cx+rr, cy+rr], fill=(158, 158, 166, 255))
    # 5 spokes
    for i in range(5):
        ang = math.radians(i*72 + 18)
        ex  = cx + rr*0.82*math.cos(ang)
        ey  = cy + rr*0.82*math.sin(ang)
        img_draw.line([(cx,cy),(ex,ey)], fill=(88,88,98,255), width=max(3, rr//5))
    # Rim ring
    img_draw.ellipse([cx-rr, cy-rr, cx+rr, cy+rr],
                     outline=(120,120,130,255), width=max(2, rr//6))
    # Hub cap
    hc = max(4, rr//3)
    img_draw.ellipse([cx-hc, cy-hc, cx+hc, cy+hc], fill=(215,215,222,255))
    img_draw.ellipse([cx-hc//2, cy-hc//2, cx+hc//2, cy+hc//2],
                     fill=(140,140,150,255))


# ── Body fill with scanline gradient ──────────────────────────────────────────

def fill_polygon_gradient(img, poly_pts_ss, P, bounding_box):
    """
    Fill a polygon with a vertical scanline gradient.
    poly_pts_ss: scaled polygon points in SS space.
    """
    bx, by, bw, bh = bounding_box
    PH  = lt(P, 0.50)
    PH2 = lt(P, 0.28)
    PM  = P
    PS  = dk(P, 0.22)
    PD  = dk(P, 0.44)

    stops = [(0.0, PH), (0.12, PH2), (0.38, PM), (0.65, PS), (1.0, PD)]

    # Build gradient image
    grad = Image.new('RGBA', (SZ, SZ), (0,0,0,0))
    gd   = ImageDraw.Draw(grad)
    for dy in range(bh):
        c = scanline_gradient(stops, dy, bh)
        gd.line([bx, by+dy, bx+bw, by+dy], fill=rgba(c))

    # Clip gradient to body polygon mask
    mask = Image.new('L', (SZ, SZ), 0)
    md   = ImageDraw.Draw(mask)
    md.polygon(poly_pts_ss, fill=255)

    grad_masked = Image.new('RGBA', (SZ, SZ), (0,0,0,0))
    grad_masked.paste(grad, mask=mask)
    img.alpha_composite(grad_masked)


# ── Main car builder ───────────────────────────────────────────────────────────

def build_car(style_key, paint_hex):
    sp = SHAPES[style_key]
    P  = h2r(paint_hex)
    S  = SS

    img  = Image.new('RGBA', (SZ, SZ), (0,0,0,0))
    draw = ImageDraw.Draw(img)

    def sc(v): return v * S
    def scp(pts): return scale_pts(pts, S)

    # Smooth body outline
    body_ctrl  = sp['body']
    body_smooth = catmull_rom(body_ctrl, n=10)
    body_ss    = scp(body_smooth)

    # Bounding box of body for gradient
    xs = [p[0] for p in body_ss]; ys = [p[1] for p in body_ss]
    bx = int(min(xs)); bw = int(max(xs) - bx)
    by = int(min(ys)); bh = int(max(ys) - by)

    # Wheel positions (SS space)
    cx_  = sc(sp['cx'])
    half = (max(xs) - min(xs)) / 2
    afy  = sc(sp['axle_f'])
    ary  = sc(sp['axle_r'])
    # Wheel x: at body edge (left body edge and right body edge at axle y)
    # Find body edge at axle y by scanning body polygon
    def body_edge_x(target_y):
        """Return (left_x, right_x) at target_y by scanning the polygon."""
        pts = body_ss
        N   = len(pts)
        xs_at = []
        for i in range(N):
            x0,y0 = pts[i]; x1,y1 = pts[(i+1)%N]
            if (y0 <= target_y < y1) or (y1 <= target_y < y0):
                t = (target_y - y0) / (y1 - y0) if y1 != y0 else 0
                xs_at.append(x0 + t*(x1-x0))
        xs_at.sort()
        if len(xs_at) >= 2:
            return xs_at[0], xs_at[-1]
        return cx_ - sc(sp['whl_r']+8), cx_ + sc(sp['whl_r']+8)

    lx_f, rx_f = body_edge_x(afy)
    lx_r, rx_r = body_edge_x(ary)
    wr = sc(sp['whl_r'])
    rr = sc(sp['rim_r'])

    wheels = [
        (lx_f, afy),   # FL
        (rx_f, afy),   # FR
        (lx_r, ary),   # RL
        (rx_r, ary),   # RR
    ]

    # ── 1. Drop shadow ────────────────────────────────────────────────────────
    sh = Image.new('RGBA', (SZ, SZ), (0,0,0,0))
    sd = ImageDraw.Draw(sh)
    sd.polygon(body_ss, fill=(0,0,0,100))
    sh = sh.filter(ImageFilter.GaussianBlur(sc(10)))
    sh_offset = Image.new('RGBA', (SZ, SZ), (0,0,0,0))
    sh_offset.paste(sh, (int(sc(4)), int(sc(5))))
    img.alpha_composite(sh_offset)
    draw = ImageDraw.Draw(img)

    # ── 2. Wheel tyres (drawn before body so body covers inner half) ──────────
    for wx,wy in wheels:
        draw_wheel(draw, wx, wy, wr, rr)

    # ── 3. Body outline border (slightly expanded dark) ───────────────────────
    POL = dk(P, 0.68)
    border_poly = [(x + math.copysign(S*1.5, x - cx_),
                    y + math.copysign(S*1.5, y - (by + bh/2)))
                   for x,y in body_ss]
    draw.polygon(border_poly, fill=rgba(POL))

    # ── 4. Body gradient fill ─────────────────────────────────────────────────
    fill_polygon_gradient(img, body_ss, P, (bx, by, bw, bh))
    draw = ImageDraw.Draw(img)

    # ── 5. Hood panel (front section, very slightly darker/lighter) ───────────
    hood_y  = sc(sp['hood_end'])
    PHD     = dk(P, 0.06) if sum(P) > 80 else lt(P, 0.06)
    hood_layer = Image.new('RGBA', (SZ, SZ), (0,0,0,0))
    hl_d = ImageDraw.Draw(hood_layer)
    # Only fill the upper portion using a horizontal band clipped to body
    hl_d.rectangle([0, 0, SZ, int(hood_y)], fill=rgba(PHD, 70))
    hood_mask = Image.new('L', (SZ, SZ), 0)
    hm_d = ImageDraw.Draw(hood_mask)
    hm_d.polygon(body_ss, fill=255)
    hood_clipped = Image.new('RGBA', (SZ, SZ), (0,0,0,0))
    hood_clipped.paste(hood_layer, mask=hood_mask)
    img.alpha_composite(hood_clipped)

    # Trunk panel (rear section)
    trunk_y = sc(sp['trunk_start'])
    trunk_layer = Image.new('RGBA', (SZ, SZ), (0,0,0,0))
    tl_d = ImageDraw.Draw(trunk_layer)
    tl_d.rectangle([0, int(trunk_y), SZ, SZ], fill=rgba(PHD, 70))
    trunk_clipped = Image.new('RGBA', (SZ, SZ), (0,0,0,0))
    trunk_clipped.paste(trunk_layer, mask=hood_mask)
    img.alpha_composite(trunk_clipped)
    draw = ImageDraw.Draw(img)

    # ── 6. Cabin roof panel ───────────────────────────────────────────────────
    cx_s, cy_s, cw_s, ch_s = [sc(v) for v in sp['cab']]
    cab_c = lt(P, 0.08) if sum(P) > 60 else dk(P, 0.04)
    draw.rounded_rectangle([cx_s, cy_s, cx_s+cw_s, cy_s+ch_s],
                            radius=sc(10), fill=rgba(cab_c))

    # ── 7. Cabin roof highlight streak ────────────────────────────────────────
    streak = Image.new('RGBA', (SZ, SZ), (0,0,0,0))
    sr     = ImageDraw.Draw(streak)
    mid_x  = cx_s + cw_s*0.5
    sr.polygon([
        (mid_x - sc(28), cy_s + sc(4)),
        (mid_x + sc(4),  cy_s + sc(4)),
        (mid_x - sc(12), cy_s + ch_s - sc(6)),
        (mid_x - sc(46), cy_s + ch_s - sc(6)),
    ], fill=(255,255,255,48))
    streak = streak.filter(ImageFilter.GaussianBlur(sc(5)))
    img.alpha_composite(streak)
    draw = ImageDraw.Draw(img)

    # ── 8. Windshield ─────────────────────────────────────────────────────────
    glass = (105, 172, 218)
    glass_hi = lt(glass, 0.40)
    wx_s, wy_s, ww_s, wh_s = [sc(v) for v in sp['ws']]
    # Dark surround
    draw.rounded_rectangle([wx_s-sc(4), wy_s-sc(4),
                             wx_s+ww_s+sc(4), wy_s+wh_s+sc(4)],
                            radius=sc(8), fill=rgba(dk(P, 0.76)))
    # Glass
    draw.rounded_rectangle([wx_s, wy_s, wx_s+ww_s, wy_s+wh_s],
                            radius=sc(8), fill=rgba(glass, 210))
    # Reflection
    draw.rounded_rectangle([wx_s+sc(7), wy_s+sc(4),
                             wx_s+ww_s*0.48, wy_s+wh_s-sc(5)],
                            radius=sc(5), fill=rgba(glass_hi, 90))

    # ── 9. Rear window ────────────────────────────────────────────────────────
    rw_x_s, rw_y_s, rw_w_s, rw_h_s = [sc(v) for v in sp['rw']]
    draw.rounded_rectangle([rw_x_s-sc(4), rw_y_s-sc(4),
                             rw_x_s+rw_w_s+sc(4), rw_y_s+rw_h_s+sc(4)],
                            radius=sc(8), fill=rgba(dk(P, 0.76)))
    draw.rounded_rectangle([rw_x_s, rw_y_s, rw_x_s+rw_w_s, rw_y_s+rw_h_s],
                            radius=sc(8), fill=rgba(dk(glass, 0.10), 190))
    draw.rounded_rectangle([rw_x_s+sc(7), rw_y_s+sc(4),
                             rw_x_s+rw_w_s*0.48, rw_y_s+rw_h_s-sc(5)],
                            radius=sc(5), fill=rgba(glass_hi, 60))

    # ── 10. Headlights (front) ────────────────────────────────────────────────
    hl_h = sc(11); hl_y = sc(sp['body'][0][1]) + sc(8)
    # Find front body width at headlight y
    lx_hl, rx_hl = body_edge_x(hl_y)
    hl_w  = (rx_hl - lx_hl) * 0.30
    hl_r  = sc(4)
    for hx in [lx_hl + sc(6), rx_hl - sc(6) - hl_w]:
        draw.rounded_rectangle([hx, hl_y, hx+hl_w, hl_y+hl_h],
                                radius=hl_r, fill=(255, 252, 215, 245))
        draw.rectangle([hx+sc(4), hl_y+sc(3), hx+hl_w-sc(4), hl_y+hl_h-sc(4)],
                       fill=(255, 240, 140, 150))

    # ── 11. Taillights (rear) ─────────────────────────────────────────────────
    tl_h = sc(10); tl_bot = sc(sp['body'][-1][1] if sp['body'][-1][0] == 128
                                else max(p[1] for p in sp['body'])) - sc(8)
    tl_y = tl_bot - tl_h
    lx_tl, rx_tl = body_edge_x(tl_y)
    tl_w = (rx_tl - lx_tl) * 0.28
    for tx in [lx_tl + sc(6), rx_tl - sc(6) - tl_w]:
        draw.rounded_rectangle([tx, tl_y, tx+tl_w, tl_y+tl_h],
                                radius=sc(4), fill=(210, 12, 12, 235))
        draw.rectangle([tx+sc(4), tl_y+sc(3), tx+tl_w-sc(4), tl_y+tl_h-sc(4)],
                       fill=(255, 38, 38, 145))

    # ── 12. Grille ────────────────────────────────────────────────────────────
    lx_hl2, rx_hl2 = body_edge_x(hl_y + hl_h + sc(4))
    gr_total = rx_hl2 - lx_hl2
    gr_w = gr_total * 0.36; gr_h = sc(12)
    gr_x = lx_hl2 + (gr_total - gr_w) / 2
    gr_y = hl_y + hl_h + sc(3)
    draw.rounded_rectangle([gr_x, gr_y, gr_x+gr_w, gr_y+gr_h],
                            radius=sc(4), fill=rgba(dk(P, 0.72)))
    for i in range(3):
        gy = gr_y + sc(2.5) + i*sc(3.5)
        draw.line([(gr_x+sc(5), gy), (gr_x+gr_w-sc(5), gy)],
                  fill=rgba(dk(P, 0.50)), width=max(1, int(sc(0.8))))

    # ── 13. Door divider line ─────────────────────────────────────────────────
    mid_y = cy_s + ch_s / 2
    lx_mid, rx_mid = body_edge_x(mid_y)
    draw.line([(lx_mid + sc(4), mid_y), (rx_mid - sc(4), mid_y)],
              fill=rgba(dk(P, 0.30)), width=max(1, int(sc(0.8))))

    # ── 14. Side mirrors ──────────────────────────────────────────────────────
    mir_y = sc(sp['mirror_y'])
    lx_m, rx_m = body_edge_x(mir_y)
    mir_w = sc(7); mir_h = sc(10); mir_col = rgba(dk(P, 0.20))
    # Left mirror (sticks outward left)
    draw.rounded_rectangle([lx_m - mir_w - sc(1), mir_y - mir_h//2,
                             lx_m - sc(1),          mir_y + mir_h//2],
                            radius=sc(3), fill=mir_col)
    # Right mirror
    draw.rounded_rectangle([rx_m + sc(1),           mir_y - mir_h//2,
                             rx_m + mir_w + sc(1),   mir_y + mir_h//2],
                            radius=sc(3), fill=mir_col)

    # ── 15. Body outline redraw (crisp border) ────────────────────────────────
    draw.polygon(body_ss, fill=None, outline=rgba(dk(P, 0.62)), width=int(sc(2.5)))

    # ── 16. Wheel rims (drawn after body so only outer portion shows) ─────────
    draw = ImageDraw.Draw(img)
    for wx,wy in wheels:
        draw_rim(draw, wx, wy, rr)

    # ── Downsample 4× ─────────────────────────────────────────────────────────
    return img.resize((FINAL, FINAL), Image.LANCZOS)


# ── Car list ───────────────────────────────────────────────────────────────────

CARS = [
    ('ferrari488',    '#cc1200', 'sports'),
    ('lambohuracan',  '#d4a800', 'hypercar'),
    ('mclaren720',    '#e04800', 'hypercar'),
    ('bugattichiron', '#021878', 'hypercar'),
    ('bmwm4',         '#1438a8', 'sports'),
    ('porsche911',    '#e0e0e0', 'sports'),
    ('amggt',         '#141414', 'sports'),
    ('rangerover',    '#141414', 'suv'),
    ('gtrr35',        '#c0c2cc', 'coupe'),
    ('challenger',    '#111111', 'muscle'),
    ('mustanggt',     '#163818', 'muscle'),
    ('fordraptor',    '#c05800', 'truck'),
    ('astondb11',     '#0e381a', 'coupe'),
    ('cybertruck',    '#cacad2', 'truck'),
    ('wrangler',      '#3c5a1e', 'offroad'),
    ('bentleygtc',    '#1a0a00', 'coupe'),
    ('rollsroyce',    '#f0ede8', 'sedan'),
    ('lambourus',     '#f0f0ee', 'suv'),
]

for fname, paint, style in CARS:
    print(f'{fname}…', end=' ', flush=True)
    img = build_car(style, paint)
    img.save(os.path.join(OUT, f'{fname}.png'), optimize=True)
    print('✓')

print(f'\n{len(CARS)} cars → {OUT}')
