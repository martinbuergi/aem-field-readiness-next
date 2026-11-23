/* eslint-disable no-await-in-loop -- encounters are sequential dialogs by design */
/* eslint-disable no-bitwise -- deterministic pixel noise for tiles */

/*
 * Questline: a top-down adventure that turns field-readiness content into a game.
 *
 * Authoring (one row per entry, first cell is the row type, case-insensitive):
 *   Title     | <region name>
 *   Intro     | <text shown on the start screen>
 *   Boss      | <boss name>
 *   Expert    | <name> | <expertise, e.g. "Adobe Brand Visibility"> | <dialogue> | <link>
 *   NPC       | <name> | <dialogue, one paragraph per line> | <link to collateral>
 *   Puzzle    | <question> | <correct answer> | <wrong answer> | ... | <link>
 *   Objection | <objection> | <best response> | <weak response> | ... | <link>
 *   Shrine    | <text> | <link>
 *   Play      | <play name> | <what it is / when to use it> | <taught by: NPC name> | <link>
 *   Customer  | <company> | <logo image> | <contact, e.g. "Priya, VP Digital"> | <situation>
 *             | <best play name> | <required skills, comma-separated> | <link>
 *             Required skills are expertise areas and/or play names (default: the best play).
 *             The more skills a customer needs, the posher their house (cottage, townhouse,
 *             manor).
 * Puzzles are spread across up to three rune gates; objections make up the boss fight.
 * Each customer lives in one of the village houses (max 3). To propose a strategy the
 * player needs the skills that customer requires; all deals must be won before the
 * boss accepts the challenge. The player starts at level 0 and earns XP for every
 * conversation and correct answer; expertise areas and plays become skills.
 * Any cell that only contains a link is treated as the "learn more" link.
 */

const TILE = 16;
const COLS = 24;
const ROWS = 16;
const SPEED = 6; // tiles per second
const XP_PER_LEVEL = 50;
const XP = {
  meet: 10, // first conversation with an expert / villager
  hear: 5, // first time a customer shares their situation
  play: 15, // learning a play
  deal: 25, // winning a customer deal
  gate: 10, // rune gate question
  objection: 15, // boss objection countered
  shrine: 10, // studying at the shrine
};
const levelOf = (xp) => Math.floor(xp / XP_PER_LEVEL);
const MAX_GATES = 3;

const DIRS = {
  up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0],
};
const KEYMAP = {
  ArrowUp: 'up',
  KeyW: 'up',
  ArrowDown: 'down',
  KeyS: 'down',
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
};
const ACTION_KEYS = ['Space', 'Enter', 'KeyE'];

const DEFAULT_CONTENT = {
  title: 'The Readiness Realm',
  intro: 'Add NPC, Puzzle and Objection rows to this block to turn your collateral into a quest.',
  bossName: 'The Incumbent',
  npcs: [{ name: 'Guide', lines: ['Talk to villagers, open the rune gates, then face the boss.'], link: null }],
  puzzles: [{
    prompt: 'What opens a rune gate?', answer: 'Knowing the content', wrong: ['A sword', 'Luck'], link: null,
  }],
  objections: [{
    prompt: 'Why would anyone switch from me?', answer: 'Because the new offer solves their problem better', wrong: ['Because it is new'], link: null,
  }],
  shrine: null,
};

/* ---------- small helpers ---------- */

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([k, v]) => {
    if (v === undefined || v === null || v === false) return;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  });
  children.flat().forEach((c) => {
    if (c !== null && c !== undefined && c !== false) node.append(c);
  });
  return node;
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) >>> 0;
  h = ((h ^ (h >>> 13)) * 1274126177) >>> 0;
  return h;
}

/* ---------- content parsing ---------- */

const cellText = (cell) => (cell ? cell.textContent.replace(/\s+/g, ' ').trim() : '');

function isLinkOnly(cell) {
  const a = cell.querySelector('a[href]');
  return !!a && cell.textContent.trim() === a.textContent.trim();
}

function cellLines(cell) {
  const paras = [...cell.querySelectorAll('p, li')].map((p) => cellText(p)).filter(Boolean);
  return paras.length ? paras : [cellText(cell)].filter(Boolean);
}

function parseContent(block) {
  const content = {
    title: '',
    intro: '',
    bossName: '',
    npcs: [],
    puzzles: [],
    objections: [],
    shrine: null,
    plays: [],
    customers: [],
  };
  [...block.children].forEach((row) => {
    const cells = [...row.children];
    if (cells.length < 2) return;
    const key = cellText(cells[0]).toLowerCase().replace(/[^a-z]/g, '');
    const rest = cells.slice(1);
    const linkEl = rest.map((c) => c.querySelector('a[href]')).find(Boolean);
    const link = linkEl ? { href: linkEl.href, text: cellText(linkEl) } : null;
    const textCells = rest.filter((c) => !isLinkOnly(c) && cellText(c));
    const texts = textCells.map(cellText);
    // positional cells (empty cells kept) for row types with a fixed column order
    // (an empty 2nd cell is an empty logo slot on customer rows, so it is skipped too)
    const posCells = rest.filter((c, idx) => !isLinkOnly(c) && !c.querySelector('img')
      && !(key === 'customer' && idx === 1 && !cellText(c)));
    const pos = posCells.map(cellText);
    const img = row.querySelector('img');

    switch (key) {
      case 'expert':
        if (pos[0]) {
          content.npcs.push({
            name: pos[0],
            expertise: pos[1] || '',
            lines: posCells[2] ? cellLines(posCells[2]) : [],
            link,
          });
        }
        break;
      case 'play':
        if (pos[0]) {
          content.plays.push({
            name: pos[0], description: pos[1] || '', teacher: pos[2] || '', link,
          });
        }
        break;
      case 'customer':
      case 'account':
        if (pos[0]) {
          content.customers.push({
            company: pos[0],
            contact: pos[1] || '',
            situation: posCells[2] ? cellLines(posCells[2]) : [],
            best: pos[3] || '',
            requires: (pos[4] || '').split(/[,;\n·]+/).map((s) => s.trim()).filter(Boolean),
            logo: img ? { src: img.currentSrc || img.src, alt: img.alt } : null,
            link,
          });
        }
        break;
      case 'title':
        content.title = texts[0] || '';
        break;
      case 'intro':
        content.intro = texts.join(' ');
        break;
      case 'boss':
        content.bossName = texts[0] || '';
        break;
      case 'npc':
      case 'character':
        if (texts.length) {
          content.npcs.push({
            name: texts[0],
            lines: textCells.slice(1).flatMap(cellLines),
            link,
          });
        }
        break;
      case 'puzzle':
      case 'question':
      case 'quiz':
      case 'objection':
        if (texts.length >= 3) {
          const entry = {
            prompt: texts[0], answer: texts[1], wrong: texts.slice(2), link,
          };
          (key === 'objection' ? content.objections : content.puzzles).push(entry);
        }
        break;
      case 'shrine':
        content.shrine = { text: texts.join(' '), link };
        break;
      default:
        break;
    }
  });

  return {
    title: content.title || DEFAULT_CONTENT.title,
    intro: content.intro || DEFAULT_CONTENT.intro,
    bossName: content.bossName || DEFAULT_CONTENT.bossName,
    npcs: content.npcs.length ? content.npcs : DEFAULT_CONTENT.npcs,
    puzzles: content.puzzles.length ? content.puzzles : DEFAULT_CONTENT.puzzles,
    objections: content.objections.length ? content.objections : DEFAULT_CONTENT.objections,
    shrine: content.shrine,
    plays: content.plays,
    customers: content.customers,
  };
}

/* ---------- world ---------- */

function buildWorld() {
  const grid = Array.from({ length: ROWS }, () => Array(COLS).fill('.'));
  const set = (x, y, c) => { grid[y][x] = c; };

  // zone walls: village | grove | lake | arena
  [9, 14, 18].forEach((x) => { for (let y = 1; y < ROWS - 1; y += 1) set(x, y, '^'); });

  // village paths and decoration
  for (let x = 1; x < 9; x += 1) set(x, 8, ':');
  for (let y = 4; y < 14; y += 1) set(4, y, ':');
  [[1, 5], [2, 13], [7, 5], [6, 9], [3, 10], [8, 13], [5, 1]].forEach(([x, y]) => set(x, y, 'f'));
  [[8, 1], [1, 1], [8, 10], [1, 14]].forEach(([x, y]) => set(x, y, 't'));
  const houses = [{ x: 1, y: 2 }, { x: 6, y: 2 }, { x: 6, y: 11 }];
  houses.forEach(({ x, y }) => {
    set(x, y, 'H'); set(x + 1, y, 'H'); set(x, y + 1, 'H'); set(x + 1, y + 1, 'H');
  });

  // grove: winding path to the second gate, shrine in the south
  [[10, 8], [11, 8], [11, 7], [11, 6], [11, 5], [11, 4], [12, 4], [13, 4],
    [11, 9], [11, 10], [11, 11]].forEach(([x, y]) => set(x, y, ':'));
  [[10, 2], [13, 2], [10, 13], [13, 13], [13, 8], [10, 5], [13, 10], [12, 1], [10, 11]]
    .forEach(([x, y]) => set(x, y, 't'));
  [[12, 8], [10, 10], [12, 13]].forEach(([x, y]) => set(x, y, 'f'));

  // lake with a plank bridge
  for (let x = 15; x <= 17; x += 1) for (let y = 1; y < ROWS - 1; y += 1) set(x, y, '~');
  set(15, 4, '='); set(17, 11, '=');
  for (let y = 4; y <= 11; y += 1) set(16, y, '=');

  // arena
  for (let x = 19; x <= 22; x += 1) for (let y = 1; y < ROWS - 1; y += 1) set(x, y, ',');
  [[19, 2], [22, 2], [19, 13], [22, 13]].forEach(([x, y]) => set(x, y, 'P'));

  // border
  for (let x = 0; x < COLS; x += 1) { set(x, 0, 'T'); set(x, ROWS - 1, 'T'); }
  for (let y = 0; y < ROWS; y += 1) { set(0, y, 'T'); set(COLS - 1, y, 'T'); }

  const gates = [{ x: 9, y: 8 }, { x: 14, y: 4 }, { x: 18, y: 11 }];
  gates.forEach(({ x, y }) => set(x, y, 'G'));

  return {
    grid,
    houses,
    gates,
    start: { x: 2, y: 8 },
    npcSpots: [{ x: 3, y: 6 }, { x: 7, y: 7 }, { x: 2, y: 11 }, { x: 5, y: 13 }, { x: 12, y: 6 }],
    shrine: { x: 12, y: 11 },
    boss: { x: 20, y: 7 }, // 2x2
  };
}

const WALKABLE = new Set(['.', ':', 'f', '=', ',']);

/* ---------- pixel art ---------- */

const HEAD = {
  down: ['................', '.....hhhhhh.....', '....hhhhhhhh....', '....hssssssh....',
    '....sesssses....', '....ssssssss....', '.....ssmmss.....'],
  up: ['................', '.....hhhhhh.....', '....hhhhhhhh....', '....hhhhhhhh....',
    '....hhhhhhhh....', '....shhhhhhs....', '.....ssssss.....'],
  side: ['................', '.....hhhhhh.....', '....hhhhhhhh....', '....hhhsssss....',
    '....hhssssess...', '....hsssssss....', '.....sssssm.....'],
};
const TORSO = {
  down: ['....jjjwwjjj....', '...jjjjwtjjjj...', '...sjjjwtjjjs...', '...sjjjjjjjjs...',
    '....jjjjjjjj....', '....pppppppp....'],
  up: ['....jjjjjjjj....', '...jjjjjjjjjj...', '...sjjjjjjjjs...', '...sjjjjjjjjs...',
    '....jjjjjjjj....', '....pppppppp....'],
  side: ['.....jjjjjj.....', '....jjjjjjjj....', '....jjjjjjsj....', '....jjjjjjsj....',
    '.....jjjjjj.....', '.....pppppp.....'],
};
const LEGS = {
  front: {
    stand: ['....ppp..ppp....', '....bbb..bbb....', '................'],
    a: ['....ppp..ppp....', '....bbb..ppp....', '.........bbb....'],
    b: ['....ppp..ppp....', '....ppp..bbb....', '....bbb.........'],
  },
  side: {
    stand: ['.....pp..pp.....', '.....bb..bb.....', '................'],
    a: ['....pp....pp....', '....bb....bb....', '................'],
    b: ['......pppp......', '......bbbb......', '................'],
  },
};

const PALETTES = {
  player: {
    h: '#3b2a1a', s: '#f2c79b', e: '#1a1a2e', m: '#d99a72', j: '#2f6fd6', w: '#fff', t: '#e63946', p: '#2b2d42', b: '#111',
  },
  npc0: {
    h: '#c0392b', s: '#f5d0a9', e: '#1a1a2e', m: '#dba27a', j: '#8e44ad', w: '#f4e1ff', t: '#f1c40f', p: '#4a2c5e', b: '#2a1a10',
  },
  npc1: {
    h: '#d9d9d9', s: '#e7b98f', e: '#1a1a2e', m: '#c98d63', j: '#2e7d32', w: '#e8f5e9', t: '#795548', p: '#3e2723', b: '#1b1b1b',
  },
  npc2: {
    h: '#111', s: '#8d5a3b', e: '#fff', m: '#6e4329', j: '#f39c12', w: '#fff3e0', t: '#d35400', p: '#34495e', b: '#111',
  },
  npc3: {
    h: '#f4d35e', s: '#f9dcc4', e: '#1a1a2e', m: '#e0a989', j: '#16a085', w: '#e0f7f4', t: '#c0392b', p: '#2c3e50', b: '#111',
  },
  npc4: {
    h: '#5d4037', s: '#c68e6a', e: '#1a1a2e', m: '#a86f4e', j: '#b03a2e', w: '#fdecea', t: '#f4d35e', p: '#212121', b: '#111',
  },
};

// the player's look evolves with their level
const PLAYER_LOOKS = [
  {
    min: 0,
    title: 'Rookie',
    pal: {
      h: '#3b2a1a', s: '#f2c79b', e: '#1a1a2e', m: '#d99a72', j: '#4caf50', w: '#7bd47f', t: '#3d8b40', p: '#3a4a6b', b: '#d9d9d9',
    },
  },
  {
    min: 1,
    title: 'Associate',
    pal: {
      h: '#3b2a1a', s: '#f2c79b', e: '#1a1a2e', m: '#d99a72', j: '#2f6fd6', w: '#fff', t: '#e63946', p: '#2b2d42', b: '#111',
    },
  },
  {
    min: 3,
    title: 'Account Executive',
    briefcase: true,
    pal: {
      h: '#2e2014', s: '#f2c79b', e: '#1a1a2e', m: '#d99a72', j: '#1d2b53', w: '#fff', t: '#f4d35e', p: '#1d2b53', b: '#3b1f0e',
    },
  },
  {
    min: 5,
    title: 'Trusted Advisor',
    briefcase: true,
    cape: true,
    aura: true,
    pal: {
      h: '#2a1d12', s: '#f2c79b', e: '#1a1a2e', m: '#d99a72', j: '#34343f', w: '#fff', t: '#f4d35e', p: '#34343f', b: '#111',
    },
  },
];
PLAYER_LOOKS.forEach((look, i) => { PALETTES[`look${i}`] = look.pal; });
function lookIndex(level) {
  let idx = 0;
  PLAYER_LOOKS.forEach((l, i) => { if (level >= l.min) idx = i; });
  return idx;
}

const INK = '#1a1424';
const spriteCache = new Map();
// pixel sprite with a 1px dark outline (the canvas is 2px larger than the art)
function sprite(key, rows, palette) {
  if (spriteCache.has(key)) return spriteCache.get(key);
  const w = rows[0].length;
  const h = rows.length;
  const filled = (x, y) => x >= 0 && y >= 0 && x < w && y < h && !!palette[rows[y][x]];
  const c = document.createElement('canvas');
  c.width = w + 2;
  c.height = h + 2;
  const g = c.getContext('2d');
  g.fillStyle = INK;
  for (let y = -1; y <= h; y += 1) {
    for (let x = -1; x <= w; x += 1) {
      const edge = filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1);
      if (!filled(x, y) && edge) {
        g.fillRect(x + 1, y + 1, 1, 1);
      }
    }
  }
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    if (palette[ch]) {
      g.fillStyle = palette[ch];
      g.fillRect(x + 1, y + 1, 1, 1);
    }
  }));
  spriteCache.set(key, c);
  return c;
}

function rect(g, color, x, y, w, h) {
  g.fillStyle = color;
  g.fillRect(x, y, w, h);
}

// filled pixel circle
function blob(g, color, cx, cy, r) {
  g.fillStyle = color;
  for (let dy = -r; dy <= r; dy += 1) {
    const half = Math.floor(Math.sqrt(r * r - dy * dy) + 0.35);
    g.fillRect(cx - half, cy + dy, half * 2 + 1, 1);
  }
}

const glowCache = new Map();
function glowSprite(color, r) {
  const key = `${color}-${r}`;
  if (glowCache.has(key)) return glowCache.get(key);
  const c = document.createElement('canvas');
  c.width = r * 2;
  c.height = r * 2;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, color);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, r * 2, r * 2);
  glowCache.set(key, c);
  return c;
}
// additive light
function glow(g, x, y, r, color, alpha = 1) {
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.globalAlpha = alpha;
  g.drawImage(glowSprite(color, r), Math.round(x - r), Math.round(y - r));
  g.restore();
}

function drawPerson(g, x, y, dir, step, palKey) {
  const facing = dir === 'left' || dir === 'right' ? 'side' : dir;
  const legs = LEGS[facing === 'side' ? 'side' : 'front'][step];
  const rows = [...HEAD[facing], ...TORSO[facing], ...legs];
  const img = sprite(`${palKey}-${facing}-${step}`, rows, PALETTES[palKey]);
  rect(g, 'rgba(0,0,0,0.25)', x + 3, y + 15, 10, 2);
  if (dir === 'left') {
    g.save();
    g.translate(x + TILE + 1, y - 1);
    g.scale(-1, 1);
    g.drawImage(img, 0, 0);
    g.restore();
  } else {
    g.drawImage(img, x - 1, y - 1);
  }
}

function drawPlayer(g, x, y, dir, step, li, t) {
  const look = PLAYER_LOOKS[li];
  if (look.aura) {
    g.globalAlpha = 0.3 + 0.15 * Math.sin(t / 300);
    rect(g, '#f4d35e', x + 2, y + 14, 12, 3);
    rect(g, '#f4d35e', x + 4, y + 13, 8, 5);
    g.globalAlpha = 1;
  }
  const back = { right: x + 3, left: x + 9 }[dir];
  if (look.cape && dir !== 'up') {
    if (back === undefined) {
      rect(g, INK, x + 1, y + 7, 14, 10);
      rect(g, '#b3202a', x + 2, y + 8, 12, 9);
      rect(g, '#8a1520', x + 2, y + 15, 12, 2);
    } else {
      rect(g, INK, back - 1, y + 7, 6, 10);
      rect(g, '#b3202a', back, y + 8, 4, 9);
    }
  }
  drawPerson(g, x, y, dir, step, `look${li}`);
  if (look.cape && dir === 'up') {
    rect(g, INK, x + 2, y + 6, 12, 11);
    rect(g, '#b3202a', x + 3, y + 7, 10, 9);
    rect(g, '#8a1520', x + 5, y + 9, 1, 7);
    rect(g, '#8a1520', x + 10, y + 9, 1, 7);
    rect(g, '#f4d35e', x + 7, y + 7, 2, 1);
  }
  if (look.briefcase && dir !== 'up') {
    const bx = { down: x + 12, right: x + 8, left: x + 4 }[dir];
    rect(g, INK, bx - 1, y + 11, 7, 6);
    rect(g, '#7a4a22', bx, y + 12, 5, 4);
    rect(g, '#5a3417', bx, y + 14, 5, 1);
    rect(g, '#f4d35e', bx + 2, y + 13, 1, 1);
  }
  if (look.aura) {
    for (let i = 0; i < 3; i += 1) {
      const p = ((t / 1200) + i / 3) % 1;
      g.globalAlpha = 1 - p;
      rect(g, '#fff6c9', x + 2 + ((i * 5 + Math.floor(t / 900)) % 12), y + 14 - p * 16, 1, 1);
    }
    g.globalAlpha = 1;
    glow(g, x + 8, y + 9, 16, '#5a4a10', 0.9);
  }
}

/* terrain (static, rendered once into an offscreen canvas) */

const WATERISH = new Set(['~', '=']);
const PATHISH = new Set([':', 'G', '=']);

function drawGrass(g, x, y, tx, ty) {
  const h = hash(tx, ty);
  rect(g, (tx + ty) % 2 ? '#5c9d4b' : '#60a24f', x, y, TILE, TILE);
  for (let i = 0; i < 3; i += 1) {
    const v = (h >>> (i * 8)) & 255;
    const bx = x + 1 + (v % 12);
    const by = y + 2 + ((v >>> 4) % 11);
    rect(g, '#4a8a3c', bx, by, 1, 2);
    rect(g, '#4a8a3c', bx + 2, by, 1, 2);
    rect(g, '#4a8a3c', bx + 1, by + 1, 1, 2);
  }
  const l = h >>> 20;
  rect(g, '#79bb62', x + (l % 14) + 1, y + ((l >>> 4) % 14) + 1, 1, 1);
  rect(g, '#79bb62', x + ((l >>> 3) % 14) + 1, y + ((l >>> 7) % 14) + 1, 1, 1);
}

function drawTree(g, x, y, tx, ty, border) {
  const h = hash(tx, ty);
  drawGrass(g, x, y, tx, ty);
  rect(g, 'rgba(0,0,0,0.22)', x + 3, y + 13, 11, 2);
  rect(g, 'rgba(0,0,0,0.22)', x + 5, y + 15, 7, 1);
  rect(g, '#6b4226', x + 7, y + 9, 3, 6);
  rect(g, '#4e2f1a', x + 9, y + 9, 1, 6);
  const [dark, mid, light] = border
    ? ['#1f4a26', '#2b6131', '#3c7c3e']
    : [['#24602b', '#33803a', '#4fa24a'], ['#2a5e2c', '#3a7d35', '#5a9e45']][h % 2];
  g.save();
  g.translate(x, y);
  blob(g, '#14301a', 8, 6, 6);
  blob(g, dark, 8, 6, 5);
  blob(g, mid, 7, 5, 4);
  blob(g, light, 6, 4, 2);
  rect(g, '#8fd27a', 5, 3, 1, 1);
  if (!border && h % 3 === 0) {
    rect(g, '#e63946', 10, 7, 1, 1);
    rect(g, '#e63946', 5, 8, 1, 1);
    rect(g, '#e63946', 9, 3, 1, 1);
  }
  g.restore();
}

function drawTerrainTile(g, grid, tx, ty) {
  const c = grid[ty][tx];
  const at = (x, y) => (grid[y] && grid[y][x]) || 'T';
  const x = tx * TILE;
  const y = ty * TILE;
  const h = hash(tx, ty);
  switch (c) {
    case ':': {
      rect(g, '#d8b77a', x, y, TILE, TILE);
      rect(g, '#c9a66a', x + (h % 12) + 2, y + ((h >>> 5) % 12) + 2, 2, 1);
      rect(g, '#e6caa0', x + ((h >>> 9) % 12) + 2, y + ((h >>> 13) % 12) + 2, 1, 1);
      rect(g, '#a89070', x + ((h >>> 17) % 12) + 2, y + ((h >>> 21) % 12) + 2, 1, 1);
      // soft grass edges where the path meets the lawn
      const edge = (nx, ny, fn) => { if (!PATHISH.has(at(nx, ny)) && at(nx, ny) !== 'H') fn(); };
      edge(tx, ty - 1, () => { rect(g, '#b89a62', x, y, TILE, 1); for (let i = 0; i < 16; i += 3) rect(g, '#5c9d4b', x + i + (h % 2), y, 1, 1 + ((h >>> i) & 1)); });
      edge(tx, ty + 1, () => { rect(g, '#b89a62', x, y + 15, TILE, 1); for (let i = 0; i < 16; i += 3) rect(g, '#5c9d4b', x + i + 1, y + 15 - ((h >>> i) & 1), 1, 2); });
      edge(tx - 1, ty, () => { rect(g, '#b89a62', x, y, 1, TILE); for (let i = 0; i < 16; i += 3) rect(g, '#5c9d4b', x, y + i + 1, 1 + ((h >>> i) & 1), 1); });
      edge(tx + 1, ty, () => { rect(g, '#b89a62', x + 15, y, 1, TILE); for (let i = 0; i < 16; i += 3) rect(g, '#5c9d4b', x + 15 - ((h >>> i) & 1), y + i, 2, 1); });
      break;
    }
    case 'f': {
      drawGrass(g, x, y, tx, ty);
      const colors = ['#ff6b9a', '#ffd166', '#ffffff', '#b388ff'];
      for (let i = 0; i < 4; i += 1) {
        const v = (h >>> (i * 7)) & 255;
        const fx = x + 2 + (v % 11);
        const fy = y + 2 + ((v >>> 4) % 10);
        rect(g, '#3d7a33', fx + 1, fy + 2, 1, 2);
        rect(g, colors[(v + i) % 4], fx, fy + 1, 3, 1);
        rect(g, colors[(v + i) % 4], fx + 1, fy, 1, 3);
        rect(g, '#fff6c9', fx + 1, fy + 1, 1, 1);
      }
      break;
    }
    case 'T':
    case 't':
      drawTree(g, x, y, tx, ty, c === 'T');
      break;
    case '^':
    case 'G':
      rect(g, '#7d8291', x, y, TILE, TILE);
      for (let r = 0; r < 3; r += 1) {
        const by = y + 1 + r * 5;
        const off = (ty + r) % 2 ? 0 : 5;
        rect(g, '#5a5e6b', x, by + 4, TILE, 1);
        rect(g, '#959aa8', x, by, TILE, 1);
        for (let k = off; k < TILE; k += 10) rect(g, '#5a5e6b', x + k, by, 1, 4);
      }
      rect(g, '#b4b9c6', x, y, TILE, 1);
      rect(g, '#9aa0ad', x, y + 1, 1, 15);
      rect(g, '#4a4e5a', x + 15, y, 1, TILE);
      if (h % 3 === 0) {
        rect(g, '#5c8a3e', x + (h % 10) + 2, y + 14, 4, 2);
        rect(g, '#79a852', x + (h % 10) + 3, y + 14, 2, 1);
      }
      if (h % 4 === 1) rect(g, '#5c8a3e', x + ((h >>> 4) % 12) + 1, y + 6, 2, 1);
      break;
    case '~':
    case '=': {
      rect(g, '#3a7bd5', x, y, TILE, TILE);
      if (h % 3 === 0) rect(g, '#336fc4', x + (h % 8), y + ((h >>> 4) % 10) + 3, 7, 3);
      const shore = (nx, ny) => !WATERISH.has(at(nx, ny));
      if (shore(tx, ty - 1)) { rect(g, '#2a5fae', x, y, TILE, 2); rect(g, '#cfeaff', x, y + 2, TILE, 1); }
      if (shore(tx - 1, ty)) { rect(g, '#2a5fae', x, y, 2, TILE); rect(g, '#cfeaff', x + 2, y + (h % 3), 1, TILE - 3); }
      if (shore(tx + 1, ty)) { rect(g, '#cfeaff', x + 13, y + (h % 3), 1, TILE - 3); }
      if (shore(tx, ty + 1)) rect(g, '#cfeaff', x, y + 13, TILE, 1);
      if (c === '=') {
        rect(g, 'rgba(0,0,0,0.25)', x + 2, y + 2, 14, TILE);
        rect(g, '#6e4a26', x + 1, y, 14, TILE);
        for (let i = 0; i < 4; i += 1) {
          rect(g, '#b07c45', x + 1, y + i * 4, 14, 3);
          rect(g, '#c99560', x + 1, y + i * 4, 14, 1);
          rect(g, '#8a5a2e', x + 3 + ((h >>> i) % 9), y + i * 4 + 1, 2, 1);
        }
        rect(g, '#5a3a1a', x + 1, y, 1, TILE);
        rect(g, '#5a3a1a', x + 14, y, 1, TILE);
      }
      break;
    }
    case ',':
    case 'P':
      rect(g, '#3d3357', x, y, TILE, TILE);
      [[0, 0], [8, 0], [0, 8], [8, 8]].forEach(([ox, oy]) => {
        rect(g, '#4b4069', x + ox, y + oy, 8, 1);
        rect(g, '#4b4069', x + ox, y + oy, 1, 8);
        rect(g, '#2a2340', x + ox + 7, y + oy, 1, 8);
        rect(g, '#2a2340', x + ox, y + oy + 7, 8, 1);
      });
      if (h % 5 === 0) {
        rect(g, '#2a2340', x + 3 + (h % 6), y + 4, 3, 1);
        rect(g, '#2a2340', x + 5 + (h % 6), y + 5, 2, 1);
      }
      if (c === 'P') {
        rect(g, 'rgba(0,0,0,0.35)', x + 2, y + 13, 13, 3);
        rect(g, INK, x + 3, y + 1, 10, 14);
        rect(g, '#8d86a8', x + 4, y + 2, 8, 12);
        rect(g, '#a9a2c4', x + 4, y + 2, 2, 12);
        rect(g, '#6b6488', x + 10, y + 2, 2, 12);
        rect(g, '#6b6488', x + 3, y + 12, 10, 3);
        rect(g, '#6b6488', x + 3, y + 1, 10, 2);
      }
      break;
    default:
      drawGrass(g, x, y, tx, ty);
  }
}

function buildTerrain(grid) {
  const c = document.createElement('canvas');
  c.width = COLS * TILE;
  c.height = ROWS * TILE;
  const g = c.getContext('2d');
  for (let y = 0; y < ROWS; y += 1) {
    for (let x = 0; x < COLS; x += 1) drawTerrainTile(g, grid, x, y);
  }
  // walls cast a shadow to the east
  for (let y = 0; y < ROWS; y += 1) {
    for (let x = 0; x < COLS - 1; x += 1) {
      if (grid[y][x] === '^' && grid[y][x + 1] !== '^') rect(g, 'rgba(0,0,0,0.18)', (x + 1) * TILE, y * TILE, 3, TILE);
    }
  }
  return c;
}

// water shimmer and pillar orbs
function drawAnimatedTiles(g, grid, t) {
  for (let ty = 0; ty < ROWS; ty += 1) {
    for (let tx = 0; tx < COLS; tx += 1) {
      const c = grid[ty][tx];
      const x = tx * TILE;
      const y = ty * TILE;
      if (c === '~') {
        const o = Math.floor(t / 350 + tx + ty * 2) % 4;
        rect(g, '#6fa8ff', x + 2 + o * 2, y + 5, 4, 1);
        rect(g, '#6fa8ff', x + 9 - o, y + 10, 4, 1);
        const h = hash(tx, ty);
        if ((Math.floor(t / 160) + h) % 29 === 0) {
          const sx = x + 3 + (h % 10);
          const sy = y + 4 + ((h >>> 4) % 8);
          rect(g, '#fff', sx, sy - 1, 1, 3);
          rect(g, '#fff', sx - 1, sy, 3, 1);
        }
      } else if (c === 'P') {
        const oy = y - 2 + Math.round(Math.sin(t / 200 + tx));
        rect(g, INK, x + 5, oy - 1, 6, 5);
        rect(g, '#b388ff', x + 6, oy, 4, 3);
        rect(g, '#efe2ff', x + 6, oy, 1, 1);
        glow(g, x + 8, oy + 1, 18, '#5b2ca0', 0.8 + 0.2 * Math.sin(t / 250 + tx));
      }
    }
  }
}

/* houses: the more skills a customer needs, the posher the house */

function drawCottage(g, x, y) {
  rect(g, 'rgba(0,0,0,0.22)', x + 3, y + 30, 30, 3);
  rect(g, '#8a8478', x + 2, y + 28, 28, 3);
  rect(g, '#a49e90', x + 2, y + 28, 28, 1);
  rect(g, '#b07a45', x + 3, y + 13, 26, 15);
  for (let i = 0; i < 5; i += 1) rect(g, '#8f5f33', x + 3, y + 15 + i * 3, 26, 1);
  rect(g, '#6e4524', x + 3, y + 13, 1, 15);
  rect(g, '#6e4524', x + 28, y + 13, 1, 15);
  // thatched roof
  rect(g, INK, x, y + 3, 32, 11);
  rect(g, INK, x + 3, y, 26, 4);
  rect(g, '#d9a441', x + 1, y + 4, 30, 9);
  rect(g, '#d9a441', x + 4, y + 1, 24, 4);
  rect(g, '#ecc46a', x + 4, y + 1, 24, 1);
  for (let i = 0; i < 15; i += 1) rect(g, '#b8862f', x + 2 + i * 2, y + 4 + (i % 3), 1, 5);
  for (let i = 0; i < 16; i += 1) rect(g, '#9a6c24', x + i * 2, y + 12, 1, 1 + (i % 2));
  [x + 6, x + 21].forEach((wx) => {
    rect(g, '#4e7d3a', wx - 2, y + 17, 2, 6);
    rect(g, '#4e7d3a', wx + 5, y + 17, 2, 6);
    rect(g, '#5a3a1a', wx, y + 17, 5, 6);
    rect(g, '#8ecae6', wx + 1, y + 18, 3, 4);
    rect(g, '#d6f0fb', wx + 1, y + 18, 1, 1);
    rect(g, '#5a3a1a', wx + 2, y + 18, 1, 4);
  });
  rect(g, '#4e2f1a', x + 12, y + 19, 8, 12);
  rect(g, '#7a4b2a', x + 13, y + 20, 6, 11);
  rect(g, '#5a3a1a', x + 15, y + 20, 1, 11);
  rect(g, '#f4d35e', x + 17, y + 25, 1, 1);
  rect(g, '#a0522d', x + 21, y + 28, 3, 2);
  rect(g, '#ff6b9a', x + 21, y + 27, 3, 1);
}

function drawTownhouse(g, x, y, t) {
  rect(g, 'rgba(0,0,0,0.22)', x + 3, y + 30, 30, 3);
  // chimney with smoke
  rect(g, INK, x + 22, y - 6, 8, 11);
  rect(g, '#9a4a35', x + 23, y - 4, 6, 9);
  rect(g, '#7a3a2a', x + 23, y - 1, 6, 1);
  rect(g, '#6b6f7a', x + 22, y - 5, 8, 2);
  for (let i = 0; i < 3; i += 1) {
    const p = ((t / 1600) + i / 3) % 1;
    const s = 2 + Math.round(p * 3);
    g.globalAlpha = 0.55 * (1 - p);
    rect(g, '#e4e4ec', Math.round(x + 25 + Math.sin(p * 6 + i) * 2 + p * 6), Math.round(y - 8 - p * 18), s, s);
  }
  g.globalAlpha = 1;
  // slate roof
  rect(g, INK, x - 1, y + 3, 34, 12);
  rect(g, INK, x + 2, y - 1, 28, 5);
  rect(g, '#4a5368', x, y + 4, 32, 10);
  rect(g, '#4a5368', x + 3, y, 26, 5);
  rect(g, '#6a7590', x + 3, y, 26, 1);
  [3, 6, 9, 12].forEach((r, ri) => {
    rect(g, '#3a4256', x + (r < 4 ? 3 : 0), y + r, r < 4 ? 26 : 32, 1);
    for (let k = (ri % 2) * 2; k < 32; k += 4) rect(g, '#3a4256', x + k, y + r - 2, 1, 2);
  });
  rect(g, '#e8e2d4', x - 1, y + 13, 34, 2);
  // brick walls
  rect(g, '#b5523b', x + 2, y + 15, 28, 14);
  for (let r = 0; r < 5; r += 1) {
    const yy = y + 15 + r * 3;
    rect(g, '#8f3d2c', x + 2, yy + 2, 28, 1);
    for (let k = (r % 2 ? 2 : 5); k < 28; k += 6) rect(g, '#8f3d2c', x + 2 + k, yy, 1, 2);
  }
  rect(g, '#9a9488', x + 1, y + 28, 30, 3);
  rect(g, '#b8b2a5', x + 1, y + 28, 30, 1);
  [x + 4, x + 21].forEach((wx) => {
    rect(g, '#f2efe6', wx - 1, y + 17, 8, 8);
    rect(g, '#9fd3ee', wx, y + 18, 6, 6);
    rect(g, '#d6f0fb', wx, y + 18, 2, 1);
    rect(g, '#f2efe6', wx + 3, y + 18, 1, 6);
    rect(g, '#f2efe6', wx, y + 21, 6, 1);
    rect(g, '#6b4226', wx - 1, y + 25, 8, 2);
    for (let k = 0; k < 4; k += 1) rect(g, k % 2 ? '#ff6b9a' : '#e63946', wx + k * 2, y + 24, 1, 1);
    for (let k = 0; k < 3; k += 1) rect(g, '#3d7a33', wx + 1 + k * 2, y + 24, 1, 1);
  });
  rect(g, '#e8e2d4', x + 12, y + 18, 8, 13);
  rect(g, '#2d5a3d', x + 13, y + 20, 6, 11);
  rect(g, '#ffe29a', x + 13, y + 19, 6, 1);
  rect(g, '#244a32', x + 14, y + 21, 4, 3);
  rect(g, '#244a32', x + 14, y + 26, 4, 3);
  rect(g, '#f4d35e', x + 17, y + 25, 1, 1);
  rect(g, '#b8b2a5', x + 11, y + 30, 10, 2);
  // lantern
  const flicker = 0.85 + 0.15 * Math.sin(t / 90) * Math.sin(t / 37);
  rect(g, '#2b2d33', x + 21, y + 19, 3, 1);
  rect(g, '#2b2d33', x + 20, y + 20, 5, 4);
  rect(g, '#ffd166', x + 21, y + 21, 3, 2);
  glow(g, x + 22, y + 22, 12, '#7a5a10', flicker);
}

function drawManor(g, x, y, t) {
  rect(g, 'rgba(0,0,0,0.25)', x + 2, y + 30, 32, 3);
  // flags
  [x + 2, x + 29].forEach((fx, i) => {
    rect(g, '#c9a227', fx, y - 7, 1, 10);
    rect(g, '#fff6c9', fx, y - 8, 1, 1);
    for (let k = 0; k < 5; k += 1) {
      const off = Math.round(Math.sin(t / 180 + k * 0.9 + i) * 1);
      rect(g, k % 2 ? '#c1121f' : '#e63946', fx + 1 + k, y - 7 + off, 1, k > 2 ? 2 : 3);
    }
  });
  // blue slate roof with gold trim
  rect(g, INK, x - 1, y + 2, 34, 13);
  rect(g, INK, x + 2, y - 2, 28, 5);
  rect(g, '#2f4a7a', x, y + 3, 32, 11);
  rect(g, '#2f4a7a', x + 3, y - 1, 26, 4);
  rect(g, '#46679e', x + 3, y - 1, 26, 1);
  [2, 5, 8, 11].forEach((r, ri) => {
    rect(g, '#243a61', x + (r < 3 ? 3 : 0), y + r, r < 3 ? 26 : 32, 1);
    for (let k = (ri % 2) * 2 + 1; k < 32; k += 4) rect(g, '#3b5a8e', x + k, y + r + 1, 2, 1);
  });
  rect(g, '#f4d35e', x + 3, y - 2, 26, 1);
  rect(g, '#f4d35e', x - 1, y + 13, 34, 1);
  rect(g, '#f7f3ea', x - 1, y + 14, 34, 2);
  for (let k = 0; k < 34; k += 2) rect(g, '#cfc6b3', x - 1 + k, y + 15, 1, 1);
  // white stone walls
  rect(g, '#ece6da', x + 1, y + 16, 30, 13);
  [19, 23, 27].forEach((r, ri) => {
    rect(g, '#d4ccbc', x + 1, y + r, 30, 1);
    for (let k = ri % 2 ? 3 : 7; k < 30; k += 8) rect(g, '#d4ccbc', x + 1 + k, y + r - 3, 1, 3);
  });
  // arched, lit windows
  [x + 3, x + 23].forEach((wx) => {
    rect(g, '#c9a227', wx - 1, y + 18, 8, 9);
    rect(g, '#c9a227', wx, y + 17, 6, 1);
    rect(g, '#ffd98a', wx, y + 19, 6, 7);
    rect(g, '#ffd98a', wx + 1, y + 18, 4, 1);
    rect(g, '#fff2c9', wx, y + 19, 2, 2);
    rect(g, '#c9a227', wx + 3, y + 18, 1, 8);
    rect(g, '#c9a227', wx, y + 22, 6, 1);
    rect(g, '#f7f3ea', wx - 1, y + 27, 8, 1);
    glow(g, wx + 3, y + 22, 10, '#5a4210', 0.8);
  });
  // columns and double door
  [x + 10, x + 20].forEach((cx) => {
    rect(g, '#fffdf7', cx, y + 16, 2, 13);
    rect(g, '#cfc6b3', cx + 1, y + 16, 1, 13);
    rect(g, '#f4d35e', cx - 1, y + 16, 4, 1);
    rect(g, '#cfc6b3', cx - 1, y + 28, 4, 1);
  });
  rect(g, '#c9a227', x + 12, y + 18, 8, 13);
  rect(g, '#5a2d82', x + 13, y + 19, 6, 12);
  rect(g, '#ffd98a', x + 13, y + 19, 6, 1);
  rect(g, '#3e1f5c', x + 16, y + 20, 1, 11);
  rect(g, '#f4d35e', x + 15, y + 25, 1, 1);
  rect(g, '#f4d35e', x + 17, y + 25, 1, 1);
  // steps and red carpet
  rect(g, '#d4ccbc', x + 10, y + 29, 12, 2);
  rect(g, '#f7f3ea', x + 10, y + 29, 12, 1);
  rect(g, '#c1121f', x + 13, y + 29, 6, 5);
  rect(g, '#e5383b', x + 14, y + 29, 4, 5);
  // hedges
  [x - 2, x + 29].forEach((hx) => {
    rect(g, INK, hx - 1, y + 24, 7, 8);
    rect(g, '#2d6a2e', hx, y + 25, 5, 6);
    rect(g, '#2d6a2e', hx + 1, y + 24, 3, 1);
    rect(g, '#4fa24a', hx + 1, y + 25, 2, 2);
  });
  if (Math.floor(t / 250) % 9 === 0) {
    rect(g, '#fff', x + 27, y - 1, 1, 3);
    rect(g, '#fff', x + 26, y, 3, 1);
  }
}

function drawHouse(g, hx, hy, tier, t) {
  const x = hx * TILE;
  const y = hy * TILE;
  if (tier >= 3) drawManor(g, x, y, t);
  else if (tier === 2) drawTownhouse(g, x, y, t);
  else drawCottage(g, x, y);
}

function drawLock(g, x, y) {
  rect(g, INK, x, y - 1, 6, 4);
  rect(g, INK, x - 1, y + 2, 8, 7);
  rect(g, '#c7ccd6', x + 1, y, 4, 1);
  rect(g, '#c7ccd6', x + 1, y, 1, 3);
  rect(g, '#c7ccd6', x + 4, y, 1, 3);
  rect(g, '#9aa0ad', x, y + 3, 6, 5);
  rect(g, '#c7ccd6', x, y + 3, 6, 1);
  rect(g, '#2b2d33', x + 2, y + 5, 2, 2);
}

function drawCheck(g, x, y) {
  rect(g, INK, x - 1, y - 1, 9, 9);
  rect(g, '#1b7a45', x, y, 7, 7);
  rect(g, '#3ddc84', x, y, 7, 1);
  rect(g, '#fff', x + 1, y + 3, 1, 1);
  rect(g, '#fff', x + 2, y + 4, 1, 1);
  rect(g, '#fff', x + 3, y + 3, 1, 1);
  rect(g, '#fff', x + 4, y + 2, 1, 1);
  rect(g, '#fff', x + 5, y + 1, 1, 1);
}

const GATE_COLORS = ['#ff8fab', '#7ae582', '#ffd166'];

function drawGate(g, gate, i, open, t) {
  const x = gate.x * TILE;
  const y = gate.y * TILE;
  if (open) {
    rect(g, '#d8b77a', x, y, TILE, TILE);
    g.globalAlpha = 0.5;
    rect(g, GATE_COLORS[i], x + 7, y + 3, 2, 2);
    rect(g, GATE_COLORS[i], x + 7, y + 11, 2, 2);
    g.globalAlpha = 1;
    return;
  }
  rect(g, '#4a4560', x + 1, y, 14, TILE);
  rect(g, '#36324a', x + 1, y, 2, TILE);
  rect(g, '#36324a', x + 13, y, 2, TILE);
  rect(g, '#5d5878', x + 3, y + 1, 10, 1);
  g.globalAlpha = 0.6 + 0.4 * Math.sin(t / 300 + i);
  const c = GATE_COLORS[i];
  rect(g, c, x + 7, y + 4, 2, 8);
  rect(g, c, x + 5, y + 6, 6, 4);
  rect(g, c, x + 6, y + 5, 4, 6);
  g.globalAlpha = 1;
}

function drawShrine(g, s, t) {
  const x = s.x * TILE;
  const y = s.y * TILE;
  const b = Math.round(Math.sin(t / 400) * 1.5);
  g.globalAlpha = 0.25 + 0.1 * Math.sin(t / 400);
  rect(g, '#5ee7ff', x + 2, y + 1 + b, 12, 10);
  g.globalAlpha = 1;
  rect(g, 'rgba(0,0,0,0.25)', x + 2, y + 14, 12, 2);
  rect(g, '#9aa0ad', x + 3, y + 10, 10, 5);
  rect(g, '#c2c7d0', x + 3, y + 10, 10, 1);
  rect(g, '#5ee7ff', x + 6, y + 3 + b, 4, 6);
  rect(g, '#5ee7ff', x + 7, y + 2 + b, 2, 8);
  rect(g, '#d6faff', x + 7, y + 4 + b, 1, 2);
}

function drawBoss(g, b, t, hitAt, hp, maxHp) {
  const x = b.x * TILE;
  const breathe = Math.round(Math.sin(t / 500));
  const y = b.y * TILE + breathe;
  const flash = t - hitAt < 250;
  rect(g, 'rgba(0,0,0,0.35)', x + 2, b.y * TILE + 29, 28, 3);
  rect(g, '#5d616c', x + 6, y + 25, 7, 6);
  rect(g, '#5d616c', x + 19, y + 25, 7, 6);
  rect(g, '#6b707b', x, y + 9, 4, 14);
  rect(g, '#6b707b', x + 28, y + 9, 4, 14);
  rect(g, '#3a3d45', x + 3, y + 5, 26, 22);
  rect(g, '#7a7f8c', x + 4, y + 6, 24, 20);
  for (let i = 0; i < 4; i += 1) {
    rect(g, '#2b2d33', x + 7, y + 11 + i * 4, 18, 2);
    const on = Math.floor(t / 300 + i * 1.7) % 3 !== 0;
    const led = i % 2 ? '#ffb703' : '#3ddc84';
    rect(g, on ? led : '#1f2125', x + 22, y + 11 + i * 4, 2, 2);
  }
  rect(g, '#3a3d45', x + 7, y - 1, 18, 9);
  rect(g, '#8d929e', x + 8, y, 16, 7);
  rect(g, '#ff3b3b', x + 11, y + 3, 3, 2);
  rect(g, '#ff3b3b', x + 18, y + 3, 3, 2);
  rect(g, '#2b2d33', x + 10, y - 3, 1, 3);
  rect(g, '#2b2d33', x + 21, y - 4, 1, 4);
  rect(g, '#2b2d33', x + 15, y - 2, 2, 2);
  if (flash) {
    g.globalAlpha = 0.7;
    rect(g, '#fff', x, y - 4, 32, 36);
    g.globalAlpha = 1;
  }
  // health bar
  const bw = 36;
  rect(g, '#1b1f3a', x - 3, b.y * TILE - 10, bw + 2, 5);
  rect(g, '#ff3b3b', x - 2, b.y * TILE - 9, Math.round((bw * hp) / maxHp), 3);
}

function drawTrophy(g, b, t) {
  const x = b.x * TILE + 8;
  const y = b.y * TILE + 6 + Math.round(Math.sin(t / 300) * 1.5);
  g.globalAlpha = 0.3;
  rect(g, '#f4d35e', x - 4, y - 4, 24, 24);
  g.globalAlpha = 1;
  rect(g, '#f4d35e', x + 2, y, 12, 8);
  rect(g, '#f4d35e', x + 5, y + 8, 6, 4);
  rect(g, '#c99a2e', x + 3, y + 12, 10, 3);
  rect(g, '#fff6c9', x + 4, y + 1, 2, 4);
}

/* ---------- persistence ---------- */

function storageKey() {
  return `questline-v1:${window.location.pathname}`;
}

function loadSave() {
  try {
    return JSON.parse(localStorage.getItem(storageKey())) || null;
  } catch (e) {
    return null;
  }
}

function writeSave(data) {
  try {
    localStorage.setItem(storageKey(), JSON.stringify(data));
  } catch (e) {
    // storage unavailable: progress lives only in memory
  }
}

function clearSave() {
  try {
    localStorage.removeItem(storageKey());
  } catch (e) {
    // ignore
  }
}

/* ---------- dialog ---------- */

/** Thrown when the player closes a dialog with Esc; ends the current encounter. */
class DialogClosed extends Error {}

function createDialog(root, overlay) {
  let openedAt = 0;

  function open({
    speaker, role, title, lines = [], link, note, tone, choices,
  }) {
    return new Promise((resolve, reject) => {
      const panel = el('div', {
        class: `questline-panel${tone ? ` questline-panel-${tone}` : ''}`,
        role: 'dialog',
        'aria-label': speaker || title || 'Message',
      });
      if (speaker) panel.append(el('p', { class: 'questline-speaker', text: speaker }));
      if (role) panel.append(el('p', { class: 'questline-role', text: role }));
      if (title) panel.append(el('p', { class: 'questline-panel-title', text: title }));
      lines.filter(Boolean).forEach((line) => panel.append(el('p', { class: 'questline-text', text: line })));
      if (note) panel.append(el('p', { class: 'questline-note', text: note }));
      if (link) {
        panel.append(el('p', { class: 'questline-learn' }, el('a', {
          href: link.href, target: '_blank', rel: 'noopener', text: `📜 ${link.text || 'Review the collateral'}`,
        })));
      }
      const numbered = choices.length > 1 && choices.every((c) => c.numbered);
      const list = el('div', { class: `questline-choices${numbered ? ' questline-choices-stacked' : ''}` });
      const buttons = choices.map((c, i) => el('button', {
        type: 'button',
        class: `questline-choice${c.primary ? ' primary' : ''}`,
        onclick: () => {
          if (performance.now() - openedAt < 200) return; // swallow key-repeat from the opening key
          overlay.hidden = true;
          overlay.replaceChildren();
          resolve(c.value);
        },
      }, numbered ? el('span', { class: 'questline-key', text: `${i + 1}` }) : null, c.label));
      list.append(...buttons);
      panel.append(list);

      panel.addEventListener('keydown', (e) => {
        const idx = buttons.indexOf(document.activeElement);
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          overlay.hidden = true;
          overlay.replaceChildren();
          reject(new DialogClosed());
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
          buttons[(idx + 1) % buttons.length].focus();
          e.preventDefault();
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
          buttons[(idx - 1 + buttons.length) % buttons.length].focus();
          e.preventDefault();
        } else if (numbered && /^[1-9]$/.test(e.key) && buttons[Number(e.key) - 1]) {
          buttons[Number(e.key) - 1].click();
        }
      });

      overlay.replaceChildren(panel);
      overlay.hidden = false;
      openedAt = performance.now();
      buttons[0].focus({ preventScroll: true });
      if (window.innerWidth < 700) overlay.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  return { open, isOpen: () => !overlay.hidden, root };
}

/* ---------- game ---------- */

export default function decorate(block) {
  const content = parseContent(block);
  const world = buildWorld();
  const numGates = Math.min(MAX_GATES, content.puzzles.length);
  const gateQuestions = Array.from(
    { length: MAX_GATES },
    (_, gi) => content.puzzles.map((_q, idx) => idx).filter((idx) => idx % numGates === gi),
  );
  const npcs = content.npcs.slice(0, world.npcSpots.length).map((npc, i) => ({
    ...npc, ...world.npcSpots[i], pal: `npc${i % 5}`,
  }));
  const maxHp = content.objections.length;
  const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
  // each play is taught by the advisor named in "taught by", otherwise round-robin
  const plays = content.plays.map((p, i) => {
    let teacher = p.teacher
      ? npcs.findIndex((n) => n.name.toLowerCase().includes(p.teacher.toLowerCase()))
      : -1;
    if (teacher < 0 && npcs.length) teacher = i % npcs.length;
    return { ...p, teacher };
  });
  // every skill that can be learned in this realm: expertise areas and plays
  const catalog = [
    ...npcs.filter((n) => n.expertise).map((n) => ({ kind: 'expertise', name: n.expertise })),
    ...plays.map((p) => ({ kind: 'play', name: p.name })),
  ];
  const customers = content.customers.slice(0, world.houses.length).map((c, i) => {
    const wanted = c.requires.length ? c.requires : [c.best].filter(Boolean);
    // unknown skill names are ignored so a typo can never lock a customer forever
    const needs = wanted.map((w) => catalog.find((s) => same(s.name, w))).filter(Boolean);
    let tier = 1; // cottage
    if (needs.length >= 4) tier = 3; // manor
    else if (needs.length >= 2) tier = 2; // townhouse
    return {
      ...c, house: world.houses[i], needs, tier,
    };
  });
  const playFor = (c) => plays.find((p) => c.best && same(p.name, c.best));

  /* state */
  const fresh = () => ({
    x: world.start.x,
    y: world.start.y,
    dir: 'right',
    talked: [],
    plays: [],
    deals: [],
    solved: [],
    gates: Array.from({ length: MAX_GATES }, (_, i) => i >= numGates),
    xp: 0,
    heard: [],
    missed: [],
    shrine: false,
    bossSolved: [],
    bossHp: maxHp,
    won: false,
    history: [],
    startedAt: 0,
    finishedIn: 0,
  });
  const saved = loadSave();
  let state = { ...fresh(), ...(saved || {}) };
  if (!Array.isArray(state.gates) || state.gates.length !== MAX_GATES) state.gates = fresh().gates;
  state.bossHp = maxHp - (state.bossSolved || []).length;
  const skills = () => [
    ...state.talked.filter((ni) => npcs[ni]?.expertise).map((ni) => ({ kind: 'expertise', name: npcs[ni].expertise })),
    ...state.plays.filter((pi) => plays[pi]).map((pi) => ({ kind: 'play', name: plays[pi].name })),
  ];
  const hasSkill = (name) => skills().some((s) => same(s.name, name));
  const missingFor = (c) => c.needs.filter((s) => !hasSkill(s.name));
  const unlearned = (ni) => plays
    .map((p, pi) => pi)
    .filter((pi) => plays[pi].teacher === ni && !state.plays.includes(pi));
  const motion = {
    moving: false, tx: state.x, ty: state.y, prog: 0,
  };
  const held = [];
  let busy = true;
  let bossHitAt = -1000;
  const particles = [];

  const save = () => writeSave(state);

  /* DOM */
  const canvas = el('canvas', {
    class: 'questline-canvas', width: COLS * TILE, height: ROWS * TILE, 'aria-label': `${content.title} game map`, role: 'img',
  });
  const g = canvas.getContext('2d');
  g.imageSmoothingEnabled = false;

  const levelEl = el('span', { class: 'questline-levelbox' });
  const skillsEl = el('div', { class: 'questline-skills' });
  const insightEl = el('span', { class: 'questline-stat' });
  const dealEl = el('span', { class: 'questline-stat' });
  const gateEl = el('span', { class: 'questline-stat' });
  const objectiveEl = el('p', { class: 'questline-objective' });
  const hintEl = el('p', { class: 'questline-hint', 'aria-live': 'polite' });
  const overlay = el('div', { class: 'questline-overlay', hidden: true });
  const stage = el('div', { class: 'questline-stage', tabindex: '0', 'aria-label': 'Game. Use arrow keys or WASD to move, Space to interact.' }, canvas);
  const screen = el('div', { class: 'questline-screen' }, stage, overlay);

  // customer logo signs, positioned over the house roofs (HTML keeps logos crisp)
  const pct = (v, total) => `${(v / total) * 100}%`;
  const initials = (name) => name.split(/\s+/).map((w) => w[0]).join('')
    .slice(0, 3)
    .toUpperCase();
  const signs = customers.map((c) => {
    const sign = el(
      'div',
      { class: `questline-sign questline-sign-tier${c.tier}` },
      c.logo
        ? el('img', { src: c.logo.src, alt: c.logo.alt || c.company })
        : el('span', { text: initials(c.company) }),
    );
    Object.assign(sign.style, {
      left: pct(c.house.x * TILE + 3, COLS * TILE),
      top: pct(c.house.y * TILE + 1, ROWS * TILE),
      width: pct(26, COLS * TILE),
      height: pct(11, ROWS * TILE),
    });
    sign.title = c.company;
    return sign;
  });
  if (signs.length) stage.append(el('div', { class: 'questline-signs' }, signs));

  // expert nameplate: shown above the nearest expert when the player walks close
  const plateName = el('span', { class: 'questline-plate-name' });
  const plateRole = el('span', { class: 'questline-plate-role' });
  const plate = el('div', { class: 'questline-plate', hidden: true }, plateName, plateRole);
  stage.append(plate);
  let plateFor = -1;
  function updatePlate(show) {
    let nearest = -1;
    if (show) {
      nearest = npcs.findIndex((n) => n.expertise
        && Math.max(Math.abs(n.x - state.x), Math.abs(n.y - state.y)) <= 2);
    }
    if (nearest === plateFor) return;
    plateFor = nearest;
    plate.hidden = nearest < 0;
    if (nearest < 0) return;
    const n = npcs[nearest];
    plateName.textContent = n.name;
    plateRole.textContent = `★ Expert for ${n.expertise}`;
    plate.style.left = pct(n.x * TILE + TILE / 2, COLS * TILE);
    plate.style.top = pct(n.y * TILE - 12, ROWS * TILE);
  }

  const padBtn = (dir, label) => el('button', {
    type: 'button', class: `questline-pad-${dir}`, 'aria-label': `Move ${dir}`, 'data-dir': dir, text: label,
  });
  const actionBtn = el('button', { type: 'button', class: 'questline-pad-a', 'aria-label': 'Interact' }, 'A');
  const pad = el(
    'div',
    { class: 'questline-pad' },
    el('div', { class: 'questline-dpad' }, padBtn('up', '▲'), padBtn('left', '◀'), padBtn('right', '▶'), padBtn('down', '▼')),
    actionBtn,
  );

  const storyBtn = el('button', { type: 'button', class: 'questline-tool', text: 'Story mode' });
  const resetBtn = el('button', { type: 'button', class: 'questline-tool', text: 'Restart' });

  block.replaceChildren(
    el(
      'div',
      { class: 'questline-hud' },
      el('p', { class: 'questline-title', text: content.title }),
      el('div', { class: 'questline-stats' }, levelEl, insightEl, customers.length ? dealEl : null, gateEl),
    ),
    skillsEl,
    objectiveEl,
    screen,
    hintEl,
    pad,
    el('div', { class: 'questline-toolbar' }, storyBtn, resetBtn),
  );

  const dialog = createDialog(block, overlay);

  /* HUD */
  function updateHud() {
    const into = state.xp % XP_PER_LEVEL;
    const fill = el('span', { class: 'questline-xpfill' });
    fill.style.width = `${(into / XP_PER_LEVEL) * 100}%`;
    levelEl.replaceChildren(
      el('span', { class: 'questline-level', text: `Lv ${levelOf(state.xp)}` }),
      el('span', { class: 'questline-rank', text: PLAYER_LOOKS[lookIndex(levelOf(state.xp))].title }),
      el('span', { class: 'questline-xpbar' }, fill),
      el('span', { class: 'questline-xptext', text: `${into}/${XP_PER_LEVEL} XP` }),
    );
    levelEl.setAttribute('aria-label', `Level ${levelOf(state.xp)}, ${state.xp} XP total`);

    const learned = skills();
    skillsEl.replaceChildren(
      el('span', { class: 'questline-label', text: 'Skills' }),
      ...(learned.length
        ? learned.map((s) => el('span', {
          class: `questline-chip questline-chip-${s.kind}`,
          text: `${s.kind === 'play' ? '📘' : '★'} ${s.name}`,
        }))
        : [el('span', { class: 'questline-chip-empty', text: 'None yet. Talk to people to learn.' })]),
    );
    insightEl.textContent = plays.length
      ? `Plays ${state.plays.length}/${plays.length}`
      : `Insights ${state.talked.length}/${npcs.length}`;
    dealEl.textContent = `Deals ${state.deals.length}/${customers.length}`;
    gateEl.textContent = `Gates ${state.gates.slice(0, numGates).filter(Boolean).length}/${numGates}`;
    signs.forEach((s, i) => s.classList.toggle('won', state.deals.includes(i)));
    const nextGate = state.gates.findIndex((open) => !open);
    let objective;
    const ready = customers.some((c, i) => !state.deals.includes(i) && !missingFor(c).length);
    if (state.won) objective = `🏅 ${content.title} cleared. Replay any time.`;
    else if (state.deals.length < customers.length && ready) {
      objective = 'Objective: a customer is ready for your pitch. Knock on a door with a gold !';
    } else if (state.deals.length < customers.length) {
      objective = 'Objective: learn the skills customers need (🔒 doors). Experts with ! teach them';
    } else if (nextGate >= 0) objective = `Objective: open Rune Gate ${nextGate + 1}`;
    else objective = `Objective: defeat ${content.bossName}`;
    objectiveEl.textContent = objective;
  }

  /* world queries */
  const npcAt = (x, y) => npcs.findIndex((n) => n.x === x && n.y === y);
  const gateAt = (x, y) => world.gates.findIndex((gt) => gt.x === x && gt.y === y);
  const isBoss = (x, y) => state.bossHp > 0
    && x >= world.boss.x && x <= world.boss.x + 1 && y >= world.boss.y && y <= world.boss.y + 1;
  const isShrine = (x, y) => x === world.shrine.x && y === world.shrine.y;
  const customerAt = (x, y) => customers.findIndex(
    (c) => y === c.house.y + 1 && (x === c.house.x || x === c.house.x + 1),
  );

  function walkable(x, y) {
    if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return false;
    if (npcAt(x, y) >= 0 || isBoss(x, y) || isShrine(x, y)) return false;
    const c = world.grid[y][x];
    if (c === 'G') return state.gates[gateAt(x, y)];
    return WALKABLE.has(c);
  }

  function facing() {
    const [dx, dy] = DIRS[state.dir];
    const x = state.x + dx;
    const y = state.y + dy;
    const n = npcAt(x, y);
    if (n >= 0) {
      const role = npcs[n].expertise ? ` (expert for ${npcs[n].expertise})` : '';
      return { type: 'npc', index: n, label: `talk to ${npcs[n].name}${role}` };
    }
    const ci = customerAt(x, y);
    if (ci >= 0) {
      const c = customers[ci];
      let label = `visit ${c.company}`;
      if (!state.deals.includes(ci)) {
        const have = c.needs.length - missingFor(c).length;
        label = `knock on ${c.company}'s door (skills ${have}/${c.needs.length})`;
      }
      return { type: 'customer', index: ci, label };
    }
    const gi = gateAt(x, y);
    if (gi >= 0 && !state.gates[gi]) return { type: 'gate', index: gi, label: `read Rune Gate ${gi + 1}` };
    if (isShrine(x, y)) return { type: 'shrine', label: 'touch the Shrine of Insight' };
    if (isBoss(x, y)) return { type: 'boss', label: `challenge ${content.bossName}` };
    return null;
  }

  function burst(tx, ty, color, count = 18) {
    for (let i = 0; i < count; i += 1) {
      const a = Math.random() * Math.PI * 2;
      const v = 20 + Math.random() * 50;
      particles.push({
        x: tx * TILE + 8,
        y: ty * TILE + 8,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        life: 0.8,
        color,
      });
    }
  }

  /* progression */
  const toasts = el('div', { class: 'questline-toasts', 'aria-live': 'polite' });
  stage.append(toasts);
  function toast(text, kind = 'xp') {
    const t = el('div', { class: `questline-toast questline-toast-${kind}`, text });
    toasts.append(t);
    setTimeout(() => t.remove(), 2800);
  }

  function gain(amount, label) {
    if (amount <= 0) return;
    const before = levelOf(state.xp);
    state.xp += amount;
    toast(`+${amount} XP · ${label}`);
    const after = levelOf(state.xp);
    if (after > before) {
      toast(`⬆ Level ${after}!`, 'level');
      const look = lookIndex(after);
      if (look !== lookIndex(before)) toast(`✨ New look: ${PLAYER_LOOKS[look].title}`, 'level');
      burst(state.x, state.y, '#f4d35e', 30);
    }
    updateHud();
    save();
  }
  // full XP on the first try, half after the answer has been revealed
  const reward = (base, id) => (state.missed.includes(id) ? Math.ceil(base / 2) : base);
  const miss = (id) => {
    if (!state.missed.includes(id)) state.missed.push(id);
    save();
  };

  /* encounters */
  const next = (label = 'Next ▸') => [{ label, value: true, primary: true }];

  async function ask(q, speaker, lines = [q.prompt]) {
    const options = shuffle([
      { label: q.answer, value: true, numbered: true },
      ...q.wrong.map((w) => ({ label: w, value: false, numbered: true })),
    ]);
    const ok = await dialog.open({
      speaker, lines, tone: speaker.startsWith(content.bossName) ? 'boss' : null, choices: options,
    });
    state.history.push(ok);
    save();
    return ok;
  }

  async function talkTo(i) {
    const npc = npcs[i];
    const lines = npc.lines.length ? npc.lines : ['…'];
    const first = !state.talked.includes(i);
    const role = npc.expertise ? `★ Expert for ${npc.expertise}` : null;
    let note = null;
    if (first) note = npc.expertise ? `★ New skill: ${npc.expertise} · +${XP.meet} XP` : `+${XP.meet} XP`;
    for (let k = 0; k < lines.length; k += 1) {
      const last = k === lines.length - 1;
      await dialog.open({
        speaker: npc.name,
        role,
        lines: [lines[k]],
        link: last ? npc.link : null,
        note: last ? note : null,
        choices: next(last ? 'Got it' : 'Next ▸'),
      });
    }
    if (first) {
      state.talked.push(i);
      burst(npc.x, npc.y, '#f4d35e', 12);
      if (npc.expertise) toast(`★ New skill: ${npc.expertise}`, 'skill');
      gain(XP.meet, `met ${npc.name}`);
    }
    const teach = unlearned(i);
    for (let k = 0; k < teach.length; k += 1) {
      const play = plays[teach[k]];
      await dialog.open({
        tone: 'play',
        speaker: npc.name,
        role,
        title: `📘 New play: ${play.name}`,
        lines: [play.description],
        link: play.link,
        note: `+${XP.play} XP · Playbook ${state.plays.length + 1}/${plays.length}`,
        choices: next('Learned it'),
      });
      state.plays.push(teach[k]);
      burst(npc.x, npc.y, '#8ecae6', 14);
      toast(`📘 New play: ${play.name}`, 'skill');
      gain(XP.play, play.name);
    }
  }

  async function visitCustomer(ci) {
    const c = customers[ci];
    const who = c.contact || c.company;
    const speaker = c.contact ? `${c.contact} · ${c.company}` : c.company;
    const id = `c${ci}`;
    if (state.deals.includes(ci)) {
      await dialog.open({
        speaker,
        lines: [`Good to see you again! The ${c.best || 'project'} is off to a great start.`],
        choices: next('See you'),
      });
      return true;
    }
    const lines = c.situation.length ? c.situation : [`Welcome to ${c.company}. How can you help us?`];
    for (let k = 0; k < lines.length; k += 1) {
      await dialog.open({ speaker, lines: [lines[k]], choices: next() });
    }
    if (!state.heard.includes(ci)) {
      state.heard.push(ci);
      gain(XP.hear, `discovery at ${c.company}`);
    }
    if (!c.best) return true;
    const missing = missingFor(c);
    if (missing.length) {
      const icon = (s) => (s.kind === 'play' ? '📘' : '★');
      await dialog.open({
        speaker,
        lines: [
          'So… what would you suggest?',
          `To advise ${c.company} you need ${c.needs.length} skill${c.needs.length === 1 ? '' : 's'}:`,
          ...c.needs.map((s) => `${hasSkill(s.name) ? '✅' : '🔒'} ${icon(s)} ${s.name}`),
        ],
        note: `Still missing ${missing.length}. Experts teach these skills.`,
        choices: next('I’ll be back'),
      });
      return false;
    }

    const options = plays.map((p) => ({ label: p.name, value: p.name, numbered: true }));
    if (!playFor(c)) options.push({ label: c.best, value: c.best, numbered: true });
    const pick = await dialog.open({
      speaker: 'Your strategy',
      lines: [`Which play fits ${c.company}?`],
      choices: shuffle(options),
    });
    const ok = same(pick, c.best);
    state.history.push(ok);
    const best = playFor(c);
    if (ok) {
      state.deals.push(ci);
      burst(c.house.x + 0.5, c.house.y + 1, '#3ddc84', 30);
      gain(reward(XP.deal, id), `deal won: ${c.company}`);
      await dialog.open({
        tone: 'good',
        title: `🤝 Deal won: ${c.company}`,
        lines: [`${who}: “That is exactly what we need. Let’s do it.”`],
        choices: next('Onward'),
      });
      return true;
    }
    miss(id);
    await dialog.open({
      tone: 'bad',
      title: 'Not convinced',
      lines: [
        `${who}: “I don’t see how that solves our problem.”`,
        `Better fit: ${c.best}${best?.description ? `. ${best.description}` : ''}`,
      ],
      note: 'No XP this time. Knock again to propose the better play.',
      link: best?.link || c.link,
      choices: next('Continue'),
    });
    return false;
  }

  async function challengeGate(gi, { skipIntro = false } = {}) {
    const pending = gateQuestions[gi].filter((idx) => !state.solved.includes(idx));
    if (!skipIntro) {
      const go = await dialog.open({
        speaker: `Rune Gate ${gi + 1}`,
        lines: [`The runes glow. Answer ${pending.length} question${pending.length === 1 ? '' : 's'} to pass.`],
        choices: [{ label: 'Begin', value: true, primary: true }, { label: 'Not yet', value: false }],
      });
      if (!go) return false;
    }
    for (let k = 0; k < pending.length; k += 1) {
      const q = content.puzzles[pending[k]];
      const id = `g${pending[k]}`;
      const ok = await ask(q, `Rune Gate ${gi + 1}`);
      if (!ok) {
        miss(id);
        await dialog.open({
          tone: 'bad',
          title: 'Not quite',
          lines: [`Correct answer: ${q.answer}`],
          note: 'No XP this time. Read the rune again when you are ready.',
          link: q.link,
          choices: next('Continue'),
        });
        return false;
      }
      state.solved.push(pending[k]);
      gain(reward(XP.gate, id), 'rune answered');
      if (k < pending.length - 1) {
        await dialog.open({ tone: 'good', title: 'Correct!', choices: next('Continue') });
      }
    }
    state.gates[gi] = true;
    burst(world.gates[gi].x, world.gates[gi].y, GATE_COLORS[gi], 28);
    updateHud();
    save();
    await dialog.open({
      tone: 'good', title: `Rune Gate ${gi + 1} opens!`, lines: ['The stone slides aside.'], choices: next('Onward'),
    });
    return true;
  }

  async function victory() {
    state.won = true;
    if (!state.finishedIn) state.finishedIn = Date.now() - (state.startedAt || Date.now());
    burst(world.boss.x + 0.5, world.boss.y + 0.5, '#f4d35e', 40);
    updateHud();
    save();
    const right = state.history.filter(Boolean).length;
    const total = state.history.length || 1;
    const mins = Math.floor(state.finishedIn / 60000);
    const secs = String(Math.floor((state.finishedIn % 60000) / 1000)).padStart(2, '0');
    const levelLine = `Level ${levelOf(state.xp)} · ${state.xp} XP · ${skills().length} skills`;
    const summary = `Accuracy ${Math.round((right / total) * 100)}% · ${right}/${total} correct · ${mins}:${secs}`;
    const grid = state.history.slice(-20).map((ok) => (ok ? '🟩' : '🟥')).join('');
    let again = true;
    while (again) {
      const choice = await dialog.open({
        tone: 'good',
        title: `🏅 ${content.title} cleared!`,
        lines: [
          `${content.bossName} has been defeated.`,
          levelLine,
          summary,
          customers.length ? `Deals won: ${state.deals.length}/${customers.length}` : '',
        ],
        choices: [
          { label: 'Copy result', value: 'copy', primary: true },
          { label: 'Keep exploring', value: 'close' },
        ],
      });
      again = choice === 'copy';
      if (again) {
        const text = `Questline · ${content.title} cleared 🏅\n${levelLine}\n${summary}\n${grid}\n${window.location.href}`;
        try {
          await navigator.clipboard.writeText(text);
        } catch (e) {
          // clipboard blocked: nothing else to do
        }
        await dialog.open({ title: 'Copied!', lines: ['Paste it into your team channel.'], choices: next('Back') });
      }
    }
  }

  async function fightBoss({ skipIntro = false, story = false } = {}) {
    if (state.deals.length < customers.length) {
      await dialog.open({
        tone: 'boss',
        speaker: content.bossName,
        lines: ['“Ha! You haven’t even won the village accounts. Come back when customers trust you.”'],
        note: `Deals won: ${state.deals.length}/${customers.length}`,
        choices: next('Retreat'),
      });
      return false;
    }
    if (!skipIntro) {
      const go = await dialog.open({
        tone: 'boss',
        speaker: content.bossName,
        lines: ['“Why would anyone switch from me? Everyone already knows me.”', `Counter ${maxHp} objection${maxHp === 1 ? '' : 's'} to win the deal.`],
        choices: [{ label: 'Make your case', value: true, primary: true }, { label: 'Retreat', value: false }],
      });
      if (!go) return false;
    }
    let queue = content.objections.map((_, i) => i).filter((i) => !state.bossSolved.includes(i));
    while (queue.length) {
      const idx = queue[0];
      const q = content.objections[idx];
      const id = `o${idx}`;
      const ok = await ask(q, `${content.bossName} objects`, [`“${q.prompt}”`, 'Pick your best response:']);
      if (ok) {
        queue = queue.slice(1);
        state.bossSolved.push(idx);
        state.bossHp = maxHp - state.bossSolved.length;
        bossHitAt = performance.now();
        burst(world.boss.x + 0.5, world.boss.y + 0.5, '#ffffff', 16);
        gain(reward(XP.objection, id), 'objection countered');
        if (state.bossHp > 0) {
          await dialog.open({
            tone: 'good', title: 'Direct hit!', lines: [`${content.bossName} staggers. ${state.bossHp} objection${state.bossHp === 1 ? '' : 's'} left.`], choices: next('Keep going'),
          });
        }
      } else {
        miss(id);
        queue = [...queue.slice(1), idx];
        const goOn = await dialog.open({
          tone: 'bad',
          title: 'Blocked!',
          lines: [`${content.bossName} shrugs it off. Better response: ${q.answer}`],
          note: 'No XP this time. The objection will come back.',
          link: q.link,
          choices: story ? next('Continue') : [
            { label: 'Continue', value: true, primary: true },
            { label: 'Retreat and review', value: false },
          ],
        });
        if (!goOn) return false;
      }
    }
    await victory();
    return true;
  }

  async function visitShrine() {
    const first = !state.shrine;
    state.shrine = true;
    burst(world.shrine.x, world.shrine.y, '#5ee7ff', 16);
    if (first) gain(XP.shrine, 'studied at the shrine');
    await dialog.open({
      speaker: 'Shrine of Insight',
      lines: [content.shrine?.text || 'The crystal shows you the key collateral.'],
      note: first ? `+${XP.shrine} XP` : 'You have already studied here.',
      link: content.shrine?.link,
      choices: next('Thanks'),
    });
  }

  async function run(encounter) {
    if (busy) return;
    busy = true;
    held.length = 0;
    try {
      await encounter();
    } catch (e) {
      if (!(e instanceof DialogClosed)) throw e; // Esc: leave the conversation, progress is kept
    } finally {
      busy = false;
      stage.focus({ preventScroll: true });
    }
  }

  function interact() {
    if (busy || motion.moving) return;
    const target = facing();
    if (!target) return;
    if (target.type === 'npc') run(() => talkTo(target.index));
    else if (target.type === 'customer') run(() => visitCustomer(target.index));
    else if (target.type === 'gate') run(() => challengeGate(target.index));
    else if (target.type === 'shrine') run(visitShrine);
    else if (target.type === 'boss') run(() => fightBoss());
  }

  async function storyMode() {
    block.classList.add('questline-story');
    try {
      for (let i = 0; i < npcs.length; i += 1) {
        if (!state.talked.includes(i) || unlearned(i).length) await talkTo(i);
      }
      for (let ci = 0; ci < customers.length; ci += 1) {
        while (!state.deals.includes(ci)) await visitCustomer(ci);
      }
      for (let gi = 0; gi < numGates; gi += 1) {
        while (!state.gates[gi]) await challengeGate(gi, { skipIntro: true });
      }
      while (state.bossHp > 0) await fightBoss({ skipIntro: state.bossHp < maxHp, story: true });
      state.x = world.boss.x - 1;
      state.y = world.boss.y + 1;
      state.dir = 'right';
      save();
    } finally {
      block.classList.remove('questline-story');
    }
  }

  function begin() {
    if (!state.startedAt) state.startedAt = Date.now();
    save();
  }

  async function intro() {
    const hasProgress = saved && (saved.talked?.length || saved.solved?.length || saved.won);
    const choice = await dialog.open({
      tone: 'intro',
      title: content.title,
      lines: [content.intro],
      note: 'Move: arrow keys / WASD or the on-screen pad · Interact: Space, Enter or A · Esc closes a conversation',
      choices: [
        { label: hasProgress ? 'Continue quest' : 'Start quest', value: 'play', primary: true },
        { label: 'Story mode (no walking)', value: 'story' },
      ],
    });
    begin();
    if (choice === 'story') await storyMode();
  }

  storyBtn.addEventListener('click', () => run(async () => { begin(); await storyMode(); }));
  resetBtn.addEventListener('click', () => run(async () => {
    const yes = await dialog.open({
      title: 'Restart the quest?',
      lines: ['This clears your progress on this device.'],
      choices: [{ label: 'Restart', value: true, primary: true }, { label: 'Cancel', value: false }],
    });
    if (!yes) return;
    clearSave();
    state = fresh();
    motion.moving = false;
    updateHud();
    await intro();
  }));

  /* input */
  function tryStep(dir) {
    if (motion.moving || busy) return;
    state.dir = dir;
    const [dx, dy] = DIRS[dir];
    if (walkable(state.x + dx, state.y + dy)) {
      motion.moving = true;
      motion.tx = state.x + dx;
      motion.ty = state.y + dy;
      motion.prog = 0;
    }
  }

  let actionArmed = false;
  const press = (dir) => {
    const i = held.indexOf(dir);
    if (i >= 0) held.splice(i, 1);
    held.push(dir);
  };
  const release = (dir) => {
    const i = held.indexOf(dir);
    if (i >= 0) held.splice(i, 1);
  };

  block.addEventListener('keydown', (e) => {
    if (e.target.closest('.questline-overlay') || e.target.closest('button')) return;
    const dir = KEYMAP[e.code];
    if (dir) {
      e.preventDefault();
      if (!busy) {
        press(dir);
        tryStep(dir); // a quick tap still moves one tile
      }
    } else if (ACTION_KEYS.includes(e.code)) {
      e.preventDefault();
      // only a key pressed *on the map* may interact: the Enter that closes a dialog
      // lands its keyup here after focus returns, and must not reopen the conversation
      if (!busy && !e.repeat) actionArmed = true;
    }
  });
  block.addEventListener('keyup', (e) => {
    const dir = KEYMAP[e.code];
    if (dir) release(dir);
    if (ACTION_KEYS.includes(e.code) && actionArmed) {
      actionArmed = false;
      if (!e.target.closest('.questline-overlay') && !e.target.closest('button')) interact();
    }
  });
  stage.addEventListener('blur', () => { held.length = 0; });
  canvas.addEventListener('pointerdown', () => stage.focus({ preventScroll: true }));

  pad.querySelectorAll('[data-dir]').forEach((btn) => {
    const { dir } = btn.dataset;
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      btn.setPointerCapture(e.pointerId);
      if (!busy) {
        press(dir);
        tryStep(dir);
      }
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => btn.addEventListener(ev, () => release(dir)));
  });
  actionBtn.addEventListener('click', interact);

  /* loop */
  let lastHint = null;

  /* atmosphere: drifting pollen, arena embers, cloud shadows, light */
  const W = COLS * TILE;
  const H = ROWS * TILE;
  const ARENA_X = 18 * TILE;
  const motes = Array.from({ length: 34 }, (_, i) => {
    const ember = i % 3 === 0;
    return {
      ember,
      x: ember ? ARENA_X + 8 + Math.random() * (W - ARENA_X - 24) : Math.random() * (ARENA_X - 16),
      y: Math.random() * H,
      phase: Math.random() * 6,
      speed: 4 + Math.random() * 8,
    };
  });
  function updateMotes(dt) {
    motes.forEach((m) => {
      if (m.ember) {
        m.y -= m.speed * 1.6 * dt;
        if (m.y < TILE) {
          m.y = H - TILE;
          m.x = ARENA_X + 8 + Math.random() * (W - ARENA_X - 24);
        }
      } else {
        m.x += m.speed * dt;
        m.y -= m.speed * 0.3 * dt;
        if (m.x > ARENA_X - 8 || m.y < 0) {
          m.x = Math.random() * 40;
          m.y = Math.random() * H;
        }
      }
    });
  }

  function update(dt) {
    if (motion.moving) {
      motion.prog += dt * SPEED;
      if (motion.prog >= 1) {
        motion.moving = false;
        motion.prog = 0;
        state.x = motion.tx;
        state.y = motion.ty;
        save();
      }
    }
    if (held.length) tryStep(held[held.length - 1]);
    updateMotes(dt);
    for (let i = particles.length - 1; i >= 0; i -= 1) {
      const p = particles[i];
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 60 * dt;
      if (p.life <= 0) particles.splice(i, 1);
    }
    const target = !busy && !motion.moving ? facing() : null;
    const hint = target ? `Space / A: ${target.label}` : '';
    if (hint !== lastHint) {
      hintEl.textContent = hint || ' ';
      lastHint = hint;
    }
    updatePlate(!busy);
  }

  let terrain = null;
  let shade = null;
  let cloud = null;
  function buildOverlays() {
    terrain = buildTerrain(world.grid);
    shade = document.createElement('canvas');
    shade.width = W;
    shade.height = H;
    const sg = shade.getContext('2d');
    const dark = sg.createLinearGradient(ARENA_X - 24, 0, ARENA_X + 24, 0);
    dark.addColorStop(0, 'rgba(18,8,40,0)');
    dark.addColorStop(1, 'rgba(18,8,40,0.42)');
    sg.fillStyle = dark;
    sg.fillRect(ARENA_X - 24, 0, W - ARENA_X + 24, H);
    const vig = sg.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, W * 0.62);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(10,6,24,0.45)');
    sg.fillStyle = vig;
    sg.fillRect(0, 0, W, H);
    cloud = document.createElement('canvas');
    cloud.width = 120;
    cloud.height = 48;
    const cg = cloud.getContext('2d');
    cg.fillStyle = '#0c1430';
    const puffs = [[30, 26, 22, 14], [60, 20, 28, 16], [92, 27, 22, 13], [62, 32, 36, 10]];
    puffs.forEach(([cx, cy, rx, ry]) => {
      cg.beginPath();
      cg.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      cg.fill();
    });
  }

  function render(t) {
    if (!terrain) buildOverlays();
    g.drawImage(terrain, 0, 0);
    drawAnimatedTiles(g, world.grid, t);
    const bang = (x, y, phase, color = '#e63946', bg = '#fff') => {
      const by = y + Math.round(Math.sin(t / 250 + phase) * 1.5);
      rect(g, INK, x - 1, by - 1, 8, 10);
      rect(g, bg, x, by, 6, 8);
      rect(g, color, x + 2, by + 1, 2, 4);
      rect(g, color, x + 2, by + 6, 2, 1);
    };

    customers.forEach((c) => drawHouse(g, c.house.x, c.house.y, c.tier, t));
    world.houses.slice(customers.length).forEach((h) => drawHouse(g, h.x, h.y, 1, t));
    customers.forEach((c, i) => {
      const x = c.house.x * TILE;
      const y = c.house.y * TILE;
      const bob = Math.round(Math.sin(t / 250 + i) * 1.5);
      if (state.deals.includes(i)) drawCheck(g, x + 13, y + 11 + bob);
      else if (missingFor(c).length) drawLock(g, x + 13, y + 11 + bob);
      else {
        bang(x + 13, y + 11, i + 2, INK, '#f4d35e');
        glow(g, x + 16, y + 15, 14, '#6a5210', 0.9);
      }
    });
    world.gates.forEach((gt, i) => {
      drawGate(g, gt, i, state.gates[i], t);
      const pulse = 0.25 + 0.1 * Math.sin(t / 300 + i);
      if (!state.gates[i]) glow(g, gt.x * TILE + 8, gt.y * TILE + 8, 16, GATE_COLORS[i], pulse);
    });
    drawShrine(g, world.shrine, t);

    const px = (motion.moving ? state.x + (motion.tx - state.x) * motion.prog : state.x) * TILE;
    const py = (motion.moving ? state.y + (motion.ty - state.y) * motion.prog : state.y) * TILE;
    let step = 'stand';
    if (motion.moving) step = Math.floor(t / 130) % 2 ? 'a' : 'b';

    const actors = [
      ...npcs.map((n, i) => ({
        y: n.y * TILE,
        draw: () => {
          const bob = Math.floor(t / 600 + i) % 2;
          drawPerson(g, n.x * TILE, n.y * TILE - bob, 'down', 'stand', n.pal);
          if (unlearned(i).length) bang(n.x * TILE + 5, n.y * TILE - 11, i, '#2f6fd6');
          else if (!state.talked.includes(i)) bang(n.x * TILE + 5, n.y * TILE - 11, i);
        },
      })),
      {
        y: py,
        draw: () => {
          const li = lookIndex(levelOf(state.xp));
          drawPlayer(g, Math.round(px), Math.round(py), state.dir, step, li, t);
        },
      },
    ];
    if (state.bossHp > 0) {
      actors.push({
        y: world.boss.y * TILE + TILE,
        draw: () => drawBoss(g, world.boss, t, bossHitAt, state.bossHp, maxHp),
      });
    } else {
      actors.push({ y: world.boss.y * TILE, draw: () => drawTrophy(g, world.boss, t) });
    }
    actors.sort((a, b) => a.y - b.y).forEach((a) => a.draw());

    // clouds drift over the land
    g.globalAlpha = 0.09;
    [0, 1].forEach((k) => {
      const cx = ((((t / 1000) * (5 + k * 3)) + k * 260) % (W + 140)) - 130;
      g.drawImage(cloud, Math.round(cx), 30 + k * 120);
    });
    g.globalAlpha = 1;

    // dusk over the arena, then the lights that cut through it
    g.drawImage(shade, 0, 0);
    if (state.bossHp > 0) {
      const bx = world.boss.x * TILE;
      const by = world.boss.y * TILE + Math.round(Math.sin(t / 500));
      glow(g, bx + 12, by + 4, 9, '#ff2a2a', 0.9);
      glow(g, bx + 19, by + 4, 9, '#ff2a2a', 0.9);
    } else {
      glow(g, world.boss.x * TILE + 16, world.boss.y * TILE + 14, 26, '#7a6010', 1);
    }
    glow(g, world.shrine.x * TILE + 8, world.shrine.y * TILE + 6, 22, '#1d6f88', 0.7 + 0.2 * Math.sin(t / 400));

    motes.forEach((m) => {
      const wob = Math.sin(t / 700 + m.phase) * 3;
      const flick = 0.5 + 0.5 * Math.sin(t / 200 + m.phase * 3);
      g.globalAlpha = m.ember ? 0.5 + 0.5 * flick : 0.35 + 0.35 * flick;
      rect(g, m.ember ? '#ff9e3d' : '#fff6b0', Math.round(m.x + wob), Math.round(m.y), 1, 1);
    });
    g.globalAlpha = 1;

    particles.forEach((p) => {
      g.globalAlpha = Math.max(0, p.life / 0.8);
      rect(g, p.color, Math.round(p.x), Math.round(p.y), 2, 2);
    });
    g.globalAlpha = 1;
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (block.isConnected) {
      update(dt);
      render(now);
      requestAnimationFrame(frame);
    }
  }

  updateHud();
  requestAnimationFrame(frame);
  busy = false;
  run(intro);
}
