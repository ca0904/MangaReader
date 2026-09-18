# Manga Reader

A reader for `.cbz` chapters, for manga and long-strip manhwa.

## Running it

    node server.js [library folder]

Open http://localhost:4173. No dependencies, no build step.

The library folder defaults to the folder above this one. Previous and Next walk the
chapter's own folder.

## Reading

Open a chapter with **Open a chapter** or by dropping a `.cbz` on the page.

- **Strip**: one continuous scroll, for webtoons.
- **Pages**: one page at a time, fitted to the screen.

The mode is picked from the page shapes; press **m** to switch, and that choice is
remembered for the folder. Upscaled art is sharpened with a Lanczos filter; press **l**
to turn it off.

| key | |
| --- | --- |
| space | scroll on, or next page |
| ← → | previous, next page |
| m | strip or pages |
| f | fullscreen |
| l | sharper scaling on or off |
| [ ] | previous, next chapter |
| + - 0 | wider, narrower, reset |
| home, end | start, end of chapter |
| escape | close the chapter |
