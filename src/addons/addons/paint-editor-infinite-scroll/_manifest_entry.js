const manifest = {
  "editorOnly": true,
  "noTranslations": true,
  "name": "Costume editor infinite scroll",
  "description": "Removes the limits on the drawing area and scrolling range when editing vectors and bitmaps. The minimum and maximum zoom levels, zoom speed, and zoom correction can also be configured. Zoom correction compensates for the phenomenon where zooming in becomes harder at high magnification.",
  "tags": [],
  "userscripts": [
    {
      "url": "userscript.js"
    }
  ],
  "userstyles": [
    {
      "url": "userstyle.css"
    }
  ],
  "settings": [
    {
      "dynamic": true,
      "type": "boolean",
      "id": "show-button",
      "name": "Show the infinite scroll button",
      "default": true
    },
    {
      "dynamic": true,
      "type": "boolean",
      "id": "infinite-grid",
      "name": "Extend the checkerboard grid infinitely",
      "default": true
    },
    {
      "dynamic": true,
      "type": "integer",
      "id": "min-zoom",
      "name": "Minimum zoom % (original: 33)",
      "default": 33,
      "min": 1,
      "max": 100
    },
    {
      "dynamic": true,
      "type": "integer",
      "id": "max-zoom",
      "name": "Maximum zoom % (0 = unlimited)",
      "default": 0,
      "min": 0,
      "max": 100000
    },
    {
      "dynamic": true,
      "type": "integer",
      "id": "zoom-speed",
      "name": "Zoom speed %",
      "default": 100,
      "min": 10,
      "max": 1000
    },
    {
      "dynamic": true,
      "type": "integer",
      "id": "zoom-correction",
      "name": "Zoom correction % (0 = original, 100 = proportional to zoom)",
      "default": 50,
      "min": 0,
      "max": 100
    },
    {
      "dynamic": true,
      "type": "boolean",
      "id": "show-zoom-percent",
      "name": "Show the zoom percentage next to the zoom buttons",
      "default": true
    },
  ],
  "dynamicDisable": true,
  "enabledByDefault": true
};
export default manifest;
