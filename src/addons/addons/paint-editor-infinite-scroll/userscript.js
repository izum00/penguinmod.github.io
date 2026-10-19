export default async function ({ addon, console }) {
  const paper = await addon.tab.traps.getPaper();
  const vm = addon.tab.traps.vm;
  const s = addon.settings;
  addon.tab.redux.initialize();

  const BIG = 1e7;
  const CORE_MIN_ZOOM = 0.333; // OUTERMOST_ZOOM_LEVEL in the core
  const CROSSHAIR_SIZE = 16; // CROSSHAIR_SIZE in the core
  const CELL = 8; // checkerboard cell size (art board units)
  const PERIOD = CELL * 2;
  const TILE_OPACITY = 0.55;
  const MAX_TILE_POINTS = 20000;

  let enabled = !!s.get("enable-default");
  let prevDefault = enabled;
  let allowOnce = false; // lets exactly one scrollBy call through
  let passing = false; // true while dispatching our own synthetic wheel event
  let wasActive = false;
  let translateUsesScrollBy = false;
  let gridDirty = true;

  const hasView = () => !!(paper.project && paper.project.view && paper.project.view.element);
  const isActive = () => !addon.self.disabled && enabled && hasView();
  const isVectorFormat = () => {
    const f = addon.tab.redux.state?.scratchPaint?.format;
    return typeof f === "string" ? f.startsWith("VECTOR") : true;
  };

  // ---------- Synthetic wheel events (the core wheel handler does the actual work) ----------
  const dispatchWheel = (deltaX, deltaY, ctrlKey, clientX, clientY) => {
    if (!hasView()) return;
    const canvas = paper.view.element;
    const r = canvas.getBoundingClientRect();
    passing = true;
    try {
      canvas.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaX,
          deltaY,
          deltaMode: 0,
          ctrlKey: !!ctrlKey,
          clientX: clientX ?? r.left + r.width / 2,
          clientY: clientY ?? r.top + r.height / 2,
        })
      );
    } finally {
      passing = false;
    }
  };
  // A zero-delta pan makes the core recompute the workspace bounds and update the scrollbars.
  const refresh = () => dispatchWheel(0, 0, false);

  // ---------- 1. view.scrollBy / view.center ----------
  const findDescriptor = (obj, key) => {
    for (let o = obj; o; o = Object.getPrototypeOf(o)) {
      const d = Object.getOwnPropertyDescriptor(o, key);
      if (d) return d;
    }
    return null;
  };
  // Checks whether view.translate() goes through view.scrollBy() internally.
  const detectTranslateUsesScrollBy = (view) => {
    if (typeof view.translate !== "function") return false;
    let called = false;
    const original = view.scrollBy;
    view.scrollBy = function (...args) {
      called = true;
      return original.apply(this, args);
    };
    try {
      view.translate(new paper.Point(0, 0));
    } catch (e) {
      // ignore
    }
    view.scrollBy = original;
    return called;
  };
  const installView = (view) => {
    if (view.__saInfiniteInstalled) return;
    view.__saInfiniteInstalled = true;
    wasActive = false;
    translateUsesScrollBy = detectTranslateUsesScrollBy(view);
    const origScrollBy = view.scrollBy;
    view.scrollBy = function (...args) {
      if (!isActive()) return origScrollBy.apply(this, args);
      if (allowOnce) {
        allowOnce = false;
        return origScrollBy.apply(this, args);
      }
      return this; // swallow the core's "push the view back into the workspace" scrolling
    };
    const centerDesc = findDescriptor(view, "center");
    if (centerDesc && centerDesc.get && centerDesc.set) {
      Object.defineProperty(view, "center", {
        configurable: true,
        get() {
          return centerDesc.get.call(this);
        },
        set(v) {
          if (!isActive()) return centerDesc.set.call(this, v);
          // Intentional center changes (e.g. zoom to fit) are allowed.
          origScrollBy.call(this, new paper.Point(v).subtract(centerDesc.get.call(this)));
        },
      });
    }
  };

  // ---------- 2. Enlarge MAX_WORKSPACE_BOUNDS (found by hooking Rectangle#expand) ----------
  let maxRect = null;
  let maxOrig = null;
  const applyMax = (active) => {
    if (!maxRect || !maxOrig) return;
    if (active) {
      maxRect.x = -BIG;
      maxRect.y = -BIG;
      maxRect.width = BIG * 2;
      maxRect.height = BIG * 2;
    } else {
      maxRect.x = maxOrig.x;
      maxRect.y = maxOrig.y;
      maxRect.width = maxOrig.width;
      maxRect.height = maxOrig.height;
    }
  };
  const rectProto = paper.Rectangle.prototype;
  const origExpand = rectProto.expand;
  rectProto.expand = function (...args) {
    if (this !== maxRect) {
      const w = vm.runtime.stageWidth * 2;
      const h = vm.runtime.stageHeight * 2;
      if (this.x === -w / 4 && this.y === -h / 4 && this.width === w * 1.5 && this.height === h * 1.5) {
        maxRect = this;
        maxOrig = { x: this.x, y: this.y, width: this.width, height: this.height };
        if (isActive()) applyMax(true);
      }
    }
    return origExpand.apply(this, args);
  };

  // ---------- 3. Clip mask of the painting layer (vector only) ----------
  // In bitmap mode the mask matches the raster and must stay as it is.
  let maskCache = null;
  const findMask = () => {
    const layer = paper.project.layers.find((l) => l.data && l.data.isPaintingLayer);
    if (!layer) return null;
    if (maskCache && maskCache.parent === layer && maskCache.clipMask) return maskCache;
    maskCache = null;
    for (let i = layer.children.length - 1; i >= 0; i--) {
      const c = layer.children[i];
      if (c.clipMask && c.guide && c.locked) {
        maskCache = c;
        break;
      }
    }
    return maskCache;
  };
  const applyMask = (active) => {
    if (!isVectorFormat()) return;
    const mask = findMask();
    if (!mask) return;
    if (active) {
      if (mask.size.width < BIG) mask.size = new paper.Size(BIG * 2, BIG * 2);
    } else if (mask.size.width >= BIG) {
      mask.size = new paper.Size(vm.runtime.stageWidth * 2 * 1.5, vm.runtime.stageHeight * 2 * 1.5);
    }
  };

  // ---------- 4. Infinite checkerboard grid ----------
  let grid = null;
  const getBackgroundLayer = () =>
    paper.project.layers.find((l) => l.data && l.data.isBackgroundGuideLayer);

  const readColors = () => {
    const layer = getBackgroundLayer();
    const vb = layer && layer.vectorBackground;
    const pick = (getter, fallback) => {
      try {
        const c = getter();
        return c ? c.toCSS(true) : fallback;
      } catch (e) {
        return fallback;
      }
    };
    return {
      workspace: pick(() => vb.children[0].fillColor, "#ECF1F9"),
      white: pick(() => vb.children[1].children[0].fillColor, "#FFFFFF"),
      tile: pick(() => vb.children[1].children[1].fillColor, "#D9E3F2"),
    };
  };
  // Phase of the original checkerboard: a cell is shaded when (col + row) % 2 === parity.
  // Read from the original path so our grid lines up with it exactly.
  const readParity = () => {
    const layer = getBackgroundLayer();
    try {
      const path = isVectorFormat()
        ? layer.vectorBackground.children[1].children[1]
        : layer.bitmapBackground.children[1];
      const o = path.localToGlobal(path.firstSegment.point);
      return (Math.round(o.x / CELL) + Math.round(o.y / CELL)) & 1;
    } catch (e) {
      return isVectorFormat() ? 1 : 0;
    }
  };

  const ensureGrid = (layer) => {
    if (grid && grid.group.parent === layer) return grid;
    if (grid) grid.group.remove();
    const group = new paper.Group({ insert: false });
    group.guide = true;
    group.locked = true;
    layer.addChild(group);
    if (layer.dragCrosshair) group.insertBelow(layer.dragCrosshair);
    grid = {
      group,
      fill: null,
      white: null,
      tiles: null,
      block: null,
      parity: -1,
      artW: 0,
      artH: 0,
      tilesOn: null,
      colors: {},
    };
    return grid;
  };

  const buildCheckerPoints = (ox, oy, cols, rows) => {
    // Same zigzag trick as the core: with the even-odd rule it forms a checkerboard.
    const pts = [];
    let x = 0;
    let y = 0;
    while (x < cols) {
      pts.push(new paper.Point(ox + x * CELL, oy + y * CELL));
      x++;
      pts.push(new paper.Point(ox + x * CELL, oy + y * CELL));
      y = y === 0 ? rows : 0;
    }
    y = rows - 1;
    x = cols;
    while (y > 0) {
      pts.push(new paper.Point(ox + x * CELL, oy + y * CELL));
      x = x === 0 ? cols : 0;
      pts.push(new paper.Point(ox + x * CELL, oy + y * CELL));
      y--;
    }
    return pts;
  };

  const rebuildGrid = (g, vb, parity, artW, artH, tilesOn) => {
    const span = Math.max(vb.width, vb.height);
    const x0 = Math.floor((vb.left - span) / PERIOD) * PERIOD - PERIOD;
    const y0 = Math.floor((vb.top - span) / PERIOD) * PERIOD - PERIOD;
    const x1 = Math.ceil((vb.right + span) / PERIOD) * PERIOD + PERIOD;
    const y1 = Math.ceil((vb.bottom + span) / PERIOD) * PERIOD + PERIOD;
    const cols = (x1 - x0) / CELL - parity * 2; // keep column and row counts even
    const rows = (y1 - y0) / CELL;

    const style = (item) => {
      item.guide = true;
      item.locked = true;
      item.strokeColor = null;
      return item;
    };
    const fill = style(new paper.Path.Rectangle({ from: [x0, y0], to: [x1, y1], insert: false }));
    const white = style(new paper.Path.Rectangle({ point: [0, 0], size: [artW, artH], insert: false }));
    const tiles = style(
      new paper.Path({
        segments: buildCheckerPoints(x0 + parity * CELL, y0, cols, rows),
        fillRule: "evenodd",
        insert: false,
      })
    );
    tiles.opacity = TILE_OPACITY;
    tiles.visible = tilesOn && cols + rows <= MAX_TILE_POINTS;

    g.group.removeChildren();
    g.group.addChildren([fill, white, tiles]);
    g.fill = fill;
    g.white = white;
    g.tiles = tiles;
    g.block = { x0: x0 + PERIOD, y0: y0 + PERIOD, x1: x1 - PERIOD, y1: y1 - PERIOD };
    g.parity = parity;
    g.artW = artW;
    g.artH = artH;
    g.tilesOn = tilesOn;
    g.colors = {};
  };

  const needsRebuild = (g, vb, parity, artW, artH, tilesOn) => {
    const b = g.block;
    if (!b || !g.fill) return true;
    if (g.parity !== parity || g.artW !== artW || g.artH !== artH || g.tilesOn !== tilesOn) return true;
    if (vb.left < b.x0 || vb.top < b.y0 || vb.right > b.x1 || vb.bottom > b.y1) return true;
    return b.x1 - b.x0 > Math.max(vb.width, vb.height) * 12; // zoomed in a lot: shrink the block
  };

  const updateGrid = () => {
    if (!hasView()) return;
    const layer = getBackgroundLayer();
    if (!layer) return;
    const want = isActive() && !!s.get("infinite-grid");
    if (!want) {
      if (grid && grid.group.parent === layer) grid.group.visible = false;
      return;
    }
    const g = ensureGrid(layer);
    g.group.visible = true;

    const vb = paper.view.bounds;
    const parity = readParity();
    const artW = vm.runtime.stageWidth * 2;
    const artH = vm.runtime.stageHeight * 2;
    const tilesOn = CELL * paper.view.zoom >= 2; // skip sub-pixel cells
    if (needsRebuild(g, vb, parity, artW, artH, tilesOn)) {
      rebuildGrid(g, vb, parity, artW, artH, tilesOn);
    }

    const c = readColors();
    if (g.colors.workspace !== c.workspace) g.fill.fillColor = c.workspace;
    if (g.colors.white !== c.white) g.white.fillColor = c.white;
    if (g.colors.tile !== c.tile) g.tiles.fillColor = c.tile;
    g.colors = c;
  };

  // Poll the view transform each frame (paper has no "view moved" event).
  let lastSig = [];
  let warned = false;
  const loop = () => {
    requestAnimationFrame(loop);
    try {
      if (!hasView()) return;
      const m = paper.view.matrix;
      const vs = paper.view.viewSize;
      const sig = [m.a, m.b, m.c, m.d, m.tx, m.ty, vs.width, vs.height];
      if (!gridDirty && sig.every((v, i) => v === lastSig[i])) return;
      lastSig = sig;
      gridDirty = false;
      updateGrid();
    } catch (e) {
      if (!warned) {
        warned = true;
        console.error(e);
      }
    }
  };
  requestAnimationFrame(loop);

  // ---------- State sync ----------
  const sync = () => {
    if (!hasView()) return;
    installView(paper.project.view);
    const active = isActive();
    applyMax(active);
    applyMask(active);
    gridDirty = true;
    if (active !== wasActive) {
      wasActive = active;
      refresh();
      refresh(); // the first call captures the Rectangle, the second recomputes the range
    }
  };
  let scheduled = false;
  const scheduleSync = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      sync();
    });
  };
  addon.tab.redux.addEventListener("statechanged", scheduleSync);
  addon.self.addEventListener("disabled", scheduleSync);
  addon.self.addEventListener("reenabled", scheduleSync);

  // ---------- Zoom ----------
  const zoomStep = (z) =>
    0.5 * (s.get("zoom-speed") / 100) * Math.pow(z / 0.5, s.get("zoom-correction") / 100);
  const clampZoom = (z) => {
    const minZ = s.get("min-zoom") / 100;
    let maxZ = s.get("max-zoom") / 100;
    maxZ = maxZ > 0 ? Math.max(maxZ, minZ) : Infinity;
    return Math.max(minZ, Math.min(maxZ, z));
  };
  // Zoom out is the inverse of zoom in, so the buttons are reversible.
  const nextButtonZoom = (z, zoomIn) => {
    if (zoomIn) {
      let t = z + zoomStep(z);
      if (z < 0.5 - 1e-6 && t > 0.5) t = 0.5; // keep the default zoom as a stop, like the original
      return Math.max(z, clampZoom(t));
    }
    let lo = 0;
    let hi = z;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (mid + zoomStep(mid) > z) hi = mid;
      else lo = mid;
    }
    return Math.min(z, clampZoom((lo + hi) / 2));
  };

  // Zoom below the core's minimum level, which the core cannot do by itself.
  const ownZoom = (target, clientX, clientY) => {
    const view = paper.view;
    const rect = view.element.getBoundingClientRect();
    const fixedPoint = view.viewToProject(new paper.Point(clientX - rect.left, clientY - rect.top));
    const preCenter = view.center;
    const scaling = view.zoom / target;
    const preOffset = fixedPoint.subtract(preCenter);
    const postOffset = fixedPoint.subtract(preOffset.multiply(scaling)).subtract(preCenter);
    view.zoom = target;
    allowOnce = translateUsesScrollBy;
    view.translate(postOffset.multiply(-1));
    allowOnce = false;
    for (const layer of paper.project.layers) {
      if (layer.dragCrosshair) {
        layer.dragCrosshair.scale(CROSSHAIR_SIZE / layer.dragCrosshair.bounds.width / view.zoom);
      }
    }
    refresh();
    addon.tab.redux.dispatch({ type: "scratch-paint/select/REDRAW_SELECTION_BOX" });
  };

  const applyZoom = (target, clientX, clientY) => {
    const view = paper.view;
    if (target >= CORE_MIN_ZOOM) {
      // The core adds deltaY / -500 to the zoom, so send exactly the delta we need.
      allowOnce = translateUsesScrollBy;
      dispatchWheel(0, -(target - view.zoom) * 500, true, clientX, clientY);
      allowOnce = false;
    } else {
      ownZoom(target, clientX, clientY);
    }
  };

  // Anchor for the zoom buttons: the center of the selection, or the center of the view.
  const getZoomAnchorClient = () => {
    const view = paper.view;
    const rect = view.element.getBoundingClientRect();
    try {
      const layer = paper.project.layers.find((l) => l.data && l.data.isPaintingLayer);
      const items = paper.project.selectedItems.filter((i) => i.parent === layer);
      if (items.length) {
        let b = items[0].bounds;
        for (const item of items) b = b.unite(item.bounds);
        const p = view.projectToView(b.center);
        return { x: rect.left + p.x, y: rect.top + p.y };
      }
    } catch (e) {
      // fall through to the view center
    }
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  };

  // Wheel: ctrl/pinch zoom is handled here, plain wheel only needs to be allowed to scroll.
  window.addEventListener(
    "wheel",
    (e) => {
      if (passing || !isActive() || e.target !== paper.view.element) return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const view = paper.view;
        const mult = e.deltaMode === 1 ? 15 : 1;
        const base = -(e.deltaY * mult) / 500; // same formula as the core
        if (!base) return;
        const scaled = base * (s.get("zoom-speed") / 100) * Math.pow(view.zoom / 0.5, s.get("zoom-correction") / 100);
        let target = clampZoom(view.zoom + scaled);
        target = scaled > 0 ? Math.max(view.zoom, target) : Math.min(view.zoom, target);
        if (target !== view.zoom) applyZoom(target, e.clientX, e.clientY);
      } else {
        allowOnce = true; // only the first scrollBy of the core pan() may pass
        setTimeout(() => {
          allowOnce = false;
        }, 0);
      }
    },
    { capture: true, passive: false }
  );

  // Zoom in / zoom out buttons (index 1 is the "reset zoom" button, which is left alone).
  window.addEventListener(
    "click",
    (e) => {
      if (!isActive() || e.button !== 0) return;
      const t = e.target;
      if (!(t instanceof Element)) return;
      const controls = t.closest("[class*='paint-editor_zoom-controls']");
      if (!controls) return;
      const group = controls.firstElementChild;
      if (!group) return;
      const index = Array.from(group.children).findIndex((b) => b.contains(t));
      if (index !== 0 && index !== 2) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const target = nextButtonZoom(paper.view.zoom, index === 2);
      if (target === paper.view.zoom) return;
      const p = getZoomAnchorClient();
      applyZoom(target, p.x, p.y);
    },
    true
  );

  // ---------- Scrollbar thumbs follow the cursor ----------
  window.addEventListener(
    "mousedown",
    (e) => {
      if (!isActive() || e.button !== 0) return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      const hitbox = target.closest("[class*='scrollbar-hitbox']");
      if (!hitbox) return;
      const track = hitbox.parentElement;
      if (!track) return;
      const horizontal = /horizontal/.test(hitbox.className);
      const hb = hitbox.getBoundingClientRect();
      const tb = track.getBoundingClientRect();
      const thumbLen = horizontal ? hb.width : hb.height;
      const trackLen = horizontal ? tb.width : tb.height;
      if (!thumbLen || thumbLen >= trackLen * 0.995) return; // everything is visible: use the core behavior

      e.preventDefault();
      e.stopImmediatePropagation();

      // Fixed at drag start: view units per thumb pixel (= workspace length / track length).
      const unitsPerPx = (horizontal ? paper.view.bounds.width : paper.view.bounds.height) / thumbLen;
      let last = horizontal ? e.clientX : e.clientY;

      const onMove = (ev) => {
        const cur = horizontal ? ev.clientX : ev.clientY;
        const units = (cur - last) * unitsPerPx;
        last = cur;
        if (!units) return;
        const d = units * paper.view.zoom; // the core divides by zoom
        allowOnce = true;
        dispatchWheel(horizontal ? d : 0, horizontal ? 0 : d, false);
        allowOnce = false;
        ev.preventDefault();
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    true
  );

  // ---------- Button ----------
  const group = document.createElement("div");
  group.className = "sa-paint-infinite-group";
  addon.tab.displayNoneWhileDisabled(group);

  const button = document.createElement("span");
  button.className = "sa-paint-infinite-button";
  button.setAttribute("role", "button");
  button.title = "Infinite scroll";
  button.dataset.enabled = enabled;

  const img = document.createElement("img");
  img.className = "sa-paint-infinite-image";
  img.draggable = false;
  img.src = addon.self.getResource("/icons/infinite.svg") /* rewritten by pull.js */;
  button.appendChild(img);
  group.appendChild(button);

  button.addEventListener("click", () => {
    enabled = !enabled;
    button.dataset.enabled = enabled;
    sync();
  });

  const updateVisibility = () => {
    group.dataset.hidden = String(!s.get("show-button"));
  };
  s.addEventListener("change", () => {
    const d = !!s.get("enable-default");
    if (d !== prevDefault) {
      prevDefault = d;
      enabled = d;
      button.dataset.enabled = enabled;
    }
    updateVisibility();
    sync();
  });
  updateVisibility();
  sync();

  // ---------- Place the button next to the zoom controls ----------
  let hasRunOnce = false;
  while (true) {
    const canvasControls = await addon.tab.waitForElement("[class^='paint-editor_canvas-controls']", {
      markAsSeen: true,
      reduxEvents: [
        "scratch-gui/navigation/ACTIVATE_TAB",
        "scratch-gui/mode/SET_PLAYER",
        "fontsLoaded/SET_FONTS_LOADED",
        "scratch-gui/locales/SELECT_LOCALE",
        "scratch-gui/targets/UPDATE_TARGET_LIST",
      ],
      reduxCondition: (state) =>
        state.scratchGui.editorTab.activeTabIndex === 1 && !state.scratchGui.mode.isPlayerOnly,
    });
    const zoomControlsContainer = canvasControls.querySelector("[class^='paint-editor_zoom-controls']");
    addon.tab.appendToSharedSpace({
      space: "paintEditorZoomControls",
      element: group,
      order: 3,
    });
    if (!hasRunOnce) {
      hasRunOnce = true;
      const groupClass = zoomControlsContainer.firstChild.className;
      const buttonClass = zoomControlsContainer.firstChild.firstChild.className;
      const imageClass = zoomControlsContainer.firstChild.firstChild.firstChild.className;
      group.className += " " + groupClass;
      button.className += " " + buttonClass;
      img.className += " " + imageClass;
    }
    sync();
  }
}