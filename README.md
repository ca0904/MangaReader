# Manga Reader

A reader for `.cbz` chapters, for manga and long-strip manhwa.

## Running it

    node server.js [library folder]

Open http://localhost:4173. No dependencies, no build step.

The library folder defaults to the folder above this one. Only `.cbz` files inside it
can be opened by path, and Previous and Next walk the chapter's own folder.

## Reading

Open a chapter with **Open a chapter** or by dropping a `.cbz` on the page.

- **Strip**: one continuous scroll, for webtoons.
- **Pages**: one page at a time, fitted to the screen.

The mode is picked from the page shapes; press **m** to switch, and that choice is
remembered for the folder.

## Scaling

When a page is shown larger than its own resolution, it is redrawn with a sharper
upscaler instead of the browser's bilinear scaling. Press **l** to cycle through:

- **ArtCNN** (default): the C4F32 network from
  [ArtCNN](https://github.com/Artoriuz/ArtCNN), a small CNN for anime-style line art,
  run on the GPU with WebGPU. Measured against Lanczos, it kept about 4 dB more detail
  on manhwa strips and 1.6 to 2.4 dB more on manga pages. Without WebGPU it falls back
  to Lanczos.
- **Lanczos**: a Lanczos-3 filter in a WebGL2 shader.
- **Browser**: the browser's own scaling.

The choice is remembered. Shrinking is always left to the browser.

## Keys

| key | |
| --- | --- |
| space, shift+space | scroll on or back, or turn the page |
| ↑ ↓, j k, page up/down | scroll a screen |
| ← → | previous, next page |
| m | strip or pages |
| f | fullscreen |
| l | ArtCNN, Lanczos or browser scaling |
| [ ] | previous, next chapter |
| + - 0 | wider, narrower, reset |
| home, end | start, end of chapter |
| escape | close the chapter |
