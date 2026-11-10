# Descent — the Helix Film 01 landing page

A scroll-driven landing page for a 49-second AI-generated film: one continuous
take from an old-growth forest down into a bioluminescent cavern. The scrollbar
is the scrubber — scroll position maps linearly onto the film's timeline and the
`<video>` element's `currentTime` is rewritten every frame.

Static site. **No build step.** `index.html`, `styles.css`, `main.js` and a
`public/` folder of assets.

```
site/
├── index.html          the page
├── styles.css          all styling, no preprocessor
├── main.js             the whole runtime (plain script, no modules)
├── README.md           this file
└── public/
    ├── poster.jpg              PLACEHOLDER poster (real JPEG, 1920×1080)
    ├── poster.svg              vector fallback for poster.jpg
    ├── placeholder-frame.jpg   PLACEHOLDER clean plate, used behind the video
    ├── favicon.svg
    ├── video/
    │   ├── descent.mp4         the render — 1080p, all-keyframe
    │   └── descent-720.mp4     the render — 720p, all-keyframe (mobile)
    └── frames/                 OPTIONAL image sequence for the fallback scrubber
        ├── manifest.json
        └── frame_0000.webp …
```

---

## Serving it

Any static file server works. From inside `site/`:

```bash
python3 -m http.server 8000
# → http://127.0.0.1:8000
```

```bash
npx serve .          # or any other static server
```

It also opens directly from the filesystem (`open index.html`) — `main.js` is a
classic script precisely so that `file://` works. Two things are degraded in
that case, and only in that case:

* `public/frames/manifest.json` cannot be fetched over `file://` (CORS), so the
  image-sequence fallback is unavailable unless you inline the manifest — see
  [Frame-index fallback](#frame-index-fallback).
* `window.scrollTo` is used instead of Lenis for anchor navigation.

> **The server must support HTTP Range requests.**
> Without `Accept-Ranges: bytes` / `206 Partial Content`, Chrome reports the
> media as non-seekable (`video.seekable` collapses to `[0, 0]`), clamps every
> seek to zero, and the film freezes on frame 0. `python3 -m http.server` does
> **not** support Range requests — use `npx serve`, `nginx`, `caddy`, GitHub
> Pages, Cloudflare Pages, S3, or anything else that does. The site degrades
> to plain playback when it detects this, but you will get a much better
> result with a Range-capable host.

---

## Assets it expects

| Path | Required | What it is |
|---|---|---|
| `public/video/descent.mp4` | yes (site degrades without it) | the full render, 1080p preferred |
| `public/video/descent-720.mp4` | no | smaller render served to viewports ≤ 820px |
| `public/video/manifest.json` | no | written by the generation pipeline; the credits section quotes the model and resolution from it |
| `public/poster.jpg` | yes | placeholder poster; also the static frame under reduced motion |
| `public/placeholder-frame.jpg` | yes | clean, text-free plate shown behind the video |
| `public/poster.svg` | yes | vector fallback for `poster.jpg` |
| `public/frames/manifest.json` | no | enables the frame-index fallback scrubber |

### The render manifest

`public/video/manifest.json` is produced by the generation pipeline (it holds the
four clip prompts, their durations and the model that was quoted). The site
reads it opportunistically and fills in the credits line — `Rendered with
Seedance 2.5 · 1080p · 16:9 · 24 fps` — from `model`, `resolution` and `fps`.
If the file is missing, the copy baked into `index.html` is used instead. The
page never fails because of it.

### What is a placeholder right now

**`poster.jpg` and `placeholder-frame.jpg` are placeholders, not film frames.**
They were generated with ffmpeg as a dark teal-to-black gradient so the page
looks finished before the render exists. `poster.jpg` has the title burnt into
the lower-left corner and the words `PLACEHOLDER FRAME` / `NOT A GENERATED
FRAME`; `placeholder-frame.jpg` is the same gradient with no text at all.

Replace both with a real frame from the render when it lands — for example:

```bash
ffmpeg -i public/video/descent.mp4 \
  -ss 00:00:40 -frames:v 1 -q:v 3 public/poster.jpg
```

`poster.jpg` is used for the hero, the Open Graph image, and the static frame
shown under `prefers-reduced-motion: reduce`. `placeholder-frame.jpg` is the
plate that sits behind the video inside the pinned section (the video fades in
over it once it loads). If you would rather have one image, point both at
`public/poster.jpg` — the plate is cropped to fill, so the burnt-in caption
will be cropped out.

Until the render exists you will see two 404s in the console for
`public/video/descent.mp4`. That is expected and harmless; the page detects
the missing file and switches to the static plate with a
`RENDER PENDING — NO VIDEO FILE PRESENT` badge.

---

## The keyframe requirement

Scroll-scrubbing is only frame-accurate if every frame is a keyframe. A normal
H.264 file stores a keyframe every few seconds and the rest as deltas, so the
browser has to decode forward from the previous keyframe to answer a seek.
That is slow (100–800 ms per seek), it lands off-target, and it makes the
scrub stutter.

So the render must be re-encoded with `-g 1`:

```bash
# 1080p master — every frame is a keyframe
ffmpeg -i render-1080.mp4 \
  -c:v libx264 -preset slow -crf 18 \
  -pix_fmt yuv420p -profile:v high -level 4.1 \
  -g 1 -keyint_min 1 -sc_threshold 0 \
  -movflags +faststart \
  public/video/descent.mp4

# 720p mobile variant
ffmpeg -i render-1080.mp4 \
  -vf scale=-2:720 \
  -c:v libx264 -preset slow -crf 20 \
  -pix_fmt yuv420p -profile:v main -level 3.1 \
  -g 1 -keyint_min 1 -sc_threshold 0 \
  -movflags +faststart \
  public/video/descent-720.mp4
```

`-g 1` is the important part. `-keyint_min 1 -sc_threshold 0` stops the
encoder from re-inserting a keyframe interval of its own, and
`-movflags +faststart` moves the `moov` atom to the front of the file so the
browser can index it without a range request.

The file gets large — all-keyframe 1080p at CRF 18 is roughly 8–15× the size of
a normal encode. That is the trade.

**If you cannot re-encode**, the site detects the situation and degrades on its
own (see below). Nothing breaks; the film just stops being scrubbable.

---

## Scroll → time mapping

Let the pinned film section be `S` pixels of scrollable length and `D` the
film's duration in seconds. With the current CSS (`500vh` section, viewport
pinned over it) `S = 4 × viewport height`.

```
progress  p  = clamp((scrollY - filmTop) / S, 0, 1)
film time t  = p × D                       (D = 49 s, the four clips concatenated)
video time   = p × video.duration          (uses the real file length when known)
```

Concretely, at a 900 px-tall viewport with the film starting at `scrollY = 900`:

| `scrollY` | `p` | `t` |
|---|---|---|
| 900 | 0.000 | 00:00 |
| 1800 | 0.250 | 00:12 |
| 2700 | 0.500 | 00:24 |
| 3600 | 0.750 | 00:37 |
| 4500 | 1.000 | 00:49 |

The clip boundaries are the same numbers, because the four clips are
concatenated in order:

| Clip | Title | Film time | Chapter window |
|---|---|---|---|
| 01 | The Forest | 0 – 12 s | `p` 0.000 – 0.245 |
| 02 | Into the Grass | 12 – 24 s | `p` 0.245 – 0.490 |
| 03 | Threshold | 24 – 34 s | `p` 0.490 – 0.694 |
| 04 | The Reveal | 34 – 49 s | `p` 0.694 – 1.000 |

Those boundaries live in exactly one place: the `data-clip-start` /
`data-clip-end` / `data-clip-dur` attributes on each `<li>` in
`#clips` in `index.html`. `main.js` reads them, builds the chapter cards and
the rail from them, and derives `D` from the largest `data-clip-end`. Change a
number there and the chapter choreography follows.

The chapter reveal is a function of **film time**, not of scroll progress, so it
stays in sync with the footage even in the degraded modes.

### Implementation

* **Lenis** provides the smooth scroll. It is wired into GSAP exactly as
  ScrollTrigger expects:

  ```js
  lenis.on('scroll', ScrollTrigger.update);
  gsap.ticker.add((t) => lenis.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);
  ```

* **GSAP ScrollTrigger** owns the pin and the scrub. The section is `500vh`;
  `.film__pin` is pinned from `top top` to `bottom bottom` with
  `pinSpacing: false` (the section already provides the scroll length):

  ```js
  gsap.timeline({
    scrollTrigger: {
      trigger: filmEl, start: 'top top', end: 'bottom bottom',
      pin: pinEl, pinSpacing: false, scrub: true, invalidateOnRefresh: true
    }
  }).to(proxy, { p: 1, ease: 'none', duration: 1 });
  ```

  `proxy.p` is the scroll progress. A single `tick()` reads it and writes
  `video.currentTime`.

* **No GSAP / no Lenis?** Both CDN scripts are loaded with `defer` and the page
  does not depend on them. If GSAP is missing, `main.js` adds `no-gsap` to
  `<html>`, the pin falls back to `position: sticky`, and progress is computed
  from `getBoundingClientRect()` instead. Anchor links fall back to
  `scrollIntoView` with `scroll-behavior: smooth` from CSS.

---

## Degradation ladder

The scrub is the fragile part of a scroll-driven video page, so the site
probes it at runtime instead of assuming.

**1. Scrub (the intended mode).** `video.currentTime` is set from the scroll
position. Seeks are **serialised** — one in flight at a time — because setting
`currentTime` while a previous seek is still decoding aborts it, which would
leave a non-keyframe file frozen on frame 0 forever. The newest requested time
is remembered and issued as soon as the current seek lands.

**2. Frame-index fallback.** The site measures every seek: the time from
request to the `seeked` event, and how far the landed position is from the
requested one. If **4 of the last 6 measured seeks took longer than 120 ms or
landed more than 80 ms off target**, the file cannot be scrubbed reliably and
the site switches to a `<canvas>` scrubber that draws an image sequence by
frame index.

The sequence is optional. Drop the frames in `public/frames/` and a
`manifest.json` next to them:

```json
{
  "fps": 24,
  "count": 1176,
  "offset": 0,
  "pattern": "public/frames/frame_{index}.webp",
  "width": 1920,
  "height": 1080
}
```

* `fps` — the frame rate the sequence was extracted at.
* `count` — how many frames.
* `pattern` — `{index}` is replaced by the zero-padded frame number.
* `offset` — added to the index before padding. ffmpeg numbers its output
  from `1`, so use `"offset": 1` for a straight `ffmpeg -i … frame_%04d.webp`
  extraction.

To extract one:

```bash
mkdir -p public/frames
ffmpeg -i public/video/descent.mp4 \
  -vf "select='not(mod(n\,1))'" -vsync 0 -c:v libwebp -quality 72 \
  public/frames/frame_%04d.webp
```

(The site only needs a sequence when the mp4 cannot be scrubbed, so a sparse
one — `not(mod(n,10))` at 2.4 fps — is enough and costs a fraction of the
disk.)

**3. Plain playback.** With no image sequence available, the site stops
scrubbing and simply plays the film on loop, with the HUD reading `Playback`
instead of `Scrub`. The chapters follow the video's own clock.

**4. Static.** If there is no video at all, the placeholder plate is shown with
a `RENDER PENDING` badge, the HUD reads `Static`, and the chapters still
reveal against the scroll so the page is not dead.

You can watch which mode the page is in from the small chip in the top-right
of the pinned section, or from the console:

```js
Descent.mode     // 'scrub' | 'frames' | 'autoplay' | 'static'
Descent.progress // 0 → 1
Descent.probe    // the seek measurements: { ms, err, t }
```

---

## Reduced motion

Under `prefers-reduced-motion: reduce`:

* the page does **not** scrub and does **not** animate — the film is replaced by
  the static `public/poster.jpg`, and the four chapters are laid out as a
  readable list beneath it;
* the WebGL particle/light overlay is not created at all;
* the scroll-driven reveal (headline → subtext → nav) is disabled — everything
  is visible immediately;
* smooth scrolling is off.

The same static layout can be switched on manually with the **Motion** toggle
in the nav, and switched back off if you want the full experience despite the
OS setting. The toggle is an `aria-pressed` button, so its state is announced.

---

## Mobile

`<source media="(max-width: 820px)">` points at `descent-720.mp4`; the
full-resolution file is the fallback `<source>`. If the 720p file has not been
rendered yet, the browser fails that source and falls through to the next one
— and `main.js` also drops the media-constrained `<source>` and re-runs
`video.load()` so the fallback is deterministic.

At 360 px the nav collapses to the wordmark plus the toggle and CTA, the
chapter rail is hidden, and the chapter card takes the width of the screen.

---

## Accessibility

* The scroll story is progressive enhancement. With JavaScript off the page is
  a normal document: the hero, a `<noscript>` summary of the film, the full
  clip list, the pipeline description, the model table and the credits are all
  readable, and the pinned section collapses to a static frame.
* The `<video>` is `aria-hidden` and not focusable — the same information is in
  the written clip list, which screen readers get in full.
* Text contrast: body copy is `#f0f3f0` at 70 % over `#04070a` (≈ 12:1);
  secondary labels sit at 46 %, still ≈ 7:1. The accent colour is only ever
  used for large type, rules and small caps.
* Focus is visible everywhere (`outline: 2px solid` in the current accent) and
  a skip link jumps straight to the written film description.
* The nav is hidden at scroll 0 and revealed by scrolling (it fades in last in
  the reveal order). It is still in the accessibility tree, and `:focus-within`
  reveals it the moment anything inside it receives focus.

---

## Notes for whoever wires the real render in

* The page expects a single concatenated file of the four clips, in order, at
  24 fps. If your render is a different length, the page uses the file's real
  duration for the video and rescales the chapter windows onto it, so it stays
  in sync — but the authored timeline is 49 s.
* Do not add `-vf scale` when making the 720p variant from an already-cropped
  master without checking the aspect: the film is 16:9 and the page crops to
  cover whatever the viewport is.
* If you change the clip lengths, update `data-clip-start` / `data-clip-end` /
  `data-clip-dur` in `index.html` — nothing else needs to change.
* The `public/frames/` folder is optional and can be deleted entirely; the
  site will fall back to playback instead of frame-index scrubbing.
