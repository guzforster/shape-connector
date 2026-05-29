# Shape Connector

> **Beta — v0.2.0.** This plugin is in active development. Expect rough edges, breaking changes between versions, and the occasional bug. Feedback and issue reports are very welcome.

A Figma plugin that connects any shape to any other shape with a line that stays attached when you move the shapes.

<p align="center">
  <img src="assets/cover.png" alt="Shape Connector cover" width="800" />
</p>

## Features

- **Connect any shape** — select two or more shapes and click **Connect**. Connectors are drawn as a chain: `A → B → C → …`.
- **Lines that follow** — connectors auto-reroute as you drag shapes around, and snap into final position the moment you release.
- **Three line styles** — Orthogonal (right-angle), Curved (S-bezier), or Straight.
- **Six endpoint shapes per end** — None, Arrow, Filled circle, Hollow circle, Filled square, Hollow square. Source and target are configured independently.
- **Per-connector styling** — color, line width (0.5–20 px), endpoint size (4–60 px). All controls work on a single selected connector or a multi-selection.
- **Editing existing connectors** — select any connector on the canvas; the panel switches into "Editing N connectors" mode and any control change applies to the selection.
- **Minimize to corner** — collapse the UI to a slim strip docked at the bottom-right of the viewport, so the plugin can keep running and gets out of your way while you work.
- **Persistent across sessions** — connections are stored in the file (`figma.root.pluginData`), so they survive plugin reload and reopening the file.

## Install

### From source (development)

You need [Node.js](https://nodejs.org/) (16+) and the [Figma desktop app](https://www.figma.com/downloads/). The in-browser editor doesn't load local plugins.

```sh
git clone https://github.com/guzforster/shape-connector.git
cd shape-connector
npm install
npm run build
```

Then in Figma desktop:

1. **Menu → Plugins → Development → Import plugin from manifest…**
2. Pick `manifest.json` from this folder.
3. The plugin appears under **Plugins → Development → Shape Connector**.

### From the Figma Community

*Coming soon — this plugin is being prepared for Community submission.*

## Use

1. Open any Figma Design file and run the plugin.
2. Select **two or more shapes** on the canvas.
3. (Optional) Pick a line style, endpoint shapes, color, line width, and endpoint size in the panel.
4. Click **Connect selected shapes**.

To **edit** a connector after creating it: click the connector group on the canvas. The panel header switches to "Editing x connector(s)" and reflects its current style. Change any control to apply the new style in place.

To **delete** a connector: select it and click **Delete selected connectors**.

To **minimize**: click the `_` button at the top-right of the panel. It collapses to a thin strip in the bottom-right corner and keeps running in the background (necessary to keep the connectors updating as you move the shapes).

## Project layout

```
manifest.json     Figma plugin manifest
code.ts           Plugin sandbox code (compiles to code.js)
code.js           Compiled output — what Figma actually loads
ui.html           Plugin panel UI
tsconfig.json     TypeScript config
package.json      npm scripts + Figma plugin typings
assets/
  icon.png        128x128 plugin icon
  cover.png       1920x960 cover image for the Community listing
```

## Development

```sh
npm run watch     # rebuild code.js on every save
```

Reload the plugin in Figma after each rebuild — either re-run it from the Plugins menu, or use `Ctrl+Alt+P` (Windows) / `Cmd+Option+P` (Mac) to rerun the last plugin.

## Roadmap

- [ ] Labels on connectors (text along or beside the line)
- [ ] Multiple routing flavours for orthogonal (e.g. avoid other shapes)
- [ ] Dashed/dotted stroke styles

## Contributing

Bug reports and pull requests welcome at <https://github.com/guzforster/shape-connector/issues>.

## Known issues

- **Orthogonal style with non-rectangular shapes.** The orthogonal (right-angle) routing always enters and exits each shape via its axis-aligned bounding box, not the actual outline. For stars, irregular polygons, and other non-rectangular shapes this can leave the line floating outside the shape rather than landing on an edge or vertex. As a workaround, use the **Curved** or **Straight** styles when at least one endpoint is a non-rectangular shape — both honour the actual outline and snap to vertex/midpoint candidates.

## License

[MIT](LICENSE) © Gustavo Forster
