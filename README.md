# Newton's Cenotaph — 3D reconstruction

A to-scale 3D model of Étienne-Louis Boullée's *Cénotaphe de Newton* (1784), an unbuilt monument known only from his drawings. Built in Blender 5.0 and rendered with Cycles.

**[Walk through it in your browser](https://davisdilanchian.github.io/NewtonsCenotaph/)** (first-person, three.js).

The page and the model's figures read the monument at 3× its published size: a 450 m sphere. That is a choice for the sense of size, not a finding. The drawing's own figures stay closer to 150 m, but 3× is the largest size at which everything stays believable, with the cypresses at a real 30 m. Add `?scale=1`, `?scale=2` or `?scale=5` to the page's address to compare. Model units stay in the published 150 m scale; only the figures change.

Controls: WASD to walk, Shift to run, Space to jump, mouse to look, Esc to free the cursor, 1–7 to jump between places, R to reset. On a phone, use the on-screen stick and drag to look.

## Folder

| Path | What it is |
|---|---|
| `references/` | Boullée's six sheets from the Bibliothèque nationale de France, via Wikimedia Commons (public domain) |
| `model/newtons_cenotaph.blend` | Full scene: monument, 2,139 cypresses, landscape, cameras, sun and sky |
| `model/newtons_cenotaph.glb` | Monument + cypresses only, for other 3D apps (base colours only; the procedural stone textures stay in the .blend) |
| `renders/` | Final views, plus side-by-side and overlay comparisons with Boullée's plan and elevation |
| `scripts/build_scene.py` | Builds the whole scene from scratch. All dimensions live at the top of this file |
| `scripts/render_views.py` | Renders the cameras |
| `scripts/compare.py` | Makes the drawing-vs-render comparison images |
| `scripts/export_glb.py` | Writes the .glb |
| `scripts/export_web.py` | Writes the page's compressed monument, walk colliders and tree positions |
| `scripts/make_web_textures.py` | Generates the page's tiling stone, ground and foliage textures |
| `web/` | The walkable page. `.github/workflows/pages.yml` builds and deploys it on every push to `web/` |
| `docs/dimensions.json` | The dimensions and tree counts the last build used |

## Rebuild

```bash
cd ~/Documents/NewtonsCenotaph
/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P scripts/build_scene.py
/Applications/Blender.app/Contents/MacOS/Blender -b model/newtons_cenotaph.blend -P scripts/render_views.py -- --samples 128
/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P scripts/compare.py
```

To run the page locally:

```bash
cd ~/Documents/NewtonsCenotaph/web
npm ci
npm run serve
```

It serves at http://localhost:8123/. Add `?debug` to expose the test hooks as `window.walk`.

A full render of all seven views takes about 20 minutes on the M3. Use `--pct 40 --samples 24` for quick previews, and `--cams CAM_Hero_aerial` for one view.

## How the scale was set

The drawings used here carry no scale bar, and I found no figure from Boullée himself. Published descriptions give the sphere as about 150 m or 500 feet, so the model fixes it at **Ø150 m** and takes every other dimension from the drawings by proportion. As a check, the figures on sheet 03 are about 7.5–10 px tall against a 765 px sphere, which puts a 1.75 m person's sphere at 134–178 m.

- Elevation (sheet 03): 1 px = 0.196 m. Used for heights.
- Plan (sheet 01): 1 px = 0.3275 m. Used for radii and the tree rows.
- Section (sheet 04): shell thickness and the sunken sphere base. It agrees with the elevation within about 3%.

Origin is the sphere's axis at natural ground. The front (main stair, tunnel) faces −Y. Units are metres.

| Element | Dimension |
|---|---|
| Sphere | outer Ø150 m, inner Ø134 m (shell ≈ 8 m), centre 73.5 m above ground, top at 148.5 m |
| Ground terrace (platform) | Ø315 m, 5.5 m high |
| Main stair | 42 m wide, 92 risers of 0.06 units, set into the terrace edge |
| Drum (main cylinder) | Ø238 m wall, cornice Ø242 m, top at 46.5 m |
| Upper tier | Ø164 m wall, cornice Ø166 m, top at 64 m |
| Front opening in the drum | cone cut around the sphere, ±42 m wide at terrace level, ±74 m under the cornice; the cornice runs across as a bridge |
| Front stair block | solid block against the upper tier, 79 m wide at the bridge, 21 m at the top, 21 m deep, with a flight of 292 risers of 0.06 units on each side and the small door at its foot |
| Passages | 3.9 units high and 4.4 wide, from two doors beside the main stair, under the whole terrace, meeting under the sphere: about 160 units long |
| Ramp | climbs at about 24° through the floor to the sarcophagus at 9.5 units |
| Vault openings | 2,200 bores cut by boolean through the shell, above the upper tier, aimed at the sarcophagus and flaring inward |

## The cypresses

Close-up, each band of trees in the plan is a **double, staggered row**. So there are ten rows in five bands, about 3 m apart along each row (measured by autocorrelation along each ring of the plan scan).

| Band | Row radii (m) | Trees |
|---|---|---|
| Upper tier | 78.6, 80.9 | 148 + 147 |
| Drum, inner | 101.2, 103.5 | 199 + 198 |
| Drum, outer | 108.7, 111.4 | 196 + 197 |
| Ground terrace, inner | 139.2, 141.8 | 263 + 264 |
| Ground terrace, outer | 147.0, 149.7 | 263 + 264 |
| **Total** | | **2,139** |

Each band stops at the front, where the stairs pass (±23° on the drum and ±24° on the terrace, measured from the plan). On the upper tier the trees stop at the edge of the stair block.

The trees are Italian cypress (*Cupressus sempervirens* 'Stricta'), 9.6–11.4 m tall, which matches the 10–11 m Boullée drew. Eight tree shapes are shared across the rows, each with its own random height, rotation and tint.

The extra cypresses along the reflecting basin are scenery I added. They are not part of Boullée's design or of the 2,139.

## Materials

Boullée designed this in 1784, before modern concrete, as cut stone. The model uses period-correct stone, not concrete:

- **Drum and terrace walls:** coursed limestone ashlar, about 2.6 × 1.3 m blocks with fine joints, as drawn on the elevation. Paris Lutetian limestone colour, with weathering.
- **Sphere, cornices, stairs, sculpture:** smooth dressed limestone, with faint vertical rain streaks on the sphere.
- **Terrace walks:** limestone paving on the ground terrace and gravel on the upper terraces. The trees stand in soil beds.
- **Inside the vault:** Boullée pierced the shell so daylight would show as stars. These openings are modelled as emissive points, denser along a Milky Way band, with the larger "moon" opening from his section.

If you want a concrete version, swap the `Limestone ashlar` and `Limestone dressed` materials in the .blend. The shapes don't change.

## Interpretation and limits

- The drawings don't fully agree with each other. Where they differed, I followed the elevation for heights and the plan for radii and tree rows.
- How deep the front bridge is can't be read from an elevation. It is modelled as the full width of the drum cornice.
- The front stairs are read as a solid block standing against the upper tier, not a V cut into it. A cut left the tier overhanging its own stairs, and the block fits the hatched band in front of the tier on the plan and the door at the foot of the trapezoid on the elevation.
- The drawings show no stair from the ground terrace up to the drum terrace, so the page has none. Its number keys jump there instead.
- The section (sheet 04) shows a long, low passage under the floor, rising to the sarcophagus. The doors beside the main stair are my reading: the section doesn't run through the front, and the arch in the elevation stands too close to the centre to start a long passage, so that arch is modelled as a sealed door.
- The shafts of sunlight on the page are artistic: bores this narrow would pass direct sun for only a few minutes.
- The drawings show the lions only as small dark shapes, so their pose and modelling are my reading. The brazier, small portal and people are simplified stand-ins for scale.
- The interior galleries shown in the section, inside the drum, are not modelled. The drum is solid.
- Seen from a few metres away, the cypress foliage looks lumpy. It reads well from the normal viewing distances.
- The landscape (meadow, hills, woodland, basin, allée) is invented scenery.

## Sources

- Boullée's drawings, BnF Département des Estampes, digitised as `btv1b7701015b`. Files on [Wikimedia Commons](https://commons.wikimedia.org/w/index.php?search=Boull%C3%A9e+C%C3%A9notaphe+de+Newton&ns6=1)
- [Étienne-Louis Boullée — Wikipedia](https://en.wikipedia.org/wiki/%C3%89tienne-Louis_Boull%C3%A9e)
- [Numéro Cinq: Visit Boullée's Cenotaph for Sir Isaac Newton](https://numerocinqmagazine.com/2016/11/24/visit-etienne-louis-boullees-cenotaph-sir-isaac-newton-gary-garvin/)
- [The Marginalian on the cenotaph](https://www.themarginalian.org/2021/03/18/etienne-louis-boullee-newton-cenotaph/)
- [UT Pictura18: perspective elevation record](https://utpictura18.univ-amu.fr/en/notice/10256-newton-cenotaph-project-perspective-elevation-etienne-louis-boullee)

The page uses [three.js](https://threejs.org/) (MIT), [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) (MIT) and Draco (Apache-2.0).

Built 2026-10-25.
