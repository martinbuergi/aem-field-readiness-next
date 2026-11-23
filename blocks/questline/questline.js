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
 *             | <best play> | <required skills, comma-separated> | <ARR, e.g. "$450k"> | <link>
 *             Required skills are expertise areas and/or play names (default: the best play).
 *             The more skills a customer needs, the posher their house (cottage, townhouse,
 *             manor). ARR is the deal's annual recurring revenue (default by house: $150k,
 *             $400k, $1M). Each failed pitch knocks 25% of the original ARR off that deal
 *             (floor 25%); the realm's goal is the sum of all customers' ARR.
 *   Reference | <from customer> | <to customer> | <story, e.g. "Priya: pages now load in 1s">
 *             Side quest: winning <from> earns a reference letter; sharing it with <to>
 *             restores ARR lost on failed pitches and adds 15% to that deal.
 *   Expansion | <customer> | <upsell ask> | <best answer> | <weak answer> | ... | <ARR> | <link>
 *             Side quest: after a deal is won the customer asks for more. A right answer adds
 *             the expansion ARR (default 25% of the deal); a weak one costs 25% of it.
 *   Resource  | <title> | <description> | <link>
 *             Extra collateral shown in the Field readiness library (south of the realm).
 *             The library also lists every expert, play, customer, rune gate question and
 *             objection with its link, so players can study everything in one place.
 * South of the village a road leads to Adobe: the library and a top-10 leaderboard.
 * Puzzles are spread across up to three rune gates; objections make up the boss fight.
 * Each customer lives in a house: three in the village, two in the grove behind Rune Gate 1
 * and two on the lake islands behind Rune Gate 2 (max 7). To propose a strategy the
 * player needs the skills that customer requires; all deals must be won before the
 * boss accepts the challenge. The player starts at level 0 and earns XP for every
 * conversation and correct answer; expertise areas and plays become skills.
 * Any cell that only contains a link is treated as the "learn more" link.
 *
 * Avatar: on the first visit players create their seller (name, hair style, hair colour,
 * skin tone). It is kept in the browser and, when the game runs as a DA app
 * (da.live/app/<org>/<site>/tools/questline, signed in with Adobe), also saved as a row
 * in the DA sheet "<content path>-players" (e.g. /drafts/questline-players).
 * The block can load its rows from another page: <div class="questline" data-source="/path">.
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
  reference: 10, // sharing the right customer story
  expansion: 15, // winning an upsell
  library: 5, // first visit to the library
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

const MONEY = /^[$€£]?\s*\d[\d.,]*\s*[kKmM]?(\s*ARR)?$/;
function parseMoney(text) {
  const m = text.replace(/ARR|[$€£\s]/gi, '').match(/^([\d.,]+)([kKmM]?)$/);
  if (!m) return 0;
  const n = parseFloat(m[1].replace(/,/g, ''));
  const mult = { k: 1e3, m: 1e6 }[m[2].toLowerCase()] || 1;
  return Math.round(n * mult);
}
function money(v) {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}k`;
  return `$${Math.round(v)}`;
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
    references: [],
    expansions: [],
    resources: [],
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
          // the ARR cell is recognised by its money format, so required skills stay optional
          const tail = pos.slice(3);
          const arrAt = tail.findIndex((t) => MONEY.test(t));
          const arr = arrAt >= 0 ? parseMoney(tail.splice(arrAt, 1)[0]) : 0;
          content.customers.push({
            company: pos[0],
            contact: pos[1] || '',
            situation: posCells[2] ? cellLines(posCells[2]) : [],
            best: tail[0] || '',
            requires: (tail[1] || '').split(/[,;\n·]+/).map((s) => s.trim()).filter(Boolean),
            arr,
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
      case 'reference':
        if (texts.length >= 2) {
          content.references.push({
            from: texts[0], to: texts[1], story: textCells.slice(2).flatMap(cellLines), link,
          });
        }
        break;
      case 'resource':
      case 'library':
        if (texts.length || link) {
          content.resources.push({
            title: texts[0] || link?.text || '', description: texts.slice(1).join(' '), link,
          });
        }
        break;
      case 'expansion':
      case 'upsell': {
        const parts = [...texts];
        const arrAt = parts.findIndex((t, idx) => idx > 2 && MONEY.test(t));
        const arr = arrAt >= 0 ? parseMoney(parts.splice(arrAt, 1)[0]) : 0;
        if (parts.length >= 4) {
          content.expansions.push({
            customer: parts[0],
            prompt: parts[1],
            answer: parts[2],
            wrong: parts.slice(3),
            arr,
            link,
          });
        }
        break;
      }
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
    references: content.references,
    expansions: content.expansions,
    resources: content.resources,
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
  for (let y = 4; y < ROWS - 1; y += 1) set(4, y, ':');
  set(3, ROWS - 2, 'S'); // signpost: the road south leads to Adobe
  [[1, 5], [2, 13], [7, 5], [6, 9], [3, 10], [8, 13], [5, 1]].forEach(([x, y]) => set(x, y, 'f'));
  [[8, 1], [1, 1], [8, 10], [1, 14]].forEach(([x, y]) => set(x, y, 't'));
  // village (3), grove (2, behind Rune Gate 1), lake islands (2, behind Rune Gate 2)
  const houses = [
    { x: 1, y: 2 }, { x: 6, y: 2 }, { x: 6, y: 11 },
    { x: 12, y: 1 }, { x: 12, y: 9 },
    { x: 16, y: 1 }, { x: 15, y: 12 },
  ];

  // grove: winding path to the second gate, shrine in the south
  [[10, 8], [11, 8], [11, 7], [11, 6], [11, 5], [11, 4], [12, 4], [13, 4],
    [11, 9], [11, 10], [11, 11], [11, 12], [11, 13]].forEach(([x, y]) => set(x, y, ':'));
  [[10, 2], [10, 5], [10, 11], [10, 13], [13, 13], [13, 6]].forEach(([x, y]) => set(x, y, 't'));
  [[10, 10], [10, 3], [13, 7]].forEach(([x, y]) => set(x, y, 'f'));

  // lake with a plank bridge between two small islands
  for (let x = 15; x <= 17; x += 1) for (let y = 1; y < ROWS - 1; y += 1) set(x, y, '~');
  for (let x = 15; x <= 17; x += 1) for (let y = 1; y <= 3; y += 1) set(x, y, '.');
  [[17, 12], [17, 13], [15, 14], [16, 14], [17, 14]].forEach(([x, y]) => set(x, y, '.'));
  set(15, 4, '='); set(17, 11, '=');
  for (let y = 4; y <= 11; y += 1) set(16, y, '=');
  set(17, 3, 'f'); set(17, 14, 'f');

  houses.forEach(({ x, y }) => {
    set(x, y, 'H'); set(x + 1, y, 'H'); set(x, y + 1, 'H'); set(x + 1, y + 1, 'H');
  });

  // arena
  for (let x = 19; x <= 22; x += 1) for (let y = 1; y < ROWS - 1; y += 1) set(x, y, ',');
  [[19, 2], [22, 2], [19, 13], [22, 13]].forEach(([x, y]) => set(x, y, 'P'));

  // border
  for (let x = 0; x < COLS; x += 1) { set(x, 0, 'T'); set(x, ROWS - 1, 'T'); }
  for (let y = 0; y < ROWS; y += 1) { set(0, y, 'T'); set(COLS - 1, y, 'T'); }
  set(4, ROWS - 1, ':'); // gap in the hedge

  const gates = [{ x: 9, y: 8 }, { x: 14, y: 4 }, { x: 18, y: 11 }];
  gates.forEach(({ x, y }) => set(x, y, 'G'));

  return {
    grid,
    houses,
    gates,
    start: { x: 2, y: 8 },
    npcSpots: [{ x: 3, y: 6 }, { x: 7, y: 7 }, { x: 2, y: 11 }, { x: 5, y: 13 }, { x: 12, y: 6 }],
    shrine: { x: 12, y: 13 },
    boss: { x: 20, y: 7 }, // 2x2
    signpost: { x: 3, y: ROWS - 2 },
  };
}

/* the second screen, south of the village: Adobe, with the library and the leaderboard */
function buildSouth() {
  const grid = Array.from({ length: ROWS }, () => Array(COLS).fill('.'));
  const set = (x, y, c) => { grid[y][x] = c; };
  const fill = (x0, y0, x1, y1, c) => {
    for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) set(x, y, c);
  };

  // pond with lily pads and a little pier
  [[3, 19, 21], [4, 18, 22], [5, 17, 22], [6, 17, 22], [7, 17, 22], [8, 17, 22],
    [9, 17, 22], [10, 18, 22], [11, 18, 21], [12, 19, 20]].forEach(([y, x0, x1]) => fill(x0, y, x1, y, '~'));
  [[20, 4], [21, 7], [19, 11], [21, 10], [18, 6]].forEach(([x, y]) => set(x, y, 'p'));
  set(16, 9, ':');
  [17, 18, 19].forEach((x) => set(x, 9, '='));

  // road from the village, then the plaza
  for (let y = 0; y <= 8; y += 1) set(4, y, ':');
  fill(5, 8, 7, 8, ':');
  fill(8, 7, 15, 12, 'o');

  const library = { x: 10, y: 3 }; // 4x4
  fill(library.x, library.y, library.x + 3, library.y + 3, 'L');
  const board = { x: 6, y: 5 }; // 2x1
  fill(board.x, board.y, board.x + 1, board.y, 'B');
  const fountain = { x: 11, y: 9 }; // 2x2
  fill(fountain.x, fountain.y, fountain.x + 1, fountain.y + 1, 'F');
  const lamps = [{ x: 8, y: 7 }, { x: 15, y: 7 }, { x: 8, y: 12 }, { x: 15, y: 12 }];
  lamps.forEach(({ x, y }) => set(x, y, 'l'));
  const signpost = { x: 5, y: 1 };
  set(signpost.x, signpost.y, 'S');

  [[2, 3], [1, 6], [2, 10], [1, 13], [7, 2], [15, 2], [16, 13], [19, 13], [22, 13], [22, 2],
    [6, 13], [13, 14]].forEach(([x, y]) => set(x, y, 'k'));
  [[9, 1], [3, 12]].forEach(([x, y]) => set(x, y, 't'));
  [[16, 4], [17, 11], [22, 11], [18, 2], [2, 8], [7, 14], [14, 1]].forEach(([x, y]) => set(x, y, 'r'));
  // flower beds along the southern lawn
  [[2, 12], [3, 13], [4, 13], [5, 13], [9, 14], [12, 14], [15, 14], [17, 14], [18, 14], [21, 14]]
    .forEach(([x, y]) => set(x, y, 'f'));
  [[2, 2], [6, 3], [3, 7], [6, 10], [2, 14], [10, 13], [14, 13], [17, 12], [20, 14], [16, 6],
    [16, 10], [9, 5], [14, 5], [11, 14], [5, 11]].forEach(([x, y]) => set(x, y, 'f'));

  for (let x = 0; x < COLS; x += 1) { set(x, 0, 'T'); set(x, ROWS - 1, 'T'); }
  for (let y = 0; y < ROWS; y += 1) { set(0, y, 'T'); set(COLS - 1, y, 'T'); }
  set(4, 0, ':'); // the road back north

  return {
    grid, library, board, fountain, lamps, signpost,
  };
}

const WALKABLE = new Set(['.', ':', 'f', '=', ',', 'o']);

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

// hair styles paint extra hair pixels onto the base (short) head: [row, [cols]]
const span = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const HAIR_STYLES = [
  { id: 'short', label: 'Short' },
  {
    id: 'spiky',
    label: 'Spiky',
    paint: {
      down: [[0, [4, 6, 7, 9, 11]], [1, [4, 11]], [2, [3, 12]]],
      up: [[0, [4, 6, 7, 9, 11]], [1, [4, 11]], [2, [3, 12]]],
      side: [[0, [5, 7, 9]], [1, [4, 11]], [2, [3, 12]]],
    },
  },
  {
    id: 'long',
    label: 'Long',
    paint: {
      down: [3, 4, 5, 6, 7, 8].map((r) => [r, [3, 12]]),
      up: [[3, span(3, 12)], [4, span(3, 12)], [5, span(3, 12)], [6, span(3, 12)],
        [7, span(4, 11)], [8, span(4, 11)]],
      side: [[3, [3, 4]], [4, [3, 4]], [5, [3, 4]], [6, [3, 4, 5]], [7, [3, 4, 5]], [8, [3, 4]]],
    },
  },
  {
    id: 'curly',
    label: 'Curly',
    paint: {
      down: [[0, span(4, 11)], [1, span(3, 12)], [2, span(2, 13)], [3, [2, 3, 12, 13]],
        [4, [2, 3, 12, 13]], [5, [3, 12]]],
      up: [[0, span(4, 11)], [1, span(3, 12)], [2, span(2, 13)], [3, span(2, 13)],
        [4, span(2, 13)], [5, span(3, 12)]],
      side: [[0, span(4, 10)], [1, span(3, 11)], [2, span(2, 12)],
        [3, [2, 3]], [4, [2, 3]], [5, [3]]],
    },
  },
  {
    id: 'bun',
    label: 'Bun',
    paint: {
      down: [[0, span(6, 9)]],
      up: [[0, span(6, 9)]],
      side: [[1, [2, 3, 4]], [2, [2, 3]]],
    },
  },
];
const HAIR_COLORS = [
  ['Black', '#1f1a17'], ['Dark brown', '#3b2a1a'], ['Brown', '#7a4b2a'], ['Auburn', '#a0452a'],
  ['Blonde', '#e8c36a'], ['Silver', '#c9ccd6'], ['Pink', '#ff6fae'], ['Blue', '#3f7ad9'],
];
const SKIN_TONES = [
  ['Light', '#f9dcc4'], ['Fair', '#f2c79b'], ['Medium', '#d9a066'],
  ['Tan', '#b87a4b'], ['Brown', '#8d5a3b'], ['Deep', '#5c3a24'],
];
const NPC_HAIR = ['long', 'short', 'curly', 'bun', 'spiky'];
const DEFAULT_AVATAR = {
  name: '', style: 'short', hair: '#3b2a1a', skin: '#f2c79b',
};

function tint(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.max(0, Math.min(255, Math.round(v * f))).toString(16).padStart(2, '0');
  return `#${ch((n >> 16) & 255)}${ch((n >> 8) & 255)}${ch(n & 255)}`;
}
const isDark = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) < 110;
};

function headRows(facing, style) {
  const rows = [...HEAD[facing], ...TORSO[facing]].map((r) => [...r]);
  const def = HAIR_STYLES.find((h) => h.id === style);
  (def?.paint?.[facing] || []).forEach(([r, cols]) => cols.forEach((c) => { rows[r][c] = 'h'; }));
  return rows.map((r) => r.join(''));
}

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

function drawPerson(g, x, y, dir, step, palKey, style = 'short') {
  const facing = dir === 'left' || dir === 'right' ? 'side' : dir;
  const legs = LEGS[facing === 'side' ? 'side' : 'front'][step];
  const rows = [...headRows(facing, style), ...legs];
  const img = sprite(`${palKey}-${style}-${facing}-${step}`, rows, PALETTES[palKey]);
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

// palette for a player's avatar at a given look tier
function avatarPalette(avatar, li) {
  const key = `pl-${avatar.hair}-${avatar.skin}-${li}`;
  if (!PALETTES[key]) {
    PALETTES[key] = {
      ...PLAYER_LOOKS[li].pal,
      h: avatar.hair,
      s: avatar.skin,
      m: tint(avatar.skin, 0.85),
      e: isDark(avatar.skin) ? '#f4f4f4' : '#1a1a2e',
    };
  }
  return key;
}

function drawPlayer(g, x, y, dir, step, li, t, avatar = DEFAULT_AVATAR) {
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
  drawPerson(g, x, y, dir, step, avatarPalette(avatar, li), avatar.style);
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

const WATERISH = new Set(['~', '=', 'p']);
const PATHISH = new Set([':', 'G', '=', 'o', 'l', 'F']);

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

function drawTree(g, x, y, tx, ty, border, blossom = false) {
  const h = hash(tx, ty);
  drawGrass(g, x, y, tx, ty);
  rect(g, 'rgba(0,0,0,0.22)', x + 3, y + 13, 11, 2);
  rect(g, 'rgba(0,0,0,0.22)', x + 5, y + 15, 7, 1);
  rect(g, '#6b4226', x + 7, y + 9, 3, 6);
  rect(g, '#4e2f1a', x + 9, y + 9, 1, 6);
  let [dark, mid, light] = border
    ? ['#1f4a26', '#2b6131', '#3c7c3e']
    : [['#24602b', '#33803a', '#4fa24a'], ['#2a5e2c', '#3a7d35', '#5a9e45']][h % 2];
  if (blossom) [dark, mid, light] = [['#b2477a', '#e0739f', '#ffb3cf'], ['#a64d8c', '#d47ab8', '#f7c1e3']][h % 2];
  g.save();
  g.translate(x, y);
  blob(g, '#14301a', 8, 6, 6);
  blob(g, dark, 8, 6, 5);
  blob(g, mid, 7, 5, 4);
  blob(g, light, 6, 4, 2);
  rect(g, blossom ? '#fff0f6' : '#8fd27a', 5, 3, 1, 1);
  if (blossom) {
    rect(g, '#fff0f6', 9, 6, 1, 1);
    rect(g, '#fff0f6', 4, 7, 1, 1);
    rect(g, '#ffd6e6', 11 - (h % 3), 12 + (h % 2), 1, 1); // a fallen petal
  } else if (!border && h % 3 === 0) {
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
    case 'k':
      drawTree(g, x, y, tx, ty, false, true);
      break;
    case 'r': {
      drawGrass(g, x, y, tx, ty);
      g.save();
      g.translate(x, y);
      rect(g, 'rgba(0,0,0,0.22)', 2, 12, 13, 3);
      blob(g, INK, 8, 9, 6);
      blob(g, '#7d8291', 8, 9, 5);
      blob(g, '#9aa0ad', 7, 8, 3);
      rect(g, '#c4c9d4', 5, 6, 2, 1);
      if (h % 2) rect(g, '#5c8a3e', 3, 11, 4, 1); // moss
      if (h % 3 === 0) {
        blob(g, INK, 13, 12, 2);
        blob(g, '#8a8f9c', 13, 12, 1);
      }
      g.restore();
      break;
    }
    case 'o':
    case 'l':
    case 'F': {
      // cobbled plaza
      rect(g, '#8a8273', x, y, TILE, TILE);
      for (let r = 0; r < 4; r += 1) {
        for (let k = 0; k < 4; k += 1) {
          const v = (h >>> ((r * 4 + k) % 24)) & 7;
          const sx = x + k * 4 + (r % 2);
          const sy = y + r * 4;
          rect(g, ['#b8b09f', '#c4bcaa', '#aea694', '#bdb5a3'][v % 4], sx, sy, 3, 3);
          rect(g, '#d8d1c0', sx, sy, 2, 1);
        }
      }
      const edge = (nx, ny) => !PATHISH.has(at(nx, ny)) && at(nx, ny) !== 'L';
      if (edge(tx, ty - 1)) rect(g, '#6d6658', x, y, TILE, 1);
      if (edge(tx, ty + 1)) rect(g, '#6d6658', x, y + 15, TILE, 1);
      if (edge(tx - 1, ty)) rect(g, '#6d6658', x, y, 1, TILE);
      if (edge(tx + 1, ty)) rect(g, '#6d6658', x + 15, y, 1, TILE);
      break;
    }
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
    case 'p':
    case '=': {
      rect(g, '#3a7bd5', x, y, TILE, TILE);
      if (h % 3 === 0) rect(g, '#336fc4', x + (h % 8), y + ((h >>> 4) % 10) + 3, 7, 3);
      const shore = (nx, ny) => !WATERISH.has(at(nx, ny));
      if (shore(tx, ty - 1)) { rect(g, '#2a5fae', x, y, TILE, 2); rect(g, '#cfeaff', x, y + 2, TILE, 1); }
      if (shore(tx - 1, ty)) { rect(g, '#2a5fae', x, y, 2, TILE); rect(g, '#cfeaff', x + 2, y + (h % 3), 1, TILE - 3); }
      if (shore(tx + 1, ty)) { rect(g, '#cfeaff', x + 13, y + (h % 3), 1, TILE - 3); }
      if (shore(tx, ty + 1)) rect(g, '#cfeaff', x, y + 13, TILE, 1);
      if (c === 'p') {
        g.save();
        g.translate(x, y);
        blob(g, '#1f5e2a', 8, 9, 5);
        blob(g, '#3f9a45', 8, 8, 5);
        rect(g, '#3a7bd5', 8, 3, 2, 5); // the notch in the pad
        rect(g, '#6cc46a', 5, 6, 2, 1);
        if (h % 2) {
          rect(g, '#ffd6e6', 10, 7, 3, 2);
          rect(g, '#ff8fb8', 11, 6, 1, 1);
          rect(g, '#fff6c9', 11, 7, 1, 1);
        }
        g.restore();
      }
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

/* Adobe: library, blackboard, fountain, lamps, signposts */

function drawLibrary(g, x, y, t) {
  // x, y: top-left of the 4x4 tile footprint
  rect(g, 'rgba(0,0,0,0.25)', x + 4, y + 61, 60, 3);
  // steps
  rect(g, '#8f8778', x + 1, y + 56, 62, 8);
  rect(g, '#d6cdb8', x + 1, y + 56, 62, 2);
  rect(g, '#c2b9a3', x + 4, y + 59, 56, 2);
  rect(g, '#ded6c3', x + 4, y + 59, 56, 1);
  rect(g, '#aca38e', x + 7, y + 62, 50, 2);
  // stylobate
  rect(g, INK, x + 2, y + 51, 60, 6);
  rect(g, '#ece5d3', x + 3, y + 52, 58, 4);
  rect(g, '#cfc6b0', x + 3, y + 55, 58, 1);
  // shaded hall behind the columns
  rect(g, '#4a3a2e', x + 5, y + 25, 54, 27);
  rect(g, '#3a2d24', x + 5, y + 25, 54, 3);
  // windows full of books
  [12, 45].forEach((wx) => {
    rect(g, INK, x + wx - 1, y + 30, 9, 16);
    rect(g, '#ffd98a', x + wx, y + 31, 7, 14);
    for (let r = 0; r < 3; r += 1) {
      for (let k = 0; k < 7; k += 1) {
        const col = ['#b23a48', '#3a6ea5', '#2f8f5b', '#e0a030', '#7a4b9c'][(k + r * 2 + wx) % 5];
        rect(g, col, x + wx + k, y + 32 + r * 5, 1, 3 + ((k + r) % 2));
      }
      rect(g, '#8a5a2e', x + wx, y + 36 + r * 5, 7, 1);
    }
    rect(g, 'rgba(255,255,255,0.35)', x + wx, y + 31, 2, 4);
  });
  // open door with warm light and shelves inside
  rect(g, INK, x + 26, y + 32, 12, 20);
  rect(g, '#ffe2a0', x + 27, y + 34, 10, 18);
  rect(g, '#ffe2a0', x + 28, y + 33, 8, 1);
  [38, 43].forEach((sy) => {
    rect(g, '#8a5a2e', x + 27, y + sy + 3, 10, 1);
    for (let k = 0; k < 10; k += 1) {
      rect(g, ['#b23a48', '#3a6ea5', '#2f8f5b', '#e0a030'][(k + sy) % 4], x + 27 + k, y + sy, 1, 3);
    }
  });
  glow(g, x + 32, y + 46, 20, '#8a5a10', 0.55 + 0.15 * Math.sin(t / 600));
  // Adobe-red banners
  [21, 40].forEach((bx) => {
    rect(g, INK, x + bx - 1, y + 25, 5, 15);
    rect(g, '#eb1000', x + bx, y + 25, 3, 13);
    rect(g, '#ff5a3c', x + bx, y + 25, 1, 13);
    rect(g, '#4a3a2e', x + bx + 1, y + 37, 1, 1);
    rect(g, '#fff', x + bx + 1, y + 29, 1, 3);
  });
  // columns
  [6, 17, 43, 54].forEach((cx) => {
    rect(g, INK, x + cx - 1, y + 26, 6, 25);
    rect(g, '#f6f1e4', x + cx, y + 26, 4, 25);
    rect(g, '#d6cdb8', x + cx + 3, y + 26, 1, 25);
    rect(g, '#fffdf5', x + cx, y + 26, 1, 25);
    rect(g, INK, x + cx - 2, y + 24, 8, 3);
    rect(g, '#ece5d3', x + cx - 1, y + 25, 6, 1);
    rect(g, '#ece5d3', x + cx - 1, y + 49, 6, 2);
  });
  // entablature (the frieze carries the HTML name label)
  rect(g, INK, x + 1, y + 16, 62, 9);
  rect(g, '#efe8d6', x + 2, y + 17, 60, 7);
  rect(g, '#cfc6b0', x + 2, y + 23, 60, 1);
  // pediment
  for (let r = 0; r < 14; r += 1) {
    const half = Math.round(3 + r * 2.15);
    rect(g, INK, x + 32 - half - 1, y + 2 + r, half * 2 + 2, 1);
    rect(g, r < 2 ? '#ece5d3' : '#ddd4bf', x + 32 - half, y + 2 + r, half * 2, 1);
  }
  rect(g, '#c6bca5', x + 4, y + 15, 56, 1);
  // golden open book in the tympanum
  const pulse = 0.6 + 0.25 * Math.sin(t / 500);
  glow(g, x + 32, y + 10, 10, '#7a6010', pulse);
  rect(g, '#8a6a10', x + 26, y + 8, 12, 5);
  rect(g, '#f4d35e', x + 27, y + 8, 5, 4);
  rect(g, '#f4d35e', x + 33, y + 8, 4, 4);
  rect(g, '#fff6c9', x + 28, y + 9, 3, 1);
  rect(g, '#fff6c9', x + 34, y + 9, 2, 1);
}

function drawBlackboard(g, x, y) {
  // x, y: top-left of the 2x1 tile footprint; the board stands on two legs
  rect(g, 'rgba(0,0,0,0.25)', x + 2, y + 14, 30, 2);
  rect(g, '#4e2f1a', x + 4, y + 4, 2, 11);
  rect(g, '#4e2f1a', x + 26, y + 4, 2, 11);
  rect(g, INK, x, y - 17, 32, 22);
  rect(g, '#8a5a2e', x + 1, y - 16, 30, 20);
  rect(g, '#b07c45', x + 1, y - 16, 30, 1);
  rect(g, '#1f3b2c', x + 3, y - 14, 26, 16);
  rect(g, '#284a37', x + 3, y - 14, 26, 1);
  // chalk rows under the HTML "TOP 10" heading
  [18, 14, 16, 11].forEach((w, r) => {
    rect(g, '#f4d35e', x + 5, y - 7 + r * 2, 1, 1);
    rect(g, '#cfe0c8', x + 7, y - 7 + r * 2, w - 4, 1);
    rect(g, '#9fc0a0', x + 7 + w - 2, y - 7 + r * 2, 3, 1);
  });
  rect(g, '#6e4524', x + 1, y + 3, 30, 2);
  rect(g, '#fffdf5', x + 9, y + 2, 3, 1);
  rect(g, '#ffd6e6', x + 20, y + 2, 2, 1);
}

function drawFountain(g, x, y, t) {
  // x, y: top-left of the 2x2 tile footprint
  g.save();
  g.translate(x, y);
  rect(g, 'rgba(0,0,0,0.22)', 3, 27, 28, 4);
  blob(g, INK, 16, 19, 14);
  blob(g, '#9a917f', 16, 18, 13);
  blob(g, '#cfc6b0', 16, 17, 13);
  blob(g, '#2a5fae', 16, 18, 10);
  blob(g, '#3a7bd5', 16, 18, 9);
  const o = Math.floor(t / 220) % 4;
  rect(g, '#9cc6ff', 10 + o, 16, 4, 1);
  rect(g, '#9cc6ff', 18 - o, 21, 4, 1);
  // pedestal and upper bowl
  rect(g, INK, 13, 7, 7, 12);
  rect(g, '#d6cdb8', 14, 8, 5, 11);
  rect(g, '#fffdf5', 14, 8, 1, 11);
  blob(g, INK, 16, 8, 5);
  blob(g, '#ece5d3', 16, 7, 4);
  rect(g, '#6fa8ff', 13, 6, 7, 2);
  // water jet: droplets on two arcs
  for (let i = 0; i < 6; i += 1) {
    const ph = ((t / 900) + i / 6) % 1;
    const dx = Math.round(ph * 9);
    const dy = Math.round(-6 * Math.sin(ph * Math.PI) + ph * 14);
    rect(g, '#cfeaff', 16 + dx, 4 + dy, 1, 2);
    rect(g, '#cfeaff', 16 - dx, 4 + dy, 1, 2);
  }
  rect(g, '#fff', 16, 1 + (Math.floor(t / 150) % 3), 1, 3);
  g.restore();
}

function drawLamp(g, x, y, t) {
  rect(g, 'rgba(0,0,0,0.25)', x + 5, y + 13, 7, 2);
  rect(g, '#2b2b3a', x + 7, y + 1, 3, 13);
  rect(g, '#2b2b3a', x + 5, y + 13, 7, 2);
  rect(g, INK, x + 4, y - 7, 9, 9);
  rect(g, '#ffe08a', x + 5, y - 6, 7, 7);
  rect(g, '#fff6c9', x + 6, y - 5, 2, 3);
  rect(g, '#2b2b3a', x + 4, y - 8, 9, 2);
  rect(g, '#2b2b3a', x + 7, y - 10, 3, 2);
  glow(g, x + 8, y - 3, 16, '#8a6a10', 0.55 + 0.1 * Math.sin(t / 300 + x));
}

function drawPost(g, x, y) {
  rect(g, 'rgba(0,0,0,0.25)', x + 4, y + 14, 9, 2);
  rect(g, '#4e2f1a', x + 7, y + 2, 3, 13);
  rect(g, '#6e4524', x + 7, y + 2, 1, 13);
}

function drawButterfly(g, b, t) {
  const a = (t / 1000) * b.speed + b.phase;
  const x = Math.round(b.x + Math.sin(a) * b.rx);
  const y = Math.round(b.y + Math.sin(a * 2) * b.ry + Math.sin(t / 180 + b.phase) * 1.5);
  const open = Math.floor(t / 110 + b.phase * 3) % 2;
  rect(g, INK, x, y, 1, 3);
  if (open) {
    rect(g, b.color, x - 2, y, 2, 2);
    rect(g, b.color, x + 1, y, 2, 2);
    rect(g, b.light, x - 2, y, 1, 1);
    rect(g, b.light, x + 2, y, 1, 1);
  } else {
    rect(g, b.color, x - 1, y, 1, 2);
    rect(g, b.color, x + 1, y, 1, 2);
  }
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

/* ---------- avatar + DA sheet sync ---------- */

const AVATAR_KEY = 'questline-avatar';

function loadAvatar() {
  try {
    const a = JSON.parse(localStorage.getItem(AVATAR_KEY));
    return a && a.name ? { ...DEFAULT_AVATAR, ...a } : null;
  } catch (e) {
    return null;
  }
}

function writeAvatar(avatar) {
  try {
    localStorage.setItem(AVATAR_KEY, JSON.stringify(avatar));
  } catch (e) {
    // storage unavailable: the avatar lives only in memory
  }
}

// org/site from a {ref}--{site}--{org}.aem.page|live host
function siteFromHost() {
  const m = window.location.hostname.match(/^[^.]+?--([^.]+?)--([^.]+?)\.aem\.(page|live)$/);
  return m ? { org: m[2], repo: m[1] } : null;
}

let daSession;
/**
 * Resolves to { token, org, repo } when the page runs as a DA app inside da.live
 * (the shell hands over the signed-in user's Adobe token), otherwise to null.
 */
function getDaSession() {
  if (daSession) return daSession;
  daSession = (async () => {
    if (window.self === window.top) return null;
    try {
      const sdk = await Promise.race([
        // eslint-disable-next-line import/no-unresolved -- DA app SDK, served by da.live
        import('https://da.live/nx/utils/sdk.js').then((m) => m.default),
        new Promise((resolve) => { setTimeout(() => resolve(null), 4000); }),
      ]);
      if (!sdk?.token) return null;
      const { context } = sdk;
      const site = context?.org ? { org: context.org, repo: context.repo } : siteFromHost();
      return site ? { token: sdk.token, ...site } : null;
    } catch (e) {
      return null;
    }
  })();
  return daSession;
}

const DA_SOURCE = 'https://admin.da.live/source';

/** Upserts the player's row (keyed by id) in the DA sheet at `sheetPath` (no extension). */
async function saveToSheet(sheetPath, row) {
  const session = await getDaSession();
  if (!session) return 'local';
  const url = `${DA_SOURCE}/${session.org}/${session.repo}${sheetPath}.json`;
  const headers = { Authorization: `Bearer ${session.token}` };
  try {
    let json = { ':type': 'sheet', data: [] };
    const resp = await fetch(url, { headers });
    if (resp.ok) json = await resp.json();
    // single sheet: { data: [...] }; multi sheet: { data: { data: [...] }, ':names': [...] }
    const sheet = Array.isArray(json.data) ? json : (json.data || { data: [] });
    const rows = (sheet.data || []).filter((r) => r.id !== row.id);
    rows.push(row);
    sheet.data = rows;
    sheet.total = rows.length;
    sheet.limit = rows.length;
    sheet.offset = 0;
    const body = new FormData();
    body.append('data', new Blob([JSON.stringify(json)], { type: 'application/json' }));
    const put = await fetch(url, { method: 'PUT', headers, body });
    return put.ok ? 'synced' : 'error';
  } catch (e) {
    return 'error';
  }
}

/** Loads the block rows of another page: same-origin .plain.html, else the DA source. */
async function loadSourceRows(block) {
  const path = block.dataset.source;
  const pick = (html) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return doc.querySelector('.questline');
  };
  try {
    const resp = await fetch(`${path}.plain.html`);
    if (resp.ok) {
      const found = pick(await resp.text());
      if (found) return block.append(...found.children);
    }
  } catch (e) {
    // fall through to DA
  }
  const session = await getDaSession();
  if (!session) return null;
  const resp = await fetch(`${DA_SOURCE}/${session.org}/${session.repo}${path}.html`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  const found = resp.ok ? pick(await resp.text()) : null;
  return found ? block.append(...found.children) : null;
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

export default async function decorate(block) {
  if (block.dataset.source && !block.children.length) await loadSourceRows(block);
  const content = parseContent(block);
  const world = buildWorld();
  const south = buildSouth();
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
    const arr = c.arr || [150000, 400000, 1000000][tier - 1];
    return {
      ...c, house: world.houses[i], needs, tier, arr,
    };
  });
  const playFor = (c) => plays.find((p) => c.best && same(p.name, c.best));
  const customerIndex = (name) => customers.findIndex((c) => same(c.company, name || ''));
  // side quests
  const references = content.references
    .map((r) => ({ ...r, from: customerIndex(r.from), to: customerIndex(r.to) }))
    .filter((r) => r.from >= 0 && r.to >= 0 && r.from !== r.to);
  const expansions = customers.map((c, ci) => {
    const e = content.expansions.find((x) => customerIndex(x.customer) === ci);
    return e ? { ...e, arr: e.arr || Math.round(c.arr * 0.25) } : null;
  });
  const arrGoal = customers.reduce((sum, c, ci) => sum + c.arr + (expansions[ci]?.arr || 0), 0);

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
    pitchMisses: {}, // customer index -> failed pitches
    arrWon: {}, // customer index -> ARR closed
    letters: [], // reference indices earned and not yet delivered
    refsDelivered: [], // reference indices delivered to the right prospect
    refBoost: {}, // customer index -> true when a reference was shared
    expWon: {}, // customer index -> expansion ARR closed
    expMisses: {}, // customer index -> weak expansion answers
    area: 'realm', // 'realm' or 'south' (Adobe)
    visited: [], // places that already paid their first-visit XP
  });
  const saved = loadSave();
  let state = { ...fresh(), ...(saved || {}) };
  if (!Array.isArray(state.gates) || state.gates.length !== MAX_GATES) state.gates = fresh().gates;
  state.bossHp = maxHp - (state.bossSolved || []).length;
  state.pitchMisses = state.pitchMisses || {};
  state.arrWon = state.arrWon || {};
  ['letters', 'refsDelivered'].forEach((k) => { state[k] = state[k] || []; });
  ['refBoost', 'expWon', 'expMisses'].forEach((k) => { state[k] = state[k] || {}; });
  state.visited = state.visited || [];
  if (state.area !== 'south') state.area = 'realm';
  // what a customer's deal is still worth after failed pitches
  const PITCH_PENALTY = 0.25;
  const REFERENCE_BONUS = 1.15;
  const keep = (misses) => Math.max(PITCH_PENALTY, 1 - PITCH_PENALTY * (misses || 0));
  const dealValue = (ci) => Math.round(
    customers[ci].arr * keep(state.pitchMisses[ci]) * (state.refBoost[ci] ? REFERENCE_BONUS : 1),
  );
  const expansionValue = (ci) => Math.round((expansions[ci]?.arr || 0) * keep(state.expMisses[ci]));
  const expansionOpen = (ci) => !!expansions[ci]
    && state.deals.includes(ci) && !(ci in state.expWon);
  const sum = (obj) => Object.values(obj).reduce((a, v) => a + v, 0);
  const arrClosed = () => sum(state.arrWon) + sum(state.expWon);
  const lettersHeld = () => state.letters.filter((ri) => !state.refsDelivered.includes(ri));
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
  let avatar = loadAvatar();
  const contentPath = (block.dataset.source || window.location.pathname)
    .replace(/\.html$/, '').replace(/\/$/, '/index');
  const sheetPath = `${contentPath}-players`;

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
  const arrEl = el('span', { class: 'questline-arrbox' });
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
    sign.title = `${c.company} · ${money(c.arr)} ARR`;
    return sign;
  });
  const signTags = signs.map((sign) => {
    const tag = el('span', { class: 'questline-sign-arr' });
    sign.append(tag);
    return tag;
  });
  // HTML labels per screen: logos and the Adobe signpost up north, library and board down south
  const place = (node, x, y, w, h) => {
    Object.assign(node.style, {
      left: pct(x, COLS * TILE),
      top: pct(y, ROWS * TILE),
      width: pct(w, COLS * TILE),
      height: pct(h, ROWS * TILE),
    });
    return node;
  };
  const postLabel = (text, at) => place(
    el('div', { class: 'questline-post', text }),
    at.x * TILE - 6,
    at.y * TILE - 3,
    TILE + 12,
    8,
  );
  const realmLabels = el('div', { class: 'questline-signs' }, signs, postLabel('Adobe ▼', world.signpost));
  const southLabels = el(
    'div',
    { class: 'questline-signs', hidden: true },
    postLabel('▲ Realm', south.signpost),
    place(
      el('div', { class: 'questline-frieze', text: 'Field readiness' }),
      south.library.x * TILE + 2,
      south.library.y * TILE + 17,
      60,
      7,
    ),
    place(
      el('div', { class: 'questline-chalk', text: '🏆 TOP 10' }),
      south.board.x * TILE + 3,
      south.board.y * TILE - 14,
      26,
      6,
    ),
  );
  stage.append(realmLabels, southLabels);
  let shownArea = 'realm';
  function applyArea() {
    shownArea = state.area;
    const inSouth = state.area === 'south';
    realmLabels.hidden = inSouth;
    southLabels.hidden = !inSouth;
    canvas.setAttribute('aria-label', inSouth ? 'Adobe: library and leaderboard' : `${content.title} game map`);
  }

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
  const avatarBtn = el('button', { type: 'button', class: 'questline-tool', text: 'Edit avatar' });

  block.replaceChildren(
    el(
      'div',
      { class: 'questline-hud' },
      el('p', { class: 'questline-title', text: content.title }),
      el('div', { class: 'questline-stats' }, levelEl, customers.length ? arrEl : null, insightEl, customers.length ? dealEl : null, gateEl),
    ),
    skillsEl,
    objectiveEl,
    screen,
    hintEl,
    pad,
    el('div', { class: 'questline-toolbar' }, avatarBtn, storyBtn, resetBtn),
  );

  const dialog = createDialog(block, overlay);

  /* HUD */
  function updateHud() {
    const into = state.xp % XP_PER_LEVEL;
    const fill = el('span', { class: 'questline-xpfill' });
    fill.style.width = `${(into / XP_PER_LEVEL) * 100}%`;
    levelEl.replaceChildren(
      ...(avatar ? [el('span', { class: 'questline-player', text: avatar.name })] : []),
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
      ...lettersHeld().map((ri) => el('span', {
        class: 'questline-chip questline-chip-letter',
        text: `📜 ${customers[references[ri].from].company} story`,
      })),
    );
    insightEl.textContent = plays.length
      ? `Plays ${state.plays.length}/${plays.length}`
      : `Insights ${state.talked.length}/${npcs.length}`;
    dealEl.textContent = `Deals ${state.deals.length}/${customers.length}`;
    const closed = arrClosed();
    const arrFill = el('span', { class: 'questline-arrfill' });
    arrFill.style.width = `${arrGoal ? Math.min(100, (closed / arrGoal) * 100) : 0}%`;
    arrEl.replaceChildren(
      el('span', { class: 'questline-arrlabel', text: 'ARR' }),
      el('span', { class: 'questline-arrbar' }, arrFill),
      el('span', { class: 'questline-arrtext', text: `${money(closed)} / ${money(arrGoal)}` }),
    );
    arrEl.setAttribute('aria-label', `ARR closed ${money(closed)} of ${money(arrGoal)} goal`);
    signTags.forEach((tag, i) => {
      const won = state.deals.includes(i);
      tag.textContent = won
        ? `✓ ${money((state.arrWon[i] || 0) + (state.expWon[i] || 0))}`
        : money(dealValue(i));
      tag.classList.toggle('lowered', !won && !!state.pitchMisses[i]);
    });
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
    const side = [];
    const openExp = customers.filter((_, ci) => expansionOpen(ci)).length;
    if (openExp) side.push(`${openExp} expansion${openExp === 1 ? '' : 's'} (blue +)`);
    if (lettersHeld().length) side.push(`${lettersHeld().length} reference letter${lettersHeld().length === 1 ? '' : 's'} to share`);
    objectiveEl.textContent = side.length ? `${objective} · Side quests: ${side.join(', ')}` : objective;
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
    if (state.area === 'south') return WALKABLE.has(south.grid[y][x]);
    if (npcAt(x, y) >= 0 || isBoss(x, y) || isShrine(x, y)) return false;
    const c = world.grid[y][x];
    if (c === 'G') return state.gates[gateAt(x, y)];
    return WALKABLE.has(c);
  }

  function facing() {
    const [dx, dy] = DIRS[state.dir];
    const x = state.x + dx;
    const y = state.y + dy;
    if (state.area === 'south') {
      const c = south.grid[y]?.[x];
      if (c === 'L') return { type: 'library', label: 'enter the Field readiness library' };
      if (c === 'B') return { type: 'board', label: 'read the top 10' };
      if (c === 'S') return { type: 'signpost', label: 'read the signpost' };
      if (c === 'F') return { type: 'fountain', label: 'toss a coin into the fountain' };
      return null;
    }
    if (world.grid[y]?.[x] === 'S') return { type: 'signpost', label: 'read the signpost' };
    const n = npcAt(x, y);
    if (n >= 0) {
      const role = npcs[n].expertise ? ` (expert for ${npcs[n].expertise})` : '';
      return { type: 'npc', index: n, label: `talk to ${npcs[n].name}${role}` };
    }
    const ci = customerAt(x, y);
    if (ci >= 0) {
      const c = customers[ci];
      let label = expansionOpen(ci)
        ? `discuss an expansion with ${c.company} (+${money(expansionValue(ci))} ARR)`
        : `visit ${c.company}`;
      if (!state.deals.includes(ci)) {
        const have = c.needs.length - missingFor(c).length;
        label = `knock on ${c.company}'s door (${money(dealValue(ci))} ARR · skills ${have}/${c.needs.length})`;
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

  // one write at a time: each save reads the sheet, upserts this player's row, writes it back
  let syncChain = Promise.resolve();
  function syncAvatar({ quiet = false } = {}) {
    if (!avatar) return syncChain;
    syncChain = syncChain.then(async () => {
      const level = levelOf(state.xp);
      const nameOf = (list, value) => (list.find(([, v]) => v === value) || [value])[0];
      const status = await saveToSheet(sheetPath, {
        id: avatar.id,
        name: avatar.name,
        hairStyle: avatar.style,
        hairColour: nameOf(HAIR_COLORS, avatar.hair),
        skinTone: nameOf(SKIN_TONES, avatar.skin),
        level: String(level),
        title: PLAYER_LOOKS[lookIndex(level)].title,
        xp: String(state.xp),
        deals: `${state.deals.length}/${customers.length}`,
        arr: money(arrClosed()),
        cleared: state.won ? 'yes' : 'no',
        updated: new Date().toISOString(),
      });
      if (status === 'synced' && !quiet) toast('☁ Saved to the team sheet', 'skill');
      if (status === 'error' && !quiet) toast('☁ Could not reach the team sheet', 'level');
    });
    return syncChain;
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
      syncAvatar({ quiet: true });
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

  /* avatar creator */
  function editAvatar({ first = false } = {}) {
    return new Promise((resolve, reject) => {
      const draft = { ...DEFAULT_AVATAR, ...(avatar || {}) };
      const preview = el('canvas', {
        class: 'questline-creator-canvas', width: 18, height: 19, 'aria-hidden': 'true',
      });
      const pg = preview.getContext('2d');
      const turn = ['down', 'right', 'up', 'left'];
      let facingIdx = 0;
      const paint = () => {
        pg.clearRect(0, 0, 18, 19);
        drawPlayer(pg, 1, 2, turn[facingIdx], 'stand', lookIndex(levelOf(state.xp)), performance.now(), draft);
      };
      const spin = setInterval(() => {
        facingIdx = (facingIdx + 1) % turn.length;
        paint();
      }, 900);

      const nameInput = el('input', {
        type: 'text',
        class: 'questline-creator-name',
        maxlength: '24',
        placeholder: 'Your name',
        autocomplete: 'nickname',
        'aria-label': 'Your name',
        value: draft.name,
      });
      const startBtn = el('button', {
        type: 'button', class: 'questline-choice primary', text: first ? 'Start quest ▸' : 'Save',
      });

      // a group of toggle buttons; `render` builds each option's content
      const groups = [];
      const group = (label, key, options, face) => {
        const buttons = options.map(([value, name]) => {
          const btn = el('button', {
            type: 'button', class: 'questline-opt', 'aria-label': name, title: name,
          }, face(value, name));
          btn.addEventListener('click', () => {
            draft[key] = value;
            groups.forEach((fn) => fn());
            paint();
          });
          return [value, btn];
        });
        groups.push(() => buttons.forEach(([value, btn]) => btn.setAttribute('aria-pressed', String(draft[key] === value))));
        return el(
          'div',
          { class: 'questline-creator-group', role: 'group', 'aria-label': label },
          el('span', { class: 'questline-creator-label', text: label }),
          el('div', { class: 'questline-creator-options' }, buttons.map(([, b]) => b)),
        );
      };
      const swatch = (color) => {
        const dot = el('span', { class: 'questline-swatch' });
        dot.style.background = color;
        return dot;
      };
      const fields = [
        group('Hair style', 'style', HAIR_STYLES.map((h) => [h.id, h.label]), (_, name) => name),
        group('Hair colour', 'hair', HAIR_COLORS.map(([n, c]) => [c, n]), swatch),
        group('Skin tone', 'skin', SKIN_TONES.map(([n, c]) => [c, n]), swatch),
      ];
      groups.forEach((fn) => fn());

      const randomBtn = el('button', { type: 'button', class: 'questline-choice', text: '🎲 Surprise me' });
      randomBtn.addEventListener('click', () => {
        const pick = (list) => list[Math.floor(Math.random() * list.length)];
        draft.style = pick(HAIR_STYLES).id;
        [, draft.hair] = pick(HAIR_COLORS);
        [, draft.skin] = pick(SKIN_TONES);
        groups.forEach((fn) => fn());
        paint();
      });

      const syncNote = el('p', { class: 'questline-note' });
      getDaSession().then((session) => {
        if (session) syncNote.textContent = '☁ Signed in with Adobe: your seller is saved to the team sheet.';
        else syncNote.textContent = 'Saved on this device.';
      });

      const close = () => {
        clearInterval(spin);
        overlay.hidden = true;
        overlay.replaceChildren();
      };
      const submit = () => {
        const name = nameInput.value.trim();
        if (!name) {
          nameInput.focus();
          nameInput.setAttribute('aria-invalid', 'true');
          return;
        }
        draft.name = name;
        if (!draft.id) draft.id = window.crypto?.randomUUID?.() || `p${Date.now()}${Math.random()}`;
        avatar = draft;
        writeAvatar(avatar);
        close();
        updateHud();
        syncAvatar();
        resolve(avatar);
      };
      startBtn.addEventListener('click', submit);
      nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submit();
        }
      });
      nameInput.addEventListener('input', () => nameInput.removeAttribute('aria-invalid'));

      const panel = el(
        'div',
        {
          class: 'questline-panel questline-panel-intro questline-panel-creator', role: 'dialog', 'aria-label': 'Create your seller',
        },
        el('p', { class: 'questline-panel-title', text: first ? 'Create your seller' : 'Your seller' }),
        el(
          'div',
          { class: 'questline-creator' },
          el('div', { class: 'questline-creator-preview' }, preview),
          el(
            'div',
            { class: 'questline-creator-fields' },
            el('label', { class: 'questline-creator-group' }, el('span', { class: 'questline-creator-label', text: 'Name' }), nameInput),
            fields,
          ),
        ),
        syncNote,
        el('div', { class: 'questline-choices' }, startBtn, randomBtn),
      );
      panel.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        if (first) return; // a new player must create their seller first
        close();
        reject(new DialogClosed());
      });

      overlay.replaceChildren(panel);
      overlay.hidden = false;
      paint();
      nameInput.focus({ preventScroll: true });
      if (window.innerWidth < 700) overlay.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

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

  // side quest: share a won customer's story with a prospect who has the same problem
  async function offerReference(ci) {
    const letters = lettersHeld();
    if (!letters.length || state.refBoost[ci]) return;
    const c = customers[ci];
    const who = c.contact || c.company;
    const pick = await dialog.open({
      speaker: 'Your strategy',
      title: '📜 Share a customer story first?',
      lines: [`Which story would convince ${c.company}?`],
      choices: [
        ...letters.map((ri) => ({
          label: `${customers[references[ri].from].company}: ${references[ri].story[0] || 'reference letter'}`,
          value: ri,
          numbered: true,
        })),
        { label: 'Skip', value: -1, numbered: true },
      ],
    });
    if (pick < 0) return;
    const ref = references[pick];
    if (ref.to !== ci) {
      await dialog.open({
        speaker: c.contact ? `${c.contact} · ${c.company}` : c.company,
        lines: [`${who}: “Interesting, but that’s not really our situation.”`],
        note: 'No harm done. Keep the letter for a prospect with a similar problem.',
        choices: next('Continue'),
      });
      return;
    }
    const before = dealValue(ci);
    state.refsDelivered.push(pick);
    state.refBoost[ci] = true;
    state.pitchMisses[ci] = 0; // a strong reference wins back the trust lost on failed pitches
    burst(c.house.x + 0.5, c.house.y + 1, '#8ecae6', 20);
    toast(`📜 Reference landed: +${money(dealValue(ci) - before)} ARR`, 'arr');
    gain(XP.reference, `reference for ${c.company}`);
    await dialog.open({
      tone: 'good',
      title: '📜 The story lands',
      lines: [
        ...ref.story.map((line) => `“${line}”`),
        `${who}: “If it worked for ${customers[ref.from].company}, it can work for us.”`,
      ],
      note: `This deal is now worth ${money(dealValue(ci))} (lost ARR restored, +15%).`,
      link: ref.link,
      choices: next('Continue'),
    });
  }

  // side quest: a won customer asks for more
  async function pitchExpansion(ci) {
    const c = customers[ci];
    const ex = expansions[ci];
    const who = c.contact || c.company;
    const id = `x${ci}`;
    const value = expansionValue(ci);
    const misses = state.expMisses[ci] || 0;
    const ok = await dialog.open({
      tone: 'play',
      speaker: c.contact ? `${c.contact} · ${c.company}` : c.company,
      title: `📈 Expansion: ${money(value)} ARR`,
      lines: [ex.prompt],
      note: misses
        ? `Down from ${money(ex.arr)} after ${misses} weak answer${misses === 1 ? '' : 's'}.`
        : 'A weak answer costs 25% of this expansion.',
      choices: shuffle([
        { label: ex.answer, value: true, numbered: true },
        ...ex.wrong.map((w) => ({ label: w, value: false, numbered: true })),
      ]),
    });
    state.history.push(ok);
    if (ok) {
      state.expWon[ci] = value;
      burst(c.house.x + 0.5, c.house.y + 1, '#2f6fd6', 26);
      toast(`📈 +${money(value)} expansion ARR`, 'arr');
      gain(reward(XP.expansion, id), `expansion: ${c.company}`);
      syncAvatar({ quiet: true });
      await dialog.open({
        tone: 'good',
        title: `📈 Expansion won: ${c.company}`,
        lines: [`${who}: “Perfect. Let’s add it to the contract.”`, `💰 ${money(arrClosed())} of ${money(arrGoal)} goal`],
        choices: next('Onward'),
      });
      return true;
    }
    miss(id);
    state.expMisses[ci] = misses + 1;
    const lost = value - expansionValue(ci);
    save();
    updateHud();
    if (lost) toast(`📉 −${money(lost)} ARR`, 'loss');
    await dialog.open({
      tone: 'bad',
      title: 'Not quite',
      lines: [`${who}: “Hmm, I’m not sure that works for us.”`, `Better answer: ${ex.answer}`],
      note: `This expansion is now worth ${money(expansionValue(ci))}. Come back to try again.`,
      link: ex.link || c.link,
      choices: next('Continue'),
    });
    return false;
  }

  async function visitCustomer(ci) {
    const c = customers[ci];
    const who = c.contact || c.company;
    const speaker = c.contact ? `${c.contact} · ${c.company}` : c.company;
    const id = `c${ci}`;
    if (state.deals.includes(ci)) {
      if (expansionOpen(ci)) return pitchExpansion(ci);
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
    await offerReference(ci);
    const value = dealValue(ci);
    const misses = state.pitchMisses[ci] || 0;
    const pick = await dialog.open({
      speaker: 'Your strategy',
      lines: [`Which play fits ${c.company}?`, `💰 On the table: ${money(value)} ARR`],
      note: misses
        ? `Down from ${money(c.arr)} after ${misses} failed pitch${misses === 1 ? '' : 'es'}.`
        : `A wrong pitch costs 25% of this deal.${state.refBoost[ci] ? ' Includes +15% from your reference.' : ''}`,
      choices: shuffle(options),
    });
    const ok = same(pick, c.best);
    state.history.push(ok);
    const best = playFor(c);
    if (ok) {
      state.deals.push(ci);
      state.arrWon[ci] = value;
      const earned = references
        .map((r, ri) => ri)
        .filter((ri) => references[ri].from === ci && !state.letters.includes(ri));
      state.letters.push(...earned);
      syncAvatar({ quiet: true });
      burst(c.house.x + 0.5, c.house.y + 1, '#3ddc84', 30);
      toast(`💰 +${money(value)} ARR`, 'arr');
      gain(reward(XP.deal, id), `deal won: ${c.company}`);
      await dialog.open({
        tone: 'good',
        title: `🤝 Deal won: ${c.company}`,
        lines: [
          `${who}: “That is exactly what we need. Let’s do it.”`,
          `💰 ${money(value)} ARR closed · ${money(arrClosed())} of ${money(arrGoal)} goal`,
          earned.length ? `📜 ${c.contact ? c.contact.split(',')[0] : c.company} hands you a reference letter. Share it with a prospect who has a similar problem.` : '',
        ],
        note: expansions[ci] ? `Side quest: ${c.company} may want more later. Look for the blue + on their door.` : null,
        choices: next('Onward'),
      });
      if (earned.length) toast(`📜 Reference letter: ${c.company}`, 'skill');
      updateHud();
      return true;
    }
    miss(id);
    state.pitchMisses[ci] = misses + 1;
    const lost = value - dealValue(ci);
    save();
    updateHud();
    if (lost) toast(`📉 −${money(lost)} ARR`, 'loss');
    await dialog.open({
      tone: 'bad',
      title: 'Not convinced',
      lines: [
        `${who}: “I don’t see how that solves our problem.”`,
        `Better fit: ${c.best}${best?.description ? `. ${best.description}` : ''}`,
      ],
      note: lost
        ? `−${money(lost)} ARR: this deal is now worth ${money(dealValue(ci))}. Knock again to propose the better play.`
        : `This deal is at its floor (${money(dealValue(ci))}). Knock again to propose the better play.`,
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
    syncAvatar({ quiet: true });
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
          customers.length ? `💰 ARR closed: ${money(arrClosed())} of ${money(arrGoal)} (${Math.round((arrClosed() / arrGoal) * 100)}%)` : '',
          references.length || expansions.some(Boolean)
            ? `Side quests: ${state.refsDelivered.length}/${references.length} references · ${Object.keys(state.expWon).length}/${expansions.filter(Boolean).length} expansions`
            : '',
        ],
        choices: [
          { label: 'Copy result', value: 'copy', primary: true },
          { label: 'Keep exploring', value: 'close' },
        ],
      });
      again = choice === 'copy';
      if (again) {
        const text = `Questline · ${avatar?.name || 'A seller'} cleared ${content.title} 🏅\n${levelLine}\n💰 ${money(arrClosed())} of ${money(arrGoal)} ARR\n${summary}\n${grid}\n${window.location.href}`;
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

  /* Adobe: library, leaderboard, signposts */

  // a free-form panel in the overlay; resolves when closed (button or Esc)
  function showPanel(panel, focusEl) {
    return new Promise((resolve) => {
      const close = () => {
        overlay.hidden = true;
        overlay.replaceChildren();
        resolve();
      };
      panel.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        close();
      });
      panel.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
      overlay.replaceChildren(panel);
      overlay.hidden = false;
      (focusEl || panel.querySelector('button'))?.focus({ preventScroll: true });
      if (window.innerWidth < 700) overlay.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  function librarySections() {
    const teacherName = (p) => (npcs[p.teacher] ? npcs[p.teacher].name : '');
    const collateral = [];
    const seen = new Set();
    const addLink = (link, from) => {
      if (!link || seen.has(link.href)) return;
      seen.add(link.href);
      collateral.push({
        title: link.text || link.href, meta: from, link, linkLabel: 'Open ↗',
      });
    };
    content.resources.forEach((r) => {
      if (r.link) seen.add(r.link.href);
      collateral.push({
        title: r.title, meta: 'Resource', lines: [r.description], link: r.link, linkLabel: 'Open ↗',
      });
    });
    npcs.forEach((n) => addLink(n.link, `Expert · ${n.name}`));
    plays.forEach((p) => addLink(p.link, `Play · ${p.name}`));
    customers.forEach((c) => addLink(c.link, `Customer · ${c.company}`));
    content.puzzles.forEach((q) => addLink(q.link, 'Rune gate'));
    content.objections.forEach((q) => addLink(q.link, 'Objection'));
    content.expansions.forEach((e) => addLink(e.link, `Expansion · ${e.customer}`));
    if (content.shrine) addLink(content.shrine.link, 'Shrine of Insight');
    const study = (list) => list.map((q) => ({
      title: q.prompt, answer: q.answer, link: q.link,
    }));
    return [
      { icon: '📜', title: 'Collateral', items: collateral },
      {
        icon: '★',
        title: 'Experts',
        items: npcs.map((n, i) => ({
          title: n.name,
          meta: [n.expertise && `Expert for ${n.expertise}`, state.talked.includes(i) && '✓ met'].filter(Boolean).join(' · '),
          lines: n.lines,
          link: n.link,
        })),
      },
      {
        icon: '📘',
        title: 'Plays',
        items: plays.map((p, pi) => ({
          title: p.name,
          meta: [teacherName(p) && `Taught by ${teacherName(p)}`, state.plays.includes(pi) && '✓ learned'].filter(Boolean).join(' · '),
          lines: [p.description],
          link: p.link,
        })),
      },
      {
        icon: '🏠',
        title: 'Customers',
        items: customers.map((c, ci) => ({
          title: c.company,
          meta: [c.contact, `${money(c.arr)} ARR`, state.deals.includes(ci) && '✓ won'].filter(Boolean).join(' · '),
          lines: [
            ...c.situation,
            c.best && `Best play: ${c.best}`,
            c.needs.length && `Skills needed: ${c.needs.map((n) => n.name).join(', ')}`,
          ],
          link: c.link,
        })),
      },
      { icon: '🔮', title: 'Rune gates', items: study(content.puzzles) },
      { icon: '🛡', title: 'Objections', items: study(content.objections) },
    ].filter((sec) => sec.items.length);
  }

  async function openLibrary() {
    const sections = librarySections();
    const body = el('div', { class: 'questline-lib-body', role: 'tabpanel', tabindex: '0' });
    const item = (it) => el(
      'article',
      { class: 'questline-lib-item' },
      el('p', { class: 'questline-lib-title', text: it.title }),
      it.meta ? el('p', { class: 'questline-lib-meta', text: it.meta }) : null,
      ...(it.lines || []).filter(Boolean).map((line) => el('p', { class: 'questline-lib-text', text: line })),
      it.answer ? el(
        'details',
        { class: 'questline-lib-answer' },
        el('summary', { text: 'Show the answer' }),
        el('p', { text: it.answer }),
      ) : null,
      it.link ? el('a', {
        class: 'questline-lib-link', href: it.link.href, target: '_blank', rel: 'noopener', text: `📜 ${it.linkLabel || it.link.text || 'Open'}`,
      }) : null,
    );
    const tabs = [];
    function select(i) {
      tabs.forEach((b, k) => b.setAttribute('aria-selected', String(k === i)));
      body.replaceChildren(...sections[i].items.map(item));
      body.scrollTop = 0;
    }
    tabs.push(...sections.map((sec, i) => el(
      'button',
      {
        type: 'button', class: 'questline-lib-tab', role: 'tab', 'aria-selected': 'false', onclick: () => select(i),
      },
      `${sec.icon} ${sec.title} `,
      el('span', { class: 'questline-lib-count', text: String(sec.items.length) }),
    )));
    const tablist = el('div', { class: 'questline-lib-tabs', role: 'tablist', 'aria-label': 'Library sections' }, tabs);
    tablist.addEventListener('keydown', (e) => {
      const idx = tabs.indexOf(document.activeElement);
      if (idx < 0 || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      e.preventDefault();
      const to = (idx + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[to].focus();
      select(to);
    });
    const panel = el(
      'div',
      { class: 'questline-panel questline-panel-library', role: 'dialog', 'aria-label': 'Field readiness library' },
      el('p', { class: 'questline-panel-title', text: '📚 Field readiness library' }),
      el('p', { class: 'questline-note', text: 'Everything this realm teaches, in one place. Open the collateral, study the plays, peek at the answers.' }),
      tablist,
      body,
      el('div', { class: 'questline-choices' }, el('button', {
        type: 'button', class: 'questline-choice primary', 'data-close': '', text: 'Leave the library',
      })),
    );
    if (sections.length) select(0);
    if (!state.visited.includes('library')) {
      state.visited.push('library');
      gain(XP.library, 'visited the library');
    }
    await showPanel(panel, tabs[0]);
  }

  // sample data until the board reads the DA player sheet
  const LEADERS = [
    ['Sofia Marchetti', 'Italy', 0.99, 14], ['Kenji Watanabe', 'Japan', 0.96, 13],
    ['Amara Okafor', 'UK', 0.93, 13], ['Lucas Becker', 'DACH', 0.9, 12],
    ['Priyanka Rao', 'India', 0.86, 12], ['Mateo Álvarez', 'LATAM', 0.82, 11],
    ['Hannah Lindqvist', 'Nordics', 0.78, 10], ['Noah Fischer', 'US East', 0.74, 10],
    ['Chloé Dubois', 'France', 0.7, 9], ['Daniel Kim', 'US West', 0.65, 9],
  ];
  async function openLeaderboard() {
    const goal = arrGoal || 5e6;
    const rows = LEADERS.map(([name, region, share, level], i) => ({
      name, region, level, arr: Math.round(goal * share), look: i,
    }));
    const mine = arrClosed();
    const myRank = rows.filter((r) => r.arr > mine).length + 1;
    const face = (i) => {
      const c = el('canvas', {
        class: 'questline-lb-face', width: 18, height: 19, 'aria-hidden': 'true',
      });
      const look = {
        name: '',
        style: HAIR_STYLES[(i * 3) % HAIR_STYLES.length].id,
        hair: HAIR_COLORS[(i * 5 + 1) % HAIR_COLORS.length][1],
        skin: SKIN_TONES[(i * 7 + 2) % SKIN_TONES.length][1],
      };
      drawPlayer(c.getContext('2d'), 1, 2, 'down', 'stand', lookIndex(rows[i].level), 0, look);
      return c;
    };
    const table = el(
      'ol',
      { class: 'questline-lb' },
      rows.map((r, i) => el(
        'li',
        { class: `questline-lb-row${i < 3 ? ` questline-lb-top${i + 1}` : ''}` },
        el('span', { class: 'questline-lb-rank', text: ['🥇', '🥈', '🥉'][i] || `${i + 1}` }),
        face(i),
        el('span', { class: 'questline-lb-name', text: r.name }),
        el('span', { class: 'questline-lb-meta', text: `Lv ${r.level} · ${r.region}` }),
        el('span', { class: 'questline-lb-arr', text: money(r.arr) }),
      )),
    );
    const me = el('p', {
      class: 'questline-lb-me',
      text: myRank <= 10
        ? `⭐ ${avatar?.name || 'You'}: you would be #${myRank} with ${money(mine)} ARR!`
        : `${avatar?.name || 'You'}: #${myRank} with ${money(mine)} ARR. Close deals to climb the board.`,
    });
    const panel = el(
      'div',
      { class: 'questline-panel questline-panel-board', role: 'dialog', 'aria-label': 'Top 10 sellers' },
      el('p', { class: 'questline-panel-title', text: '🏆 Top 10 sellers' }),
      table,
      me,
      el('p', { class: 'questline-note', text: 'Sample data for now. The real board will read the team sheet.' }),
      el('div', { class: 'questline-choices' }, el('button', {
        type: 'button', class: 'questline-choice primary', 'data-close': '', text: 'Back to the plaza',
      })),
    );
    await showPanel(panel);
  }

  async function readSignpost() {
    const inSouth = state.area === 'south';
    await dialog.open({
      speaker: 'Signpost',
      lines: inSouth
        ? [`▲ ${content.title}`, 'Experts, customers, the rune gates and the boss.']
        : ['▼ Adobe', 'The Field readiness library and the top 10 board.'],
      choices: next('OK'),
    });
  }

  const WISHES = [
    'May every pitch land on the first try.',
    'May your pipeline overflow like this fountain.',
    'May procurement sign before quarter end.',
    'May the demo gods smile on you.',
  ];
  async function tossCoin() {
    burst(south.fountain.x + 1, south.fountain.y + 1, '#f4d35e', 14);
    await dialog.open({
      speaker: 'Fountain',
      lines: ['🪙 Plink! The coin sinks and glitters.', WISHES[Math.floor(Math.random() * WISHES.length)]],
      choices: next('Make a wish ✨'),
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
    else if (target.type === 'library') run(openLibrary);
    else if (target.type === 'board') run(openLeaderboard);
    else if (target.type === 'signpost') run(readSignpost);
    else if (target.type === 'fountain') run(tossCoin);
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
      for (let ci = 0; ci < customers.length; ci += 1) {
        while (expansionOpen(ci)) await visitCustomer(ci);
      }
      for (let gi = 0; gi < numGates; gi += 1) {
        while (!state.gates[gi]) await challengeGate(gi, { skipIntro: true });
      }
      while (state.bossHp > 0) await fightBoss({ skipIntro: state.bossHp < maxHp, story: true });
      state.x = world.boss.x - 1;
      state.y = world.boss.y + 1;
      state.dir = 'right';
      state.area = 'realm';
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
    if (!avatar) await editAvatar({ first: true });
    const hasProgress = saved && (saved.talked?.length || saved.solved?.length || saved.won);
    const choice = await dialog.open({
      tone: 'intro',
      title: content.title,
      lines: [`Welcome, ${avatar.name}!`, content.intro],
      note: 'Move: arrow keys / WASD or the on-screen pad · Interact: Space, Enter or A · Esc closes a conversation',
      choices: [
        { label: hasProgress ? 'Continue quest' : 'Start quest', value: 'play', primary: true },
        { label: 'Story mode (no walking)', value: 'story' },
      ],
    });
    begin();
    if (choice === 'story') await storyMode();
  }

  avatarBtn.addEventListener('click', () => run(() => editAvatar()));
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
  // walking off the gap in the hedge switches screens
  function travel(to) {
    busy = true;
    stage.classList.add('questline-fading');
    setTimeout(() => {
      Object.assign(state, to);
      motion.tx = state.x;
      motion.ty = state.y;
      save();
      applyArea();
      stage.classList.remove('questline-fading');
      busy = false;
      toast(to.area === 'south' ? '📍 Adobe' : `📍 ${content.title}`, 'skill');
    }, 220);
  }

  function tryStep(dir) {
    if (motion.moving || busy) return;
    state.dir = dir;
    const [dx, dy] = DIRS[dir];
    if (state.area === 'realm' && dir === 'down' && state.y + dy >= ROWS && state.x === 4) {
      travel({
        area: 'south', x: 4, y: 0, dir: 'down',
      });
      return;
    }
    if (state.area === 'south' && dir === 'up' && state.y + dy < 0 && state.x === 4) {
      travel({
        area: 'realm', x: 4, y: ROWS - 1, dir: 'up',
      });
      return;
    }
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
  const butterflies = [
    {
      x: 48, y: 70, rx: 22, ry: 10, speed: 0.7, phase: 0, color: '#ffd166', light: '#fff6c9',
    },
    {
      x: 250, y: 205, rx: 30, ry: 12, speed: 0.55, phase: 2, color: '#8ecae6', light: '#e0f4ff',
    },
    {
      x: 120, y: 215, rx: 26, ry: 8, speed: 0.8, phase: 4, color: '#ff8fb8', light: '#ffe0ec',
    },
    {
      x: 300, y: 40, rx: 24, ry: 10, speed: 0.6, phase: 1, color: '#ffffff', light: '#ffd6e6',
    },
  ];
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
    if (shownArea !== state.area) applyArea();
    updatePlate(!busy && state.area === 'realm');
  }

  let terrain = null;
  let shade = null;
  let cloud = null;
  let southTerrain = null;
  let southShade = null;
  function buildOverlays() {
    terrain = buildTerrain(world.grid);
    southTerrain = buildTerrain(south.grid);
    // golden-hour light over Adobe
    southShade = document.createElement('canvas');
    southShade.width = W;
    southShade.height = H;
    const ss = southShade.getContext('2d');
    const sun = ss.createRadialGradient(W * 0.85, -20, 10, W * 0.85, -20, W * 0.9);
    sun.addColorStop(0, 'rgba(255,214,150,0.28)');
    sun.addColorStop(1, 'rgba(255,170,120,0)');
    ss.fillStyle = sun;
    ss.fillRect(0, 0, W, H);
    const sv = ss.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, W * 0.62);
    sv.addColorStop(0, 'rgba(0,0,0,0)');
    sv.addColorStop(1, 'rgba(40,10,40,0.35)');
    ss.fillStyle = sv;
    ss.fillRect(0, 0, W, H);
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

  function playerActor(t) {
    const px = (motion.moving ? state.x + (motion.tx - state.x) * motion.prog : state.x) * TILE;
    const py = (motion.moving ? state.y + (motion.ty - state.y) * motion.prog : state.y) * TILE;
    let step = 'stand';
    if (motion.moving) step = Math.floor(t / 130) % 2 ? 'a' : 'b';
    return {
      y: py,
      draw: () => {
        const li = lookIndex(levelOf(state.xp));
        const look = avatar || DEFAULT_AVATAR;
        drawPlayer(g, Math.round(px), Math.round(py), state.dir, step, li, t, look);
      },
    };
  }

  function drawClouds(t) {
    g.globalAlpha = 0.09;
    [0, 1].forEach((k) => {
      const cx = ((((t / 1000) * (5 + k * 3)) + k * 260) % (W + 140)) - 130;
      g.drawImage(cloud, Math.round(cx), 30 + k * 120);
    });
    g.globalAlpha = 1;
  }

  function drawParticles() {
    particles.forEach((p) => {
      g.globalAlpha = Math.max(0, p.life / 0.8);
      rect(g, p.color, Math.round(p.x), Math.round(p.y), 2, 2);
    });
    g.globalAlpha = 1;
  }

  function renderSouth(t) {
    g.drawImage(southTerrain, 0, 0);
    drawAnimatedTiles(g, south.grid, t);
    drawLibrary(g, south.library.x * TILE, south.library.y * TILE, t);
    const at = (p) => [p.x * TILE, p.y * TILE];
    const actors = [
      playerActor(t),
      ...south.lamps.map((l) => ({ y: l.y * TILE, draw: () => drawLamp(g, ...at(l), t) })),
      { y: south.board.y * TILE, draw: () => drawBlackboard(g, ...at(south.board)) },
      { y: (south.fountain.y + 1) * TILE, draw: () => drawFountain(g, ...at(south.fountain), t) },
      { y: south.signpost.y * TILE, draw: () => drawPost(g, ...at(south.signpost)) },
    ];
    actors.sort((a, b) => a.y - b.y).forEach((a) => a.draw());
    butterflies.forEach((b) => drawButterfly(g, b, t));
    drawClouds(t);
    g.drawImage(southShade, 0, 0);
    // drifting blossom petals
    motes.forEach((m, i) => {
      if (m.ember) return;
      const wob = Math.sin(t / 700 + m.phase) * 3;
      g.globalAlpha = 0.55 + 0.35 * Math.sin(t / 300 + m.phase * 3);
      rect(g, i % 2 ? '#ffc2d6' : '#fff0f6', Math.round(m.x + wob), Math.round(m.y), i % 3 ? 1 : 2, 1);
    });
    g.globalAlpha = 1;
    drawParticles();
  }

  function render(t) {
    if (!terrain) buildOverlays();
    if (state.area === 'south') {
      renderSouth(t);
      return;
    }
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
      if (expansionOpen(i)) {
        bang(x + 13, y + 11, i + 2, '#fff', '#2f6fd6');
        rect(g, '#fff', x + 14, y + 15 + bob, 4, 1); // turn the "!" into a "+"
        glow(g, x + 16, y + 15, 14, '#10306a', 0.9);
      } else if (state.deals.includes(i)) drawCheck(g, x + 13, y + 11 + bob);
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

    const actors = [
      ...npcs.map((n, i) => ({
        y: n.y * TILE,
        draw: () => {
          const bob = Math.floor(t / 600 + i) % 2;
          const hair = NPC_HAIR[i % NPC_HAIR.length];
          drawPerson(g, n.x * TILE, n.y * TILE - bob, 'down', 'stand', n.pal, hair);
          if (unlearned(i).length) bang(n.x * TILE + 5, n.y * TILE - 11, i, '#2f6fd6');
          else if (!state.talked.includes(i)) bang(n.x * TILE + 5, n.y * TILE - 11, i);
        },
      })),
      playerActor(t),
      {
        y: world.signpost.y * TILE,
        draw: () => drawPost(g, world.signpost.x * TILE, world.signpost.y * TILE),
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
    drawClouds(t);

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

    drawParticles();
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
  applyArea();
  requestAnimationFrame(frame);
  busy = false;
  run(intro);
}
