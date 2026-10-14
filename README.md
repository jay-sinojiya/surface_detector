# Surface Detector

Standalone frontend: automatic floor perspective from a **Base** cutout + **Demo** grout photo.

## Images (only these)

| File | Role |
|------|------|
| `public/base.png` | Room with transparent floor cutout (alpha) |
| `public/demo.jpg` | Same room with visible floor tiles / grout |

Both must be the same resolution (currently 1024×764).

## How rotation is found

1. Segment the floor from **Base** alpha.
2. On **Demo**, detect dark grout lines inside that floor region.
3. Split lines into **depth** (toward vanishing point) vs **transverse** families.
4. Depth direction → `groutRotationDeg` (yaw vs image vertical) and vanishing point.
5. Build a perspective quad whose sides converge to that VP.
6. Map the tile texture with that homography + optional UV rotation.

## Run

```bash
npm install
npm run dev
```

Open http://127.0.0.1:5173

```bash
npm test
npm run build
```

## UI tips

- **Demo** — original grout reference  
- **Base** — cutout mask  
- **Tiled** — composite result  
- **Grout rotation offset** — fine-tune yaw if auto is slightly off  
- Drag corner handles to correct the quad manually  
# surface_detector
