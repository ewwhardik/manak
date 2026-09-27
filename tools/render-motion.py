"""Reproducible local 3D artwork. Optional authoring dependencies: numpy, Pillow, OpenCV.
No runtime dependency, remote asset or generative-service dependency.
"""
from pathlib import Path
import math
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
import cv2

OUT = Path(__file__).resolve().parents[1] / 'src' / 'view' / 'assets'
OUT.mkdir(exist_ok=True)
W, H, S = 800, 680, 1.5
ww, hh = int(W*S), int(H*S)
t = np.linspace(0, 2*np.pi, 321)
centers = np.stack(((2+.55*np.cos(3*t))*np.cos(2*t), (2+.55*np.cos(3*t))*np.sin(2*t), .85*np.sin(3*t)), axis=-1)
tangent = np.gradient(centers, axis=0)
tangent /= np.linalg.norm(tangent, axis=1)[:, None]
normal = np.cross(tangent, np.array([0., 0., 1.]))
normal /= np.linalg.norm(normal, axis=1)[:, None]
binormal = np.cross(tangent, normal)
v = np.linspace(0, 2*np.pi, 65)
normals = np.cos(v)[None,:,None]*normal[:,None,:] + np.sin(v)[None,:,None]*binormal[:,None,:]
mesh = centers[:,None,:] + .32*normals
light = np.array([-0.5, -0.8, 1.4]); light /= np.linalg.norm(light)
yy, xx = np.mgrid[0:hh, 0:ww]
glow = np.exp(-(((xx-ww*.51)/(ww*.36))**2 + ((yy-hh*.44)/(hh*.4))**2))
bg = np.zeros((hh,ww,3), dtype=np.uint8)
for k, base in enumerate([18,23,20]): bg[:,:,k] = base + glow*[13,19,8][k]
frames = []
video = cv2.VideoWriter(str(OUT/'judging-orbit.webm'), cv2.VideoWriter_fourcc(*'VP80'), 20, (W,H))
for frame in range(80):
    angle = 2*np.pi*frame/80
    ca, sa = math.cos(angle), math.sin(angle)
    tilt = .85
    ry = np.array([[ca,0,sa],[0,1,0],[-sa,0,ca]])
    rx = np.array([[1,0,0],[0,math.cos(tilt),-math.sin(tilt)],[0,math.sin(tilt),math.cos(tilt)]])
    rotation = rx@ry
    points = mesh@rotation.T
    ns = normals@rotation.T
    perspective = 8/(8-points[:,:,2])
    screen = points[:,:,:2]*perspective[:,:,None]*88*S
    screen[:,:,0] += ww/2; screen[:,:,1] += hh*.46
    img = Image.fromarray(bg.copy())
    shadow = Image.new('RGBA', (ww,hh))
    ImageDraw.Draw(shadow).ellipse((ww*.23,hh*.79,ww*.78,hh*.87), fill=(0,0,0,160))
    img = Image.alpha_composite(img.convert('RGBA'),shadow.filter(ImageFilter.GaussianBlur(24))).convert('RGB')
    draw = ImageDraw.Draw(img)
    quads = []
    for i in range(320):
        for j in range(64):
            corners = [(i,j),(i+1,j),(i+1,j+1),(i,j+1)]
            z = sum(points[a,b,2] for a,b in corners)/4
            n = sum(ns[a,b] for a,b in corners)/4; n /= np.linalg.norm(n)
            diffuse = max(0, n@light)
            half = light + np.array([0,0,1]); half /= np.linalg.norm(half)
            spec = max(0,n@half)**45
            rim = (1-abs(n[2]))**3
            color = np.clip(np.array([173,214,117])*(.24+.74*diffuse) + spec*150 + rim*np.array([25,36,20]),0,255).astype(int)
            quads.append((z,[tuple(screen[a,b]) for a,b in corners],tuple(color)))
    for _, polygon, color in sorted(quads, key=lambda q:q[0]): draw.polygon(polygon, fill=color)
    img = img.resize((W,H),Image.Resampling.LANCZOS)
    if frame == 0: img.save(OUT/'judging-orbit.webp', quality=90)
    if video.isOpened(): video.write(cv2.cvtColor(np.array(img),cv2.COLOR_RGB2BGR))
    if frame % 2 == 0: frames.append(img.resize((640,544),Image.Resampling.LANCZOS))
video.release()
frames[0].save(OUT/'judging-orbit.gif',save_all=True,append_images=frames[1:],duration=100,loop=0,optimize=True)
print([(p.name,p.stat().st_size) for p in OUT.iterdir()])
