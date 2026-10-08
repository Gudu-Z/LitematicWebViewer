<p align="center"><img src="public/brand/logo.svg" alt="LitematicWebViewer logo" width="96" height="96"></p>

# LitematicWebViewer

[简体中文](README.md) · **English**

Preview Minecraft `.litematic` / `.litematica` schematics—building blueprints saved by the Litematica mod—in 3D in your browser. The model catalog also lets you inspect different block, mob and entity states. Everything runs on the client; no backend server is required. Most of the code was written with AI.

**[Online viewer](https://lwv.loafing.club/)** · **[Model catalog](https://lwv.loafing.club/scripts/entity-preview.html)** · **[Embedded card examples](https://lwv.loafing.club/embed-example.html?lang=en)** · **[Download a sample](samples/demo.litematic)**

![The viewer displaying a sample build, with layer controls on the left and region and material lists on the right](docs/images/viewer.png)

*Rotate and zoom around a schematic, inspect its materials, or switch layers to examine its interior. This screenshot uses the repository's `demo.litematic`.*

## Features

**Rendering**

- Actual block textures, with support for **ZIP resource packs**.
- Complete block models, including stairs, fences, doors, redstone components and rails; hidden-face culling and geometry batching by texture.
- Grass, foliage, water and lava tinting; translucent fluid rendering, underwater fog, water flow directions and bubble columns.
- Special blocks: bells, enchanting table books, conduits, animated end portals and gateways, waving banners, decorated pots with sherd patterns, chiseled bookshelves, copper golem statues and more.
- Entities: minecarts, boats, cushions, sign text, player heads with actual skins and item frames.
- Passengers: reads nested `Passengers` from schematics to display mobs riding minecarts, boats, bamboo rafts and cushions, including two boat passengers, baby passengers, seated poses and equipment.
- 85 mob types with continuous effects, skeletal idle animations and states such as skins, wool, inflation and sitting; 40 support baby forms.
- Vanilla animated texture frame sequences and interpolation. Resource packs can override animations; for example, the included XK pack uses a single water frame.

**Interaction**

- Orbit and first-person flight camera modes.
- Perspective and orthographic projection, with perspective as the default. Orthographic views help compare dimensions and inspect structures.
- Image export studio with isometric views, transparent PNGs, custom resolution and aspect ratios, using the current schematic, resource packs and layer selection.
- Region visibility and layer slicing: all, below, above or a single layer.
- Material counts by block, translated names and ascending/descending sorting.
- Chinese and English interfaces.
- Model catalog with categories, bilingual search, state combinations, and world, item, spawn egg and item-frame views.
- Settings for background color, entity/region outline/dimension visibility, underwater fog and camera sensitivity.
- Mobile controls, including a flight joystick and vertical movement buttons.
- Embedded previews for other websites: popup or inline cards with custom themes, transparent backgrounds, headless UI and host controls. A [style configurator](https://lwv.loafing.club/embed-example.html?lang=en#customize) generates integration code.
- Full-viewer embeds with archive branding, configurable panels and tools, compact layouts, and theme continuity when opening from a quick preview.

For everyday use, open the [online viewer](https://lwv.loafing.club/). The installation instructions below are for local use and development.

## Embedded preview cards

Schematic archives and build pages can embed the viewer without deploying the renderer or uploading schematics to our server. [Try the interactive examples](https://lwv.loafing.club/embed-example.html?lang=en).

![Archive integration examples: click a list entry to preview, or switch an image gallery to 3D](docs/images/embed-cards.png)

There are two presentation options: **click a schematic to open a preview over the current page**, or **embed a 3D preview inside a build page's image gallery**. Both support left-drag to rotate, right-drag to pan and the mouse wheel to zoom. On mobile, use one finger to rotate and two fingers to pan or pinch to zoom; swipe outside the preview to scroll the page. The top-right controls provide **Reset view** and **Full viewer**. Only the latter opens the full website in a new tab. Quick previews do not enable WASD flight.

### Option 1: click to open a preview

Connect an existing schematic list entry, thumbnail or quick-preview button to `openLitematicPreview`. Users stay on the current page and close the preview to continue browsing.

```html
<button id="preview-schematic" type="button">Preview sample schematic</button>

<script type="module">
  import { openLitematicPreview } from 'https://lwv.loafing.club/embed.js'

  document.getElementById('preview-schematic').addEventListener('click', () => {
    openLitematicPreview({
      url: 'https://lwv.loafing.club/demo.litematic',
      name: 'Sample schematic',
      lang: 'en',
      pack: 'xk',
    })
  })
</script>
```

![A schematic preview dialog with the archive page preserved behind it](docs/images/embed-popup.png)

Use the close button, click the backdrop or press Esc to dismiss. Closing releases rendering resources and restores the page's scrolling and focus. Only one popup is open at a time; opening another replaces it. Styles are contained in a Shadow DOM and do not affect the host website.

`openLitematicPreview(options)` shares the card API's source, appearance, interaction and callback options. It returns `element`, `load(source, name?)`, `setOptions()`, `setCamera()`, `resetView()`, `openFullViewer()` and `close()`. Supply `file` instead of `url`, or open the popup first and call `load` when the file becomes available. Call `close()` when leaving an SPA route. `name` sets the popup title. Public file URLs must satisfy the CORS requirements below.

### Option 2: embed inside a build page's image gallery

Place this iframe inside the build page's image area to rotate, pan and zoom the schematic there. You can also add **Images / 3D preview** tabs like the [example detail page](https://lwv.loafing.club/embed-example.html?lang=en#detail): call `createLitematicCard` when selecting 3D, then `destroy()` when returning to images to release resources.

This example works as written. When replacing `file`, encode the **entire file URL** using `encodeURIComponent` or `URLSearchParams`; do not concatenate download URLs containing `&` directly into the query string.

```html
<iframe
  src="https://lwv.loafing.club/embed.html?file=https%3A%2F%2Flwv.loafing.club%2Fdemo.litematic&amp;lang=en&amp;pack=xk"
  title="Schematic preview"
  loading="lazy"
  referrerpolicy="no-referrer"
  sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
  style="width:100%;height:320px;border:0;border-radius:12px"
></iframe>
```

| URL parameter | Meaning | Default |
| --- | --- | --- |
| `file` | Direct download URL for `.litematic`, `.litematica` or `.nbt`; not a download landing page | None; waits for a file |
| `lang` | `zh` / `en` | `zh` |
| `pack` | `xk` / `vanilla` | `xk` |
| `background` | Six-digit hex background color, e.g. `%23172332`, or `transparent` | Follows theme |
| `theme` | `dark` / `light` / `auto` (system preference) | `dark` |
| `ui` | `default` / `none`; the latter hides the internal interface | `default` |

**CORS:** the file server must allow responses to be read by `https://lwv.loafing.club`, for example with `Access-Control-Allow-Origin: https://lwv.loafing.club`. Public files may use `*`. Redirects must also satisfy CORS requirements. Download requests do not include cookies or authentication credentials. Use HTTPS in production; HTTP is supported for local HTTP development. [CORS documentation](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS)

### File sources: JavaScript integration and authenticated downloads

Both popup and inline previews accept file data. For authenticated downloads, servers without a cross-origin download API, or files already loaded by the archive, the host reads the file using its own access permissions and provides a `File`, `Blob`, `ArrayBuffer` or typed array. Login credentials do not need to be shared with this site. This example uses an inline card; for a popup, use `openLitematicPreview({ file, name: file.name, lang: 'en' })`.

```html
<input id="schematic" type="file" accept=".litematic,.litematica,.nbt">
<div id="preview-card" style="height:320px;border-radius:12px"></div>

<script type="module">
  import { createLitematicCard } from 'https://lwv.loafing.club/embed.js'

  const card = createLitematicCard(document.getElementById('preview-card'), {
    lang: 'en',
    pack: 'xk',
    onStatus(event) {
      if (event.type === 'error') console.error(event.message)
    },
  })

  document.getElementById('schematic').addEventListener('change', event => {
    const file = event.target.files[0]
    if (file) card.load(file)
  })

  // Alternatively, use your archive's existing download endpoint:
  // const response = await fetch('/api/schematics/123/download', {
  //   credentials: 'same-origin',
  // })
  // if (!response.ok) throw new Error(`HTTP ${response.status}`)
  // card.load(await response.blob(), 'My build.litematic')

  // Call when removing the card or leaving an SPA route:
  // card.destroy()
</script>
```

You can also pass `file` during creation, or use `{ url: 'https://archive.example/build.litematic' }`. URL mode still requires CORS as described above. The host must have legitimate access to files it reads; this API does not bypass authentication or cross-origin restrictions.

In `createLitematicCard(container, options)`, `name` supplies the accessible title and default name for unnamed files; `poster` supplies an HTTP(S) cover image while inactive. The returned object exposes `element`, `load(source, name?)`, `setOptions()`, `setCamera()`, `resetView()`, `openFullViewer()` and `destroy()`. `load` throws synchronously for invalid types, empty files and oversized files; network and parsing errors are reported through `onStatus`.

### Match your site and use your own UI

The [style configurator](https://lwv.loafing.club/embed-example.html?lang=en#customize) includes dark, light and custom archive examples. Adjust the settings and copy working inline or popup code. Existing integrations keep working; the default remains dark with orbit, pan and zoom enabled.

![A transparent model with host controls, and options for theme, controls and camera](docs/images/embed-customizer.png)

```js
const preview = openLitematicPreview({
  url: schematicURL,
  name: 'Build name', lang: 'en',
  theme: 'light',
  background: '#f2f5f8',
  style: { accent: '#21796b', radius: 16, fontFamily: 'system-ui, sans-serif' },
  controls: { hint: false },
  labels: { open: 'Materials and layers ↗', reset: 'Reset' },
  dialog: { width: 960, height: 680 },
  camera: { projection: 'orthographic' },
  interaction: { autoRotate: true, autoRotateSpeed: 2 },
});
// Follow your site's theme switch without downloading or rebuilding the model:
preview.setOptions({ theme: 'dark', background: null });
```

| Option | Values and behavior |
| --- | --- |
| `theme` | `dark`, `light`, `auto`; `auto` follows the OS. For a site-specific theme switch, call `setOptions` |
| `background` | `#RRGGBB`, `transparent`, or `null` (theme default). Transparency includes the WebGL canvas, so the model can sit over host images or gradients |
| `style` | Hex colors for `accent`, `surface`, `text`, `muted`, `border`, `backdrop`; six-digit color for `background`; `radius` from 0–48 px; `fontFamily` as a font list (fonts must be available in the preview) |
| `ui` | `default` retains built-in UI; `none` hides internal buttons, gesture hints, loading and error messages so the host can provide them |
| `controls` | Booleans `reset`, `open`, `hint`, `status` control internal UI; `title` controls the popup heading. All default to `true`. The popup close button stays available |
| `labels` | Plain-text overrides for `reset`, `open`, `hint`, `waiting`, `loading`, `error`, `retry`, `activate`, `subtitle`, `close` |
| `dialog` | Popup `width` / `height` in pixels, from 240–4096; constrained to the viewport |
| `interaction` | `rotate`, `pan`, `zoom` default to `true`; `autoRotate` defaults to `false`; `autoRotateSpeed` defaults to 2, range -20–20, negative reverses direction |
| `camera` | `projection: 'perspective' / 'orthographic'`, `zoom` from 0.01–100. Optional `position: [x,y,z]` and `target: [x,y,z]` must be supplied together, in block coordinates. Orthographic snapshots also contain `height` |

Headless mode suits archives that already have a dialog, toolbar and loading UI. This example uses host buttons. For a popup, put these elements inside your own `<dialog>` or modal component; the configurator can generate that version too.

```html
<div id="model" style="height:400px;background:linear-gradient(#d7eadd,#f5f2e9)"></div>
<button id="reset-model" disabled>Reset view</button>
<button id="open-model" disabled>Full viewer</button>
<p id="model-status" role="status"></p>
<script type="module">
  import { createLitematicCard } from 'https://lwv.loafing.club/embed.js?v=customize-1';
  const reset = document.getElementById('reset-model');
  const open = document.getElementById('open-model');
  const preview = createLitematicCard(document.getElementById('model'), {
    url: 'https://lwv.loafing.club/demo.litematic', lang: 'en',
    background: 'transparent', ui: 'none',
    camera: { projection: 'orthographic' },
    onStatus(event) {
      document.getElementById('model-status').textContent = event.message || '';
      if (event.stage !== 'handoff' && ['loaded', 'loading', 'error', 'inactive'].includes(event.type)) {
        reset.disabled = open.disabled = event.type !== 'loaded';
      }
      // loading events can include progress from 0 to 1; otherwise show indeterminate progress.
    },
    onCameraChange(camera) { /* Save this view and restore it with setCamera(camera). */ },
  });
  reset.onclick = () => preview.resetView();
  open.onclick = () => preview.openFullViewer();
  // When removing the component: preview.destroy();
</script>
```

- `setOptions(patch)` merges nested settings. Set a group to `null` to reset it; set a `style` / `labels` entry to `null` to remove its override. Appearance updates preserve the current camera. `pack` and `poster` are creation options; replace sources with `load()`.
- `setCamera(patch)` updates and saves the initial view; `resetView()` fits the model using that configured view. Options and the latest camera survive offscreen iframe disposal and reactivation.
- Call `openFullViewer()` **directly in the host button's click handler, before any `await`**, to preserve browser user activation. It returns `true` when a tab opens, or `false` if the model is not ready, a transfer is pending, or popups are blocked. File and camera data follow after the tab opens; private files do not need another download.
- Window-opening and file-transfer errors include `stage: 'handoff'`. The model remains usable; keep the host's retry button enabled.
- `onStatus(event)` / the `preview-status` DOM event reports `waiting`, `ready` (communication ready), `loading`, `loaded`, `error`, `inactive` (offscreen disposal), `handoff-start`, `handoff-end`, and `close-request`. These still fire in headless mode or when `status` is hidden; hosts should display loading failures.
- `onCameraChange(camera)` / the `preview-camera` DOM event provides snapshots at most about every 100ms. Camera events do not overwrite the `onStatus` loading state. Esc inside an inline card reports `close-request`; built-in popups dismiss automatically, while custom dialogs can handle the event themselves.

Popup chrome also exposes CSS custom properties and `::part`:

```css
[data-litematic-preview] {
  --lwv-dialog-width: 960px;
  --lwv-radius: 20px;
  --lwv-surface: #f7faf8;
  --lwv-backdrop: #14233488;
}
[data-litematic-preview]::part(header) { padding: 12px 20px; }
[data-litematic-preview]::part(title) { font-weight: 500; }
```

Public parts: `dialog`, `header`, `title`, `subtitle`, `close-button`, `viewport`. Additional variables: `--lwv-dialog-height`, `--lwv-font`, `--lwv-text`, `--lwv-muted`, `--lwv-border`, `--lwv-accent`. **These affect only the outer shell. Configure the iframe through `style`, `controls`, `labels`, and other options.** Host CSS and font files do not automatically enter a cross-origin iframe.

The SDK remains a single-file ES module. When adopting new APIs, prefer the versioned import URL generated by the configurator to avoid a previously cached SDK. The example page automatically uses its build's SDK revision. Developers should edit `src/embedSdk.js` / `src/previewOptions.js`; `npm run build` (or startup with `npm run dev`) generates `public/embed.js`.

### Embed the full viewer in an archive

`createLitematicViewer` brings the main viewer's layer controls, region visibility, material list, resource pack manager and image export into a build page. It shares the quick preview's `theme`, `background`, `style` and camera options. Settings and image export use the same theme.

![The full viewer inside a light archive, with layer controls and build information](docs/images/full-viewer-embed.png)

Choose **Full viewer** under **Preview mode** in the [configurator](https://lwv.loafing.club/embed-example.html?lang=en#customize). Adjust panels, branding and the return link, then copy inline or popup code.

```html
<div id="viewer" style="height:680px;border-radius:14px;overflow:hidden"></div>
<script type="module">
  import { createLitematicViewer } from 'https://lwv.loafing.club/embed.js?v=viewer-1';
  const viewer = createLitematicViewer(document.getElementById('viewer'), {
    url: 'https://lwv.loafing.club/demo.litematic', // Or pass file
    lang: 'en', pack: 'xk', theme: 'light',
    style: { accent: '#21796b', surface: '#ffffff', radius: 14 },
    viewer: {
      header: true,
      layout: 'auto', density: 'comfortable', panelOpacity: 0.94,
      panels: { file: false, metadata: true, materials: true },
      tools: { catalog: false, help: false },
      expanded: { regions: true, materials: false },
      brand: {
        name: 'My build archive',
        // logo: 'https://archive.example/logo.svg',
        returnUrl: 'https://archive.example/build/123',
        returnLabel: 'Back to build details',
      },
    },
  });
  // Follow the archive theme without reloading the model or resetting the camera.
  // viewer.setOptions({ theme: 'dark', style: { surface: null } });
  // When leaving this route or removing the component: viewer.destroy();
</script>
```

| `viewer` option | Behavior and defaults |
| --- | --- |
| `header` | Show the header; defaults to `true`. Hiding it extends the canvas to the top |
| `layout` | `auto`: side panels on wide screens, bottom drawers on narrow screens; `compact`: use drawers on wide screens too |
| `density` / `panelOpacity` | `comfortable` or `compact`; panel opacity from 0.3–1, default 0.94 |
| `panels` | `file`, `controls` (camera and layers), `metadata`, `regions`, `materials`; all visible by default |
| `tools` | `packs`, `export`, `catalog`, `settings`, `language`, `help` (hints and source link), `interface` (hide UI), `projection`; all visible by default |
| `expanded` | `regions` and `materials` start expanded; theme updates preserve the visitor's manual expand/collapse choices |
| `brand` | `name`, `logo`, `returnUrl`, `returnLabel`; text is displayed literally, URLs must be absolute HTTP(S). The return link opens a new tab inside an embed, or navigates the current tab on a standalone full page |

The returned handle supports the same `load`, `setOptions`, `setCamera`, `resetView`, `openFullViewer`, `destroy`, status events and camera events as quick cards. `ui`, `controls` and `labels` customize quick cards; use the `viewer` options above for full-viewer panels and tools. `interaction` controls orbit gestures; the full viewer also retains flight mode. Ordinary full-viewer operation errors include `stage: 'viewer'`; hosts can show the message while keeping actions for the loaded model available.

**Quick cards also accept `viewer` options.** Opening “Full viewer” carries over the theme, font, transparent background, panels and branding. Appearance options stay in the full-page URL across refreshes; file-data mode still requires reopening the file itself. CSS applied only to the host popup shell is not transferred: use `style` for shared appearance.

A full viewer loads when it first becomes visible. It pauses drawing offscreen or behind a host preview dialog, retaining the file, layers, resource packs and camera until `destroy()`. It does not participate in the quick-card `maxActive` disposal pool. Use it on detail pages or in on-demand dialogs, and keep quick cards for list thumbnails. Integration sessions and the full pages they open neither read nor overwrite the independent site's personal preferences; resource packs imported there stay in that page's memory.

### Multiple cards, full-viewer navigation and hosting

- **For lists, use cover images with click-to-open previews.** Rendering starts only after a click. If you need several inline previews, the JS module mounts at most two visible cards by default. Other cards show a poster or an “Activate 3D preview” button. Hovering or activating a card changes which cards run. Offscreen frames are removed to release rendering contexts, and reload when selected again. Opening a popup also releases background inline cards and restores them after closing, except cards temporarily retained during file handoff to the full viewer. Import `configureLitematicCards` from the same module and call `configureLitematicCards({ maxActive: 1 })` to change the limit; supported values are 1–4. Plain iframes pause offscreen rendering but do not participate in JS card management.
- **Opening the full viewer preserves the file, camera position, projection, language, pack preset and appearance options.** Transparency is retained; a new tab does not copy the host's image or gradient behind the embed. Files pass through origin-, window- and token-checked `postMessage`, without third-party cookies, browser storage or server uploads. Keep the original page and preview open until loading completes, and allow user-initiated new tabs. [postMessage documentation](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage)
- **Refreshing a full-viewer tab opened from file data requires reopening the file.** Public URL mode retains the `file` parameter and can download again. Archives must refresh expired signed URLs.
- Cards and the full-viewer pages they open use the requested `xk` / `vanilla` preset. They do not read personal resource packs or overwrite saved pack preferences. Custom ZIP packs are not currently accepted as embed parameters.
- The embedded file limit is **64 MiB of compressed file data**, in addition to the block-count and browser-memory limits below. Large schematics still require full downloads and parsing. Prefer cover images in archive lists and interactive previews on detail pages.
- Hosts with strict CSP must allow this site's origin in `frame-src`; JS integration also needs permission to load this site's module script. When using iframe `sandbox`, keep the four permissions in the example. Full viewers also need `allow-downloads` for PNG export; the SDK adds it automatically.
- Static hosting is sufficient; no backend proxy is required. For self-hosting, import `embed.js` from your own domain: it resolves `embed.html` or `index.html` in the same directory and supports subdirectory deployments. Hosting headers must not block partner sites with `X-Frame-Options: DENY/SAMEORIGIN` or restrictive CSP `frame-ancestors` rules.

Validation:

```bash
node scripts/verify-embed-protocol.mjs  # URLs, files, error responses and streamed download limits
npm run build
node scripts/verify-embed.mjs           # Cross-site handoff, transparent pixels, theme/camera APIs, generated examples and mouse/touch controls
node scripts/verify-full-viewer.mjs     # Full embeds, panels/branding, session isolation, PNG downloads, handoff and mobile layout
```

Browser validation requires Chrome / Chromium and uses port 5178 plus a temporary test website. On Windows it checks the standard Chrome installation path; set `CHROME_PATH` for other locations.

## 1. Initial setup

Install [Node.js](https://nodejs.org/) **22.12 or newer**. In the project directory, run:

```bash
npm install        # Install dependencies
npm run setup      # Download the official client and extract textures/models; internet required
```

> The default resource version is **26.3**. Setup downloads the complete `client.jar` and extracts the required assets. Run `node scripts/fetch-assets.mjs 1.21.1` to select another version; the model catalog and newer entity models still target 26.3.

## 2. Start the viewer

```bash
npm run dev
```

The browser opens `http://localhost:5173` automatically.

## 3. Usage

1. Click **Open schematic** or drag a `.litematic` file onto the page. The home screen also offers **Browse model catalog** and **Export rendered image**.
2. Wait for the build to appear in 3D.
3. Use the **Render** and **Layer** controls on the left to view the entire build, a single layer, or everything above/below a layer. Regions and materials appear on the right.
4. Open the top-right **gear**. **Display & controls** contains background, visibility and camera sensitivity options; **Resource packs** manages textures. The pack summary on the left also opens pack settings.

Import multiple local ZIP packs, load or unload them, and change their order. Higher packs have priority; newly imported packs go to the top. Unloaded local packs remain available for reuse. **Unload all** restores vanilla textures. Files and loading order are saved in the current browser and restored on refresh. Changing packs preserves the camera, layer and region selection.

![Resource pack settings with load, unload, ordering and local ZIP import controls](docs/images/viewer-packs.png)

> [XK redstone display](https://modrinth.com/resourcepack/xk-redstone-display) is loaded by default, displaying redstone power levels from 0 to 15.

**Controls**

- **Orbit mode** (default): left-drag to rotate, wheel to zoom, right-drag to pan.
- **Fly mode** (automatically entered with W/A/S/D): left-drag to look, W/A/S/D to move along the view direction, right-drag to pan, wheel to adjust speed, Space/Shift to move vertically.
- **E / Q**: move to the next/previous layer when using layer slicing.
- **Locate here**: set the current layer to the camera's height.
- **Fit view**: center the build while leaving room for the side panels.
- Top-right buttons: **image download** opens image export; **eye** toggles the interface; **grid** switches perspective/orthographic projection (highlighted in orthographic mode); **block catalog** opens the catalog in a new tab; **globe** switches language; **gear** opens settings; GitHub opens the repository.
- **Mobile**: bottom controls open the view and information panels as needed. In fly mode, use the lower-left joystick for movement, lower-right ▲/▼ buttons for vertical movement, and one-finger swipes to look around.

### Export PNG images

Click **Export image**, immediately to the left of Hide UI in the top-right toolbar, to enter the export studio. The loaded schematic appears automatically. Without a schematic, open or drop a file, or try the demo from the studio. The workflow takes inspiration from [Isometric Renders](https://github.com/gliscowo/isometric-renders)' isometric rendering and transparent image exports.

![Image export studio with an isometric preview on a transparency grid and composition, canvas and output settings](docs/images/image-export.png)

- Starts in an orthographic isometric view. Choose front, side, top or the viewer's current angle, switch to perspective, adjust angles, orbit, pan and zoom.
- Choose an aspect ratio, a 1K / 2K / 4K preset or custom dimensions. Fit canvas and margin controls help keep the build within the frame.
- Export with a transparent background by default, or choose a solid color. The checkerboard, thirds guides and interface controls are excluded from the PNG.
- Uses the current resource packs, selected layers and visible regions. Independently toggle entities, dimensions, region outlines and animations. Animations start paused; exports capture a single frame.
- Set a filename and click **Export PNG** to download. Return to the viewer or press Esc to exit; the original camera and display settings remain unchanged.

The default output is 2048 × 2048. Each side can be up to 8192 px, with at most 4096 × 4096 total pixels, subject to the device's rendering limits. Images are generated in the browser without an upload. On mobile, scroll down to adjust settings and export.

Developer checks: `node scripts/verify-image-export-camera.mjs` validates framing and dimension limits. After building, run `node scripts/verify-image-export.mjs` to verify real PNG downloads, alpha, 4K output, input controls, mobile layout and viewer state restoration.

## 4. Model catalog

Browse the [online model catalog](https://lwv.loafing.club/scripts/entity-preview.html?lang=en) without loading a schematic. Locally, use the viewer's catalog button or open `http://localhost:5173/scripts/entity-preview.html`.

The catalog supports All / Blocks / Mobs / Entities categories, Chinese or English names and IDs, pagination, animation pause and language switching. Settings supports loading, unloading, ordering and importing resource packs. Higher packs take priority; missing assets fall back to vanilla. XK is the default on first use; unload all packs for vanilla. Imported files, ordering and fun options are saved in the browser. Language and search filters remain in the URL, including compatibility with older `pack=xk` / `pack=vanilla` links.

Both the main viewer's **Display & controls** settings and the catalog include the “巨儒卫道士” fun toggle, disabled by default. It displays both crossed and separate arms on vindicators, evokers and illusioners. Each page remembers its own setting; changing it in the main viewer updates mobs in the current schematic immediately.

![Mob category in the catalog, with searchable cards and state inspection](docs/images/render-catalog.png)

*Choose a category or search for a name, then open a card. The catalog covers 1,289 blocks grouped into 1,167 cards, 85 mob types and five entity groups: boats, minecarts, item frames, armor stands and cushions.*

### Switch states within a card

| Object | Available variations |
| --- | --- |
| Mobs | Skins, colors, poses, continuous effects, and adult/baby forms where supported; for example normal/charged creepers or sitting kittens |
| Blocks | Vanilla block states, including 505 waterloggable blocks and wall sides with none/low/tall connections; doors, beds and double plants display complete models by default |
| Related variants | Candle cakes grouped with cakes; wall signs, banners, heads, torches and coral fans grouped with their counterparts; cauldron contents and all potted plants grouped in their respective cards |
| Boats and other entities | 22 wood/chest boat combinations, minecart types, 16 cushion colors and orientation, armor stand arms and more; armor stand arms are hidden by default |
| Riding | Select a vehicle on mob cards, or passengers on ordinary minecart, boat/raft and cushion cards, including supported baby forms; ordinary boats support two passengers and chest boats one; item and item-frame views show only the item |
| Equipment | Four armor slots, main/offhand, handedness, head items and elytra on supported mobs and armor stands; horse/wolf armor, saddles, llama carpets and happy ghast harnesses; compatible combinations of dyes, trims and enchantment glint |
| Items and item frames | Change the view to inspect the corresponding item, spawn egg or framed item; item-frame cards can filter 1,658 items |
| Special effects | Still water/lava and eight flow directions, bell ringing, enchanting table books and conduit activation/eye states |

![A cat detail card set to baby age and a sitting pose](docs/images/render-detail.png)

*Combine states using the controls on the right. Drag or zoom the model on the left. The lower-left XYZ indicator follows the camera: X east, Y up, Z south. View options include items, spawn eggs and item frames.*

Item, spawn egg and baby-form availability follows vanilla Minecraft. Invisible blocks or objects without corresponding items display an explanation. To inspect animated water, switch to vanilla textures: XK's water texture contains only one frame.

<details>
<summary>Developer notes: resources, rendering references and validation</summary>

Block controls combine resource-pack model declarations with the [26.3 generated state report archived by mcmeta](https://github.com/misode/mcmeta/blob/26.3-summary/blocks/data.json). This includes 505 waterloggable blocks, legacy chain ID compatibility, and none/low/tall wall connections. Block meshes, fluids and special block entities share the main viewer's rendering paths. Invisible blocks such as air retain catalog entries explaining their appearance. The catalog demonstrates the current renderer's capabilities and remains subject to the visual limitations below.

Names come from Minecraft 26.3's official `zh_cn.json` and `en_us.json`. Catalog settings are independent of the main viewer. Local packs are stored in IndexedDB and never uploaded. After updating the default resource version, run `node scripts/gen-inspection-data.mjs <version>` to regenerate the catalog, state reports and translations.

Cushions follow 26.3's [CushionModel](https://mc-packet-reference.netlify.app/26.x/source/net/minecraft/client/model/object/cushion/cushionmodel/) and [CushionRenderer](https://mc-packet-reference.netlify.app/26.x/source/net/minecraft/client/renderer/entity/cushionrenderer/), reading entity NBT color and orientation. All 16 colors share one catalog card with four orientations and item/item-frame views. The schematic viewer uses the same implementation.

![An armor stand wearing diamond armor and holding a diamond sword and shield](docs/images/equipment.png)

Equipment follows 26.3's [HumanoidArmorLayer](https://mc-packet-reference.netlify.app/26.x/source/net/minecraft/client/renderer/entity/layers/humanoidarmorlayer/), `EquipmentLayerRenderer`, `ItemInHandLayer` and animal-specific models. The viewer reads modern `equipment` and legacy `ArmorItems`, `HandItems`, `ArmorItem`, `DecorItem` and saddle data. Catalog controls expose individual equipment slots. Equipment follows bone poses and idle animations; baby mobs use dedicated newer armor models, while small armor stands retain vanilla scaling. Held items use third-person transforms, and tridents use 3D models. Leather dye, wolf armor damage and trims read item components and resource packs. Enchantment glint approximates vanilla texture blending and currently applies to worn equipment. Run `node scripts/gen-equipment-data.mjs --fetch` to update model data and default equipment components with recorded sources and SHA-256 hashes.

Equipment controls appear only when applicable: leather equipment, leather horse armor and wolf armor can be dyed; trim materials appear after choosing a trim; damage, glint and handedness are conditional. Baby animals hide unsupported body armor and saddles. Cat/wolf collar colors appear only when tamed. Removing compatible equipment clears its preview options; dyes and trims affect only applicable slots in mixed sets.

Special blocks reference 26.3's `BellModel`, `BannerRenderer`, `TheEndPortalRenderer`, `TheEndGatewayRenderer`, enchanting table and conduit renderers. Bells include their body, banner cloth swings around its crossbar, and framed banners use the item's fixed display transform. End portals use top/bottom horizontal surfaces; gateways use a cube. Both use projection sampling and layered stars based on the [official end portal shader](https://github.com/misode/mcmeta/blob/26.3-assets/assets/minecraft/shaders/core/rendertype_end_portal.fsh). Texture animation supports `.mcmeta` frame order, duration, dimensions and color interpolation for water, lava, fire, nether portals and other textures. The catalog pause button pauses textures, blocks and entities together.

### Mob rendering reference notes

Continuous effects and idle poses follow vanilla `EntityModel.setAngles`, keyframes and `FeatureRenderer`. The baseline is a [pinned 1.21.11 source mirror](https://github.com/duollectis/minecraft-decompiled-1.21.11/tree/b4cb28a04035b7a190aaf74d4b9ba5ed11095cbb/src/main/java/net/minecraft/client/render/entity), while retaining newer rabbit models and blaze rod layouts transcribed from the 26.3 client. Default textures are still 26.3; migration of all model differences between these versions is incomplete.

| Area | Current implementation |
| --- | --- |
| Scrolling/emissive layers | Breeze wind and eyes, charged creeper shield, half-health wither armor, warden heartbeat/spots, glowing eyes, glow squid and `jeb_` rainbow sheep |
| Continuous idle motion | Blaze rods, ghast/squid tentacles, phantom/bee/allay/vex/bat wings, fish fins/tails, guardian spikes/tail, strider bristles, silverfish/endermite movement, biped arms, piglin ears, witch noses, warden breathing and wither bodies |
| State-dependent idles | Axolotls on land/in water, frogs in water, camel idle/sitting, copper golem head turns, curled armadillos, fox sleeping, airborne parrots/chickens, shulker opening/head/color/attachment, and dragon wings/jaw |
| Additional layers | Slime cores/translucent shells, sheep wool/undercoat, tropical fish colors/patterns, three pufferfish sizes, drowned/stray/bogged outer layers, villager clothing, iron golem cracks, tame-animal collars, mooshroom mushrooms and snow golem pumpkins |
| Models and states | Cave spider/wither skeleton/husk/cat/horse/villager/illager scale; unarmed/crossbow pillager arms; resting boat/raft paddles; donkey/mule ears/chests; llama chest visibility; cat/wolf sitting; fox sleeping; shulker states; extra armadillo parts; missing goat horns; turtle egg bellies |

Animation time advances at 20 ticks per second. Poses use saved NBT and water blocks in the structure. Random idle phases use stable seeds because unsaved client animation phases cannot be recovered. Mobs without continuous idle motion keep vanilla static poses. The viewer does not simulate AI, movement, attacks, particles, transient events or the ender dragon's historical flight path.

Warden tendrils follow 26.3's [WardenModel](https://mc-packet-reference.netlify.app/26.x/source/net/minecraft/client/model/monster/warden/wardenmodel/) and [ModelPart.Cube](https://mc-packet-reference.netlify.app/26.x/source/net/minecraft/client/model/geom/modelpart/). The fix for horizontally flipped UVs on merged zero-thickness planes also applies to axolotl gills, wings, fins and shared parts. Planes omit overlapping and zero-area faces; inflated parts with thickness, such as hoglin manes, retain six faces. Top/bottom normals are corrected consistently.

Baby forms use 27 dedicated 26.3 models, specific textures and axolotl/camel/armadillo idle keyframes. Sniffers and happy ghasts use vanilla scaling, and happy ghast babies retain their inner core. Baby cat, wolf and fox sitting/sleeping poses also follow the newer models. Generated data records exact [client source mirror](https://mc-packet-reference.netlify.app/26.x/source/net/minecraft/client/model/animal/cow/babycowmodel/) URLs and SHA-256 hashes. Use `node scripts/gen-baby-models.mjs --fetch` and `node scripts/gen-baby-animations.mjs --fetch` to fetch and transcribe again.

Confirmed remaining differences: warm/cold cow, pig and chicken variants change textures without selecting their dedicated geometry; villager hats do not yet read resource-pack hat metadata; specialized item layers such as fox-held items and panda eating, held-item glint, custom equipped player-head skins, leashes and some riding combinations are incomplete. Held items currently cover armor stands, humanoid armored mobs, pillagers, allays and vexes, without item-use, attack or bow-drawing animations. Static schematics cannot reproduce dynamic game lighting or entity interactions. Catalog bell, book and conduit states are explicit demonstrations; player proximity, conduit frame detection, temporary gateway beams and particles are not simulated.

Validation commands, after installing default resources with `npm run setup`:

```bash
node scripts/verify-entities.mjs          # Mobs/states, textures, bind poses, animation drift, isolation/disposal
node scripts/verify-entity-planes.mjs     # Plane UVs, mirroring/inflation, normals, warden and extra arms
node scripts/verify-inspection-packs.mjs  # ZIP/BOM validation, wrapper directories, priority and vanilla fallback
node scripts/verify-viewer-packs.mjs      # Persistence, imports, replacement, failure recovery and embed presets
node scripts/verify-viewer-framing.mjs    # Portrait/landscape, panel insets and varied structure sizes
node scripts/verify-equipment.mjs        # Equipment, NBT formats, baby/small models, poses, dyes and animals
node scripts/verify-breeze.mjs           # Wind geometry, UVs, transparency and scrolling
node scripts/verify-shulker.mjs          # Shared shulker box geometry
node scripts/verify-waxed-items.mjs      # XK's 60 waxed items, frame outlines and vanilla fallback
node scripts/verify-render-inspection.mjs # Catalog/names, 626 entity states, multiblock states and geometry
node scripts/verify-cushion.mjs          # Colors, dimensions, UVs, orientation, NBT and item mapping
node scripts/verify-special-rendering.mjs # Special blocks, grouping, flow, babies, items and languages
npm run build
```

`src/entityAnimationData.js` already includes runtime keyframes. To regenerate them, place `Breeze/Bat/Camel/Frog/CopperGolem/ArmadilloAnimations.java` from the pinned source revision into `scripts/_ref/`, then run `node scripts/gen-entity-animations.mjs`. Running the website does not require these Java files.

</details>

## 5. Known limitations

- Very large schematics, roughly over 20 million blocks, report “file too large”: browser memory cannot hold all blocks and merged geometry.
- Without biome data, grass, foliage and vines use default colors instead of vanilla biome gradients.
- Some model corners, `uvlock` cases and extreme rotation combinations may differ slightly from vanilla.
- Some textures in very old saves may differ slightly.

## 6. Project layout

```text
src/
  main.js              File loading, drag/drop, resource packs and UI wiring
  embed.js / embed.css Embedded card entry and styles
  embedSdk.js          Customizable SDK source (built as public/embed.js)
  previewOptions.js    Shared option validation and themes
  embedConfigurator.js Style configurator and integration code generator
  embedProtocol.js     Downloads, cross-window transfer and parameter validation
  schematicDetails.js  Shared block entity extraction for the full viewer and cards
  nbt.js               Binary NBT parsing and gzip/zlib decompression
  litematica.js        Schematic parsing, bit decoding and region normalization
  blocks.js            Blockstate to model resolution, including multipart/variants
  modelBaker.js        Model JSON to baked faces/quads
  geometry.js          Hidden-face culling and geometry batching by texture
  renderer.js          Three.js camera, materials, entities and underwater fog
  entities.js          Entity models: minecarts, boats, item frames and more
  entityModel.js       Entity geometry, bones and transparent face ordering
  entityAppearance.js  Mob skins, NBT states and additional layers
  entityAnimations.js / entityAnimationData.js   Vanilla idle formulas and keyframes
  entityModelData.js / extraEntityModels.js     Model data
  entityBabies.js / babyEntityModels.js / babyAnimationData.js   26.3 babies and animation
  blockEffects.js      Bells, books, conduits and end portal shaders
  textureAnimation.js  Vanilla texture frame tables and interpolation
  assets.js            Vanilla resources and pack overrides
  ui.js                UI updates
  i18n.js              Chinese/English strings
  blockNames.js        Generated block translations
  fluidFlowBlocks.js   Generated fluid-blocking block set
  styles.css           Styles
scripts/
  fetch-assets.mjs      Download official resources
  gen-block-names.mjs   Generate block translations
  gen-fluid-flow-blocks.mjs   Generate BLOCKS_FLUID_FLOW
  gen-test.mjs          Generate test samples
  copy-packs.mjs        Copy resource packs
  verify-*.mjs / bench-pipeline.mjs   Development checks and benchmarks
public/
  embed.js             Standalone integration ES module
  assets/minecraft/    Official textures, models and blockstates
  fonts/               Pixel font
  demo.litematic        Deployed sample
resourcepacks/         Available resource packs
docs/images/           Actual page screenshots for the README
embed.html             iframe entry
embed-example.html     Interactive examples of both integration methods
```

### Search indexing and deployment

The viewer and catalog have separate titles, descriptions, canonical URLs, sharing metadata and JSON-LD. The [sitemap](https://lwv.loafing.club/sitemap.xml) lists only these two official pages; search, pagination and resource-pack parameters are not submitted as separate pages. Embed and example pages use `noindex` and are excluded from the sitemap to avoid indexing duplicate schematic preview URLs.

After GitHub Pages deploys successfully, `notify-search` uses [IndexNow](https://www.indexnow.org/documentation) to notify Bing and other participating search engines. `public/indexnow-key.txt` is a public ownership verification file, checked on the live site before submission. Results appear in Actions logs and summaries. HTTP 200 means received; 202 means received with verification pending. Neither confirms indexing. Manual checks/submission:

```bash
node scripts/submit-indexnow.mjs --dry-run  # Validate scope without sending a request
node scripts/submit-indexnow.mjs            # Submit after deployment
```

For Google, add `https://lwv.loafing.club/` as a URL-prefix property in [Search Console](https://search.google.com/search-console), verify ownership using the homepage HTML tag, and submit `sitemap.xml`. URL Inspection can request crawling of the viewer and catalog. [Verification documentation](https://support.google.com/webmasters/answer/9008080) · [Sitemap documentation](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap).

The official domain is `https://lwv.loafing.club/`, configured as the GitHub Pages custom domain. The old GitHub Pages URL redirects here. [robots.txt](https://lwv.loafing.club/robots.txt) is at the domain root, permits crawling and declares the sitemap. Cloudflare may add its managed text to the response; the repository maintains only this site's crawl and sitemap rules. [robots.txt location rules](https://developers.google.com/crawling/docs/robots-txt/robots-txt-spec).

Choose the `https://lwv.loafing.club/` URL-prefix property or a verified `loafing.club` domain property in Search Console. The old GitHub Pages property does not rename itself. A domain migration requires updating canonical/sharing URLs, structured data, robots.txt, the sitemap and submission scripts together. Forks do not automatically notify IndexNow for the original site.

## 7. References and acknowledgments

- [Litematica](https://github.com/maruohon/litematica): source of the schematic format and Minecraft building blueprint mod.
- [prismarine-viewer](https://github.com/PrismarineJS/prismarine-viewer): primary reference for model baking, face corners, UV rotation and variant transforms.
- [litematic-viewer](https://github.com/endingcredits/litematic-viewer): another browser-based schematic viewer.

**Default resource pack:** [XK redstone display](https://modrinth.com/resourcepack/xk-redstone-display), which displays redstone power levels from 0 to 15.

**Libraries:** [Three.js](https://threejs.org/) for 3D rendering, [JSZip](https://stuk.github.io/jszip/) for resource-pack decompression, and [Vite](https://vite.dev/) for builds.

**Game assets:** default textures and models are extracted from the official Minecraft `client.jar`, downloaded by `npm run setup` (26.3 by default).
