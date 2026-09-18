# Auth dither background: 2D canvas, not WebGL

`apps/web/src/auth/dither-background.tsx` renders an animated ordered-dither
over a source image on a plain 2D canvas: a downscaled buffer is dithered
each frame with a slow ambient sine warp plus a cursor-driven displacement,
then upscaled with `image-rendering: pixelated`.

This replaces an original WebGL port: a WebGL canvas promoted the auth panel
to a GPU-composited layer that failed to paint (blank/white). A 2D canvas is
CPU-rasterized, composites reliably, and retains its last frame when
`requestAnimationFrame` is paused on a hidden tab.

The loop pauses whenever the canvas is offscreen or the tab is hidden, caps
to ~30fps, and honors `prefers-reduced-motion` reactively.
