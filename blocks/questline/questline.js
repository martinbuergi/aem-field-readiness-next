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
 *             | <best play name> | <link>
 * Puzzles are spread across up to three rune gates; objections make up the boss fight.
 * Each customer lives in one of the village houses (max 3). To propose a strategy the
 * player must first learn every play from the experts; all deals must be won before the
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

const spriteCache = new Map();
function sprite(key, rows, palette) {
  if (spriteCache.has(key)) return spriteCache.get(key);
  const c = document.createElement('canvas');
  c.width = rows[0].length;
  c.height = rows.length;
  const g = c.getContext('2d');
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    if (palette[ch]) {
      g.fillStyle = palette[ch];
      g.fillRect(x, y, 1, 1);
    }
  }));
  spriteCache.set(key, c);
  return c;
}

function drawPerson(g, x, y, dir, step, palKey) {
  const facing = dir === 'left' || dir === 'right' ? 'side' : dir;
  const legs = LEGS[facing === 'side' ? 'side' : 'front'][step];
  const rows = [...HEAD[facing], ...TORSO[facing], ...legs];
  const img = sprite(`${palKey}-${facing}-${step}`, rows, PALETTES[palKey]);
  g.fillStyle = 'rgba(0,0,0,0.25)';
  g.fillRect(x + 4, y + 14, 8, 2);
  if (dir === 'left') {
    g.save();
    g.translate(x + TILE, y);
    g.scale(-1, 1);
    g.drawImage(img, 0, 0);
    g.restore();
  } else {
    g.drawImage(img, x, y);
  }
}

function rect(g, color, x, y, w, h) {
  g.fillStyle = color;
  g.fillRect(x, y, w, h);
}

function drawGrass(g, x, y, tx, ty) {
  rect(g, '#5fa04e', x, y, TILE, TILE);
  const h = hash(tx, ty);
  for (let i = 0; i < 4; i += 1) {
    const v = (h >>> (i * 7)) & 255;
    rect(g, '#4e8c40', x + (v % 14) + 1, y + ((v >>> 4) % 13) + 1, 1, 2);
  }
}

function drawTile(g, c, tx, ty, t) {
  const x = tx * TILE;
  const y = ty * TILE;
  const h = hash(tx, ty);
  switch (c) {
    case ':':
      rect(g, '#d8b77a', x, y, TILE, TILE);
      rect(g, '#c29d5e', x + (h % 12) + 2, y + ((h >>> 5) % 12) + 2, 2, 1);
      rect(g, '#c29d5e', x + ((h >>> 9) % 12) + 2, y + ((h >>> 13) % 12) + 2, 1, 1);
      break;
    case 'f': {
      drawGrass(g, x, y, tx, ty);
      const colors = ['#ff6b9a', '#ffd166', '#ffffff'];
      for (let i = 0; i < 3; i += 1) {
        const v = (h >>> (i * 8)) & 255;
        const fx = x + 2 + (v % 11);
        const fy = y + 2 + ((v >>> 4) % 11);
        rect(g, colors[(v + i) % 3], fx, fy, 2, 2);
        rect(g, '#3d7a33', fx, fy + 2, 1, 1);
      }
      break;
    }
    case 'T':
    case 't':
      drawGrass(g, x, y, tx, ty);
      rect(g, 'rgba(0,0,0,0.2)', x + 3, y + 13, 10, 2);
      rect(g, '#6b4226', x + 6, y + 10, 4, 5);
      rect(g, c === 'T' ? '#24572a' : '#2d6a2e', x + 2, y + 2, 12, 9);
      rect(g, c === 'T' ? '#24572a' : '#2d6a2e', x + 3, y + 1, 10, 11);
      rect(g, c === 'T' ? '#24572a' : '#2d6a2e', x + 1, y + 3, 14, 6);
      rect(g, '#3f8a3c', x + 4, y + 3, 4, 3);
      rect(g, '#3f8a3c', x + 9, y + 6, 2, 2);
      break;
    case '^':
    case 'G':
      rect(g, '#7a7f8c', x, y, TILE, TILE);
      rect(g, '#9aa0ad', x, y, TILE, 1);
      rect(g, '#5d616c', x, y + 7, TILE, 1);
      rect(g, '#5d616c', x, y + 15, TILE, 1);
      rect(g, '#5d616c', x + (ty % 2 ? 4 : 10), y, 1, 7);
      rect(g, '#5d616c', x + (ty % 2 ? 11 : 5), y + 8, 1, 7);
      break;
    case '~': {
      rect(g, '#3a7bd5', x, y, TILE, TILE);
      const o = Math.floor(t / 350 + tx + ty * 2) % 4;
      rect(g, '#6fa8ff', x + 2 + o * 2, y + 4, 4, 1);
      rect(g, '#6fa8ff', x + 9 - o, y + 11, 4, 1);
      break;
    }
    case '=':
      rect(g, '#3a7bd5', x, y, TILE, TILE);
      rect(g, '#a0703c', x + 1, y, 14, TILE);
      for (let i = 0; i < 4; i += 1) rect(g, '#7a5229', x + 1, y + i * 4 + 3, 14, 1);
      rect(g, '#5a3a1a', x + 1, y, 1, TILE);
      rect(g, '#5a3a1a', x + 14, y, 1, TILE);
      break;
    case ',':
    case 'P':
      rect(g, '#3d3357', x, y, TILE, TILE);
      rect(g, '#2e2645', x, y, TILE, 1);
      rect(g, '#2e2645', x, y, 1, TILE);
      if (h % 5 === 0) rect(g, '#2e2645', x + 4 + (h % 7), y + 5, 3, 1);
      if (c === 'P') {
        rect(g, 'rgba(0,0,0,0.3)', x + 2, y + 13, 12, 3);
        rect(g, '#8d86a8', x + 4, y + 2, 8, 12);
        rect(g, '#6b6488', x + 3, y + 12, 10, 3);
        rect(g, '#6b6488', x + 3, y + 1, 10, 2);
        rect(g, '#b388ff', x + 6, y - 2 + Math.round(Math.sin(t / 200 + tx) * 1), 4, 3);
      }
      break;
    default:
      drawGrass(g, x, y, tx, ty);
  }
}

function drawHouse(g, hx, hy) {
  const x = hx * TILE;
  const y = hy * TILE;
  rect(g, 'rgba(0,0,0,0.2)', x + 1, y + 29, 32, 3);
  rect(g, '#efe0c1', x + 1, y + 12, 30, 19);
  rect(g, '#d7c4a0', x + 1, y + 28, 30, 3);
  rect(g, '#c8553d', x - 1, y + 5, 34, 9);
  rect(g, '#c8553d', x + 3, y + 1, 26, 5);
  rect(g, '#a8432f', x - 1, y + 12, 34, 2);
  rect(g, '#a8432f', x + 3, y + 5, 26, 1);
  rect(g, '#a8432f', x + 3, y + 9, 26, 1);
  rect(g, '#6b4226', x + 13, y + 20, 6, 11);
  rect(g, '#f4d35e', x + 17, y + 25, 1, 1);
  [x + 4, x + 22].forEach((wx) => {
    rect(g, '#5a3a1a', wx - 1, y + 16, 8, 7);
    rect(g, '#8ecae6', wx, y + 17, 6, 5);
    rect(g, '#5a3a1a', wx + 3, y + 17, 1, 5);
  });
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

function createDialog(root, overlay) {
  let openedAt = 0;

  function open({
    speaker, role, title, lines = [], link, note, tone, choices,
  }) {
    return new Promise((resolve) => {
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
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
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
  const customers = content.customers.slice(0, world.houses.length).map((c, i) => ({
    ...c, house: world.houses[i],
  }));
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
      { class: 'questline-sign' },
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
    if (state.won) objective = `🏅 ${content.title} cleared. Replay any time.`;
    else if (state.plays.length < plays.length) objective = 'Objective: learn the plays. Experts with a blue ! teach them';
    else if (state.deals.length < customers.length) objective = 'Objective: knock on customer doors and propose the right play';
    else if (nextGate >= 0) objective = `Objective: open Rune Gate ${nextGate + 1}`;
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
    if (ci >= 0) return { type: 'customer', index: ci, label: `knock on ${customers[ci].company}'s door` };
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
    if (state.plays.length < plays.length) {
      await dialog.open({
        speaker,
        lines: ['So… what would you suggest?'],
        note: `Your playbook has ${state.plays.length} of ${plays.length} plays. Talk to the experts (!) to learn them all before proposing a strategy.`,
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
      note: 'Move: arrow keys / WASD or the on-screen pad · Interact: Space or A',
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
    }
  });
  block.addEventListener('keyup', (e) => {
    const dir = KEYMAP[e.code];
    if (dir) release(dir);
    if (ACTION_KEYS.includes(e.code) && !e.target.closest('.questline-overlay') && !e.target.closest('button')) {
      interact(); // on keyup so the same key press does not also click the dialog's first button
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

  function render(t) {
    for (let y = 0; y < ROWS; y += 1) {
      for (let x = 0; x < COLS; x += 1) drawTile(g, world.grid[y][x], x, y, t);
    }
    const bang = (x, y, phase, color = '#e63946') => {
      const by = y + Math.round(Math.sin(t / 250 + phase) * 1.5);
      rect(g, '#fff', x, by, 6, 8);
      rect(g, color, x + 2, by + 1, 2, 4);
      rect(g, color, x + 2, by + 6, 2, 1);
    };

    world.houses.forEach((h) => drawHouse(g, h.x, h.y));
    customers.forEach((c, i) => {
      const x = c.house.x * TILE;
      const y = c.house.y * TILE;
      if (state.deals.includes(i)) {
        rect(g, '#3ddc84', x + 13, y + 20, 6, 11); // won: green door
        rect(g, '#1b7a45', x + 15, y + 22, 2, 7);
      } else {
        bang(x + 13, y + 12, i + 2);
      }
    });
    world.gates.forEach((gt, i) => drawGate(g, gt, i, state.gates[i], t));
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
          if (unlearned(i).length) bang(n.x * TILE + 5, n.y * TILE - 10, i, '#2f6fd6');
          else if (!state.talked.includes(i)) bang(n.x * TILE + 5, n.y * TILE - 10, i);
        },
      })),
      { y: py, draw: () => drawPerson(g, px, py, state.dir, step, 'player') },
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
