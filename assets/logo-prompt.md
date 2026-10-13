# PM2 notifier logo

Created with the built-in `image_gen.imagegen` tool in transparent-background mode. The final PNG preserves the generated alpha channel and measures 1254 × 1254 pixels.

## Initial generation prompt

```text
Use case: logo-brand
Asset type: PM2 notifier logo for a small Microsoft Teams Adaptive Card header and GitHub project
Primary request: create a professional, distinctive, minimal notification/monitoring mark: one recognizable notification bell integrated with a single clean pulse signal.
Scene/backdrop: genuinely transparent background, preserve alpha, no backdrop or tile.
Style/medium: flat vector-like logo artwork with precise smooth geometry and slightly rounded stroke joins. One unified symbol, balanced proportions, bold enough to remain legible at 32px.
Composition/framing: square image; center the single symbol, fill roughly 80% of the canvas, modest even transparent padding.
Color palette: restrained modern cobalt blue (#4F8FF7); single solid blue, no gradients.
Constraints: no text, initials, numbers, PM2 lettering, watermark, shadows, highlights, texture, bevels, 3D effects, mockup, background pattern, or extra decorations. The pulse signal should form a simple short notch or zigzag through the bell center; keep the bell silhouette easy to recognize.
```

## Final cleanup prompt

```text
Use case: logo-brand
Asset type: final PM2 notifier logo for a 32px Teams card icon
Input images: Image 1 is the edit target.
Primary request: clean up this logo for production. Preserve the exact bell-and-pulse design, centered composition, size, outline geometry and rounded joins. Remove every stray colored speck from the transparent negative space, inside and outside the bell. Make the blue shape a single perfectly flat solid cobalt blue (#4F8FF7), with crisp smooth antialiased edges.
Scene/backdrop: genuinely transparent; all negative space must have alpha zero.
Constraints: change only surface cleanup and color consistency; no text, no background, no tile, no shadows, no extra shapes. Preserve alpha transparency.
```

The cleanup used the initial generated PNG as its edit target. The final selected output was copied into `assets/pm2-notifier-logo.png`.

## Card encoding

The original generated image is preserved. `pm2-notifier-logo-card.png` is a 64 × 64 transparent PNG rendition encoded in `src/branding.ts` as a base64 data URI for display at 32 × 32 pixels. Resampling and PNG encoding used Windows System.Drawing with high-quality bicubic interpolation; no hosted image URL is needed.
