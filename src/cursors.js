/**
 * BreezeX Custom Cursors - Embedded SVG Data URIs
 * Dark theme: black fill with white outline
 * Light theme: white fill with black outline
 */

const fs = require('fs');
const path = require('path');

// Load SVG cursor and convert to data URI
function loadCursor(theme, name) {
  const svgPath = path.join(__dirname, '..', 'assets', 'cursors', theme, `${name}.svg`);
  try {
    const svg = fs.readFileSync(svgPath, 'utf8');
    const b64 = Buffer.from(svg).toString('base64');
    return `data:image/svg+xml;base64,${b64}`;
  } catch (e) {
    console.error(`Failed to load cursor: ${theme}/${name}`, e.message);
    return null;
  }
}

// Cursor hotspots (x, y) - based on BreezeX design
const HOTSPOTS = {
  'left_ptr': [4, 4],
  'hand2': [10, 4],
  'xterm': [16, 16],
  'move': [16, 16],
  'crossed_circle': [16, 16],
  'cross': [16, 16],
  'col-resize': [16, 16],
  'row-resize': [16, 16],
  'zoom-in': [10, 10],
  'zoom-out': [10, 10],
  'copy': [4, 4],
  'link': [4, 4],
  'context-menu': [4, 4],
  'question_arrow': [4, 4],
  'all-scroll': [16, 16]
};

// CSS cursor type mappings
const CSS_MAPPINGS = {
  'left_ptr': ['default', 'auto'],
  'hand2': ['pointer'],
  'xterm': ['text'],
  'move': ['move', 'grab', 'grabbing'],
  'crossed_circle': ['not-allowed', 'no-drop'],
  'cross': ['crosshair', 'cell'],
  'col-resize': ['col-resize', 'ew-resize', 'e-resize', 'w-resize'],
  'row-resize': ['row-resize', 'ns-resize', 'n-resize', 's-resize'],
  'zoom-in': ['zoom-in'],
  'zoom-out': ['zoom-out'],
  'copy': ['copy'],
  'link': ['alias'],
  'context-menu': ['context-menu'],
  'question_arrow': ['help'],
  'all-scroll': ['all-scroll']
};

// Generate CSS for cursor theme
function generateCursorCSS(theme = 'dark') {
  const cursors = {};
  const cursorNames = Object.keys(HOTSPOTS);
  
  for (const name of cursorNames) {
    const dataUri = loadCursor(theme, name);
    if (dataUri) {
      cursors[name] = dataUri;
    }
  }
  
  let css = `/* BreezeX ${theme} cursor theme - auto-generated */\n`;
  
  // Universal cursor reset
  css += `*, *::before, *::after {\n`;
  if (cursors['left_ptr']) {
    const [x, y] = HOTSPOTS['left_ptr'];
    css += `  cursor: url("${cursors['left_ptr']}") ${x} ${y}, default !important;\n`;
  }
  css += `}\n\n`;
  
  // Generate rules for each cursor type
  for (const [cursorName, cssTypes] of Object.entries(CSS_MAPPINGS)) {
    if (!cursors[cursorName]) continue;
    
    const [x, y] = HOTSPOTS[cursorName];
    const dataUri = cursors[cursorName];
    
    for (const cssType of cssTypes) {
      // Style attribute selectors
      css += `*[style*="cursor: ${cssType}"], *[style*="cursor:${cssType}"] {\n`;
      css += `  cursor: url("${dataUri}") ${x} ${y}, ${cssType} !important;\n`;
      css += `}\n`;
    }
  }
  
  // Special selectors for common elements
  if (cursors['hand2']) {
    const [x, y] = HOTSPOTS['hand2'];
    css += `\n/* Links and buttons */\n`;
    css += `a, a *, button, button *, [role="button"], [role="button"] *,\n`;
    css += `input[type="button"], input[type="submit"], input[type="reset"],\n`;
    css += `.btn, .button, [onclick] {\n`;
    css += `  cursor: url("${cursors['hand2']}") ${x} ${y}, pointer !important;\n`;
    css += `}\n`;
  }
  
  if (cursors['xterm']) {
    const [x, y] = HOTSPOTS['xterm'];
    css += `\n/* Text inputs */\n`;
    css += `input[type="text"], input[type="password"], input[type="email"],\n`;
    css += `input[type="search"], input[type="url"], input[type="tel"],\n`;
    css += `input[type="number"], textarea, [contenteditable="true"] {\n`;
    css += `  cursor: url("${cursors['xterm']}") ${x} ${y}, text !important;\n`;
    css += `}\n`;
  }
  
  if (cursors['crossed_circle']) {
    const [x, y] = HOTSPOTS['crossed_circle'];
    css += `\n/* Disabled elements */\n`;
    css += `*[disabled], *:disabled, .disabled {\n`;
    css += `  cursor: url("${cursors['crossed_circle']}") ${x} ${y}, not-allowed !important;\n`;
    css += `}\n`;
  }
  
  return css;
}

module.exports = { generateCursorCSS, loadCursor, HOTSPOTS, CSS_MAPPINGS };
