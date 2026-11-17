// The made-up links in the README's pictures, and the pictures on them: flat illustrations drawn as SVG, with no
// photos, no logos and no real places. People, posts and pictures are invented. Pages use .example domains (reserved,
// never a real site); only social posts and the big shelf's links carry real sites' names, as the app needs them to
// draw those cards. make-docs-images.mjs rasterises the pictures and saves the links through the app's own API.

const svg = (w, h, defs, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs>${defs}</defs>${body}</svg>`;
const lin = (id, a, b, vertical = true) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="${vertical ? 0 : 1}" y2="${vertical ? 1 : 0}"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>`;
const rad = (id, a, b) => `<radialGradient id="${id}" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></radialGradient>`;
// a small seeded random, so the same picture comes out the same every time
const rng = seed => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

export const scenes = {
  // the coast: sky, low sun, sea, a grassy cliff with a path and a lighthouse
  coast: (w, h, o = {}) => {
    const sky = o.sky ?? ['#ffcf9e', '#fff1dc'];
    const sea = o.sea ?? ['#4a90b0', '#1f5674'];
    const r = rng(o.seed ?? 3);
    const glints = Array.from({length: 26}, () => {
      const x = r() * w, y = h * 0.5 + r() * h * 0.45;
      return `<rect x="${x}" y="${y}" width="${20 + r() * 50}" height="3" rx="1.5" fill="#ffffff" opacity="${0.18 + r() * 0.25}"/>`;
    }).join('');
    return svg(w, h, lin('sky', sky[0], sky[1]) + lin('sea', sea[0], sea[1]),
      `<rect width="${w}" height="${h}" fill="url(#sky)"/>
      <circle cx="${w * 0.3}" cy="${h * 0.36}" r="${h * 0.1}" fill="${o.sun ?? '#ffa45c'}"/>
      <rect y="${h * 0.48}" width="${w}" height="${h * 0.52}" fill="url(#sea)"/>${glints}
      <path d="M0 ${h * 0.48} L0 ${h * 0.4} Q${w * 0.1} ${h * 0.36} ${w * 0.2} ${h * 0.42} L${w * 0.27} ${h * 0.48} Z" fill="#7d9f97"/>
      <path d="M${w * 0.5} ${h} L${w * 0.58} ${h * 0.56} Q${w * 0.64} ${h * 0.44} ${w * 0.76} ${h * 0.46} L${w} ${h * 0.42} L${w} ${h} Z" fill="#cdb48c"/>
      <path d="M${w * 0.58} ${h * 0.56} Q${w * 0.64} ${h * 0.44} ${w * 0.76} ${h * 0.46} L${w} ${h * 0.42} L${w} ${h * 0.5} Q${w * 0.78} ${h * 0.52} ${w * 0.66} ${h * 0.53} Q${w * 0.61} ${h * 0.55} ${w * 0.6} ${h * 0.6} Z" fill="#6e9b5a"/>
      <path d="M${w * 0.62} ${h} Q${w * 0.7} ${h * 0.7} ${w * 0.9} ${h * 0.5}" stroke="#f3e6c8" stroke-width="${h * 0.014}" fill="none" stroke-dasharray="${h * 0.03} ${h * 0.02}" stroke-linecap="round"/>
      ${o.lighthouse === false ? '' : `<g transform="translate(${w * 0.86} ${h * 0.44})">
        <path d="M${-h * 0.025} 0 L${-h * 0.018} ${-h * 0.2} L${h * 0.018} ${-h * 0.2} L${h * 0.025} 0 Z" fill="#fbf7ef"/>
        <rect x="${-h * 0.022}" y="${-h * 0.12}" width="${h * 0.044}" height="${h * 0.03}" fill="#d9534f"/>
        <rect x="${-h * 0.022}" y="${-h * 0.06}" width="${h * 0.044}" height="${h * 0.03}" fill="#d9534f"/>
        <rect x="${-h * 0.022}" y="${-h * 0.235}" width="${h * 0.044}" height="${h * 0.035}" rx="3" fill="#3b4a5a"/>
        <circle cy="${-h * 0.218}" r="${h * 0.012}" fill="#ffe08a"/></g>`}`);
  },
  // rolling hills with a path up to a ridge
  hills: (w, h, o = {}) => {
    const sky = o.sky ?? ['#c9d9ff', '#f3f0ff'];
    const c = o.hills ?? ['#6f9f7b', '#4f8463', '#3a6b52'];
    return svg(w, h, lin('sky', sky[0], sky[1]),
      `<rect width="${w}" height="${h}" fill="url(#sky)"/>
      <circle cx="${w * 0.74}" cy="${h * 0.28}" r="${h * 0.09}" fill="${o.sun ?? '#fff3c4'}"/>
      <path d="M0 ${h * 0.55} Q${w * 0.25} ${h * 0.3} ${w * 0.5} ${h * 0.5} T${w} ${h * 0.4} L${w} ${h} L0 ${h} Z" fill="${c[0]}"/>
      <path d="M0 ${h * 0.7} Q${w * 0.3} ${h * 0.5} ${w * 0.6} ${h * 0.68} T${w} ${h * 0.62} L${w} ${h} L0 ${h} Z" fill="${c[1]}"/>
      <path d="M0 ${h * 0.86} Q${w * 0.4} ${h * 0.7} ${w * 0.7} ${h * 0.84} T${w} ${h * 0.82} L${w} ${h} L0 ${h} Z" fill="${c[2]}"/>
      <path d="M${w * 0.34} ${h} Q${w * 0.4} ${h * 0.78} ${w * 0.52} ${h * 0.72} Q${w * 0.62} ${h * 0.66} ${w * 0.58} ${h * 0.52}" stroke="#efe2c2" stroke-width="${h * 0.016}" fill="none" stroke-linecap="round"/>`);
  },
  // focaccia in a tray, from above: golden dough, dimples, herbs
  focaccia: (w, h) => {
    const r = rng(11);
    const dots = Array.from({length: 60}, () => `<circle cx="${w * 0.14 + r() * w * 0.72}" cy="${h * 0.16 + r() * h * 0.68}" r="${h * (0.012 + r() * 0.016)}" fill="#c98a3a" opacity=".7"/>`).join('');
    const herbs = Array.from({length: 22}, () => `<path d="M${w * 0.16 + r() * w * 0.68} ${h * 0.18 + r() * h * 0.64} l${h * 0.03} ${-h * 0.012}" stroke="#4d7a3a" stroke-width="${h * 0.01}" stroke-linecap="round"/>`).join('');
    return svg(w, h, rad('dough', '#f2c776', '#d99b45'),
      `<rect width="${w}" height="${h}" fill="#3d3a44"/><rect x="${w * 0.08}" y="${h * 0.1}" width="${w * 0.84}" height="${h * 0.8}" rx="${h * 0.05}" fill="#2a2830"/>
      <rect x="${w * 0.11}" y="${h * 0.14}" width="${w * 0.78}" height="${h * 0.72}" rx="${h * 0.06}" fill="url(#dough)"/>${dots}${herbs}`);
  },
  // a noodle bowl from above
  bowl: (w, h, o = {}) => {
    const cx = w * 0.5, cy = h * 0.5, R = h * 0.38;
    const r = rng(o.seed ?? 5);
    const noodles = Array.from({length: 18}, () => {
      const a = r() * Math.PI * 2, b = a + 1 + r() * 2, rr = R * (0.2 + r() * 0.55);
      return `<path d="M${cx + rr * Math.cos(a)} ${cy + rr * Math.sin(a)} Q${cx} ${cy} ${cx + rr * Math.cos(b)} ${cy + rr * Math.sin(b)}" stroke="${o.noodle ?? '#f3d27a'}" stroke-width="${h * 0.012}" fill="none" stroke-linecap="round"/>`;
    }).join('');
    return svg(w, h, rad('bowl', o.bowl ?? '#3f6e8a', '#24475c'),
      `<rect width="${w}" height="${h}" fill="${o.bg ?? '#efe6da'}"/>
      <circle cx="${cx}" cy="${cy}" r="${R * 1.12}" fill="url(#bowl)"/><circle cx="${cx}" cy="${cy}" r="${R * 0.92}" fill="${o.broth ?? '#c9783d'}"/>${noodles}
      <circle cx="${cx + R * 0.35}" cy="${cy - R * 0.3}" r="${R * 0.16}" fill="#fff6e0"/><circle cx="${cx + R * 0.35}" cy="${cy - R * 0.3}" r="${R * 0.08}" fill="#f2a93b"/>
      ${Array.from({length: 9}, () => `<circle cx="${cx + (r() - 0.5) * R}" cy="${cy + (r() - 0.5) * R}" r="${h * 0.012}" fill="#6db35a"/>`).join('')}
      <path d="M${w * 0.82} ${h * 0.1} L${w * 0.62} ${h * 0.5}" stroke="#b07a4a" stroke-width="${h * 0.014}" stroke-linecap="round"/><path d="M${w * 0.86} ${h * 0.12} L${w * 0.66} ${h * 0.52}" stroke="#b07a4a" stroke-width="${h * 0.014}" stroke-linecap="round"/>`);
  },
  // a houseplant in a pot
  plant: (w, h) => svg(w, h, lin('wall', '#e6efe4', '#d2e2cf'),
    `<rect width="${w}" height="${h}" fill="url(#wall)"/><rect y="${h * 0.78}" width="${w}" height="${h * 0.22}" fill="#c7b59a"/>
    ${[[-50, 0.36], [-20, 0.3], [10, 0.34], [40, 0.3], [70, 0.36], [-80, 0.28]].map(([a, l]) => `<ellipse cx="0" cy="${-h * l / 2}" rx="${h * 0.06}" ry="${h * l / 2}" fill="#3f8a5a" transform="translate(${w * 0.5} ${h * 0.62}) rotate(${a})"/>`).join('')}
    <path d="M${w * 0.42} ${h * 0.6} L${w * 0.58} ${h * 0.6} L${w * 0.555} ${h * 0.82} L${w * 0.445} ${h * 0.82} Z" fill="#d9774f"/><rect x="${w * 0.41}" y="${h * 0.58}" width="${w * 0.18}" height="${h * 0.04}" rx="4" fill="#c4643f"/>`),
  // a little synth: knobs and keys
  synth: (w, h) => svg(w, h, lin('bg', '#2b2f45', '#1c1f30'),
    `<rect width="${w}" height="${h}" fill="url(#bg)"/><rect x="${w * 0.1}" y="${h * 0.2}" width="${w * 0.8}" height="${h * 0.62}" rx="${h * 0.03}" fill="#e9e4da"/>
    ${Array.from({length: 6}, (_, i) => `<circle cx="${w * (0.2 + i * 0.12)}" cy="${h * 0.34}" r="${h * 0.045}" fill="#2c2c34"/><path d="M${w * (0.2 + i * 0.12)} ${h * 0.34} l${h * 0.03 * Math.cos(i)} ${-h * 0.03}" stroke="#ff8a5c" stroke-width="4" stroke-linecap="round"/>`).join('')}
    ${Array.from({length: 14}, (_, i) => `<rect x="${w * 0.13 + i * w * 0.053}" y="${h * 0.46}" width="${w * 0.05}" height="${h * 0.32}" rx="4" fill="#fbfaf7" stroke="#c9c2b4" stroke-width="2"/>`).join('')}
    ${[0, 1, 3, 4, 5, 7, 8, 10, 11, 12].map(i => `<rect x="${w * 0.163 + i * w * 0.053}" y="${h * 0.46}" width="${w * 0.03}" height="${h * 0.19}" rx="3" fill="#2c2c34"/>`).join('')}`),
  // type design: a big Aa on a grid
  type: (w, h) => svg(w, h, '',
    `<rect width="${w}" height="${h}" fill="#f4efe6"/>${Array.from({length: 12}, (_, i) => `<path d="M${(w / 12) * i} 0 V${h}" stroke="#e2d9c8" stroke-width="2"/>`).join('')}
    <path d="M0 ${h * 0.72} H${w}" stroke="#e5604d" stroke-width="3"/><path d="M0 ${h * 0.3} H${w}" stroke="#4c7bd9" stroke-width="3" stroke-dasharray="10 8"/>
    <text x="${w * 0.5}" y="${h * 0.72}" text-anchor="middle" font-family="Georgia, serif" font-size="${h * 0.62}" fill="#1f2433">Aa</text>
    <circle cx="${w * 0.27}" cy="${h * 0.3}" r="8" fill="#4c7bd9"/><circle cx="${w * 0.73}" cy="${h * 0.72}" r="8" fill="#e5604d"/>`),
  // a cabin in the pines at dusk
  cabin: (w, h) => svg(w, h, lin('sky', '#3b3f7a', '#e59a7a'),
    `<rect width="${w}" height="${h}" fill="url(#sky)"/><circle cx="${w * 0.78}" cy="${h * 0.22}" r="${h * 0.05}" fill="#fff4d6"/>
    <path d="M0 ${h * 0.75} Q${w * 0.5} ${h * 0.62} ${w} ${h * 0.74} L${w} ${h} L0 ${h} Z" fill="#2f4a3e"/>
    ${[0.08, 0.2, 0.84, 0.94, 0.7].map((x, i) => `<path d="M${w * x} ${h * (0.32 + (i % 2) * 0.06)} L${w * x + h * 0.08} ${h * 0.78} L${w * x - h * 0.08} ${h * 0.78} Z" fill="#1f3a30"/>`).join('')}
    <rect x="${w * 0.38}" y="${h * 0.52}" width="${w * 0.24}" height="${h * 0.24}" fill="#8a5a3c"/><path d="M${w * 0.35} ${h * 0.53} L${w * 0.5} ${h * 0.38} L${w * 0.65} ${h * 0.53} Z" fill="#5e3a29"/>
    <rect x="${w * 0.42}" y="${h * 0.58}" width="${w * 0.05}" height="${h * 0.07}" fill="#ffd27a"/><rect x="${w * 0.53}" y="${h * 0.6}" width="${w * 0.05}" height="${h * 0.16}" fill="#3e261b"/>`),
  // a desk: laptop with code lines, a lamp, a mug
  desk: (w, h, o = {}) => svg(w, h, lin('bg', o.bg?.[0] ?? '#5a4fcf', o.bg?.[1] ?? '#2d2a6e'),
    `<rect width="${w}" height="${h}" fill="url(#bg)"/><rect y="${h * 0.74}" width="${w}" height="${h * 0.26}" fill="#1d1b45"/>
    <rect x="${w * 0.28}" y="${h * 0.26}" width="${w * 0.44}" height="${h * 0.42}" rx="${h * 0.02}" fill="#14132b"/>
    ${Array.from({length: 7}, (_, i) => `<rect x="${w * (0.31 + (i % 3) * 0.02)}" y="${h * (0.31 + i * 0.05)}" width="${w * (0.12 + ((i * 7) % 5) * 0.04)}" height="${h * 0.018}" rx="4" fill="${['#9c8cf2', '#4cc9f0', '#f3f1fb', '#f72585'][i % 4]}" opacity=".85"/>`).join('')}
    <path d="M${w * 0.24} ${h * 0.7} L${w * 0.76} ${h * 0.7} L${w * 0.8} ${h * 0.75} L${w * 0.2} ${h * 0.75} Z" fill="#2b2950"/>
    <path d="M${w * 0.86} ${h * 0.74} L${w * 0.86} ${h * 0.42} L${w * 0.78} ${h * 0.3}" stroke="#d8d4f0" stroke-width="${h * 0.012}" fill="none"/><path d="M${w * 0.73} ${h * 0.28} L${w * 0.83} ${h * 0.24} L${w * 0.82} ${h * 0.36} Z" fill="#d8d4f0"/>
    <rect x="${w * 0.1}" y="${h * 0.62}" width="${w * 0.07}" height="${h * 0.12}" rx="6" fill="#f0e6d8"/>`),
  // city rooftops and a tram
  city: (w, h) => svg(w, h, lin('sky', '#ffd9c0', '#fff5ea'),
    `<rect width="${w}" height="${h}" fill="url(#sky)"/>
    ${[[0, 0.42, 0.16, '#e9a77f'], [0.15, 0.36, 0.14, '#f2c48d'], [0.28, 0.46, 0.18, '#d98c6a'], [0.45, 0.32, 0.12, '#f4d3a3'], [0.56, 0.4, 0.16, '#e7b07a'], [0.71, 0.3, 0.13, '#efc39a'], [0.83, 0.44, 0.17, '#d9906d']].map(([x, y, bw, c]) => `<rect x="${w * x}" y="${h * y}" width="${w * bw}" height="${h}" fill="${c}"/><path d="M${w * x - 6} ${h * y} L${w * (x + bw / 2)} ${h * (y - 0.07)} L${w * (x + bw) + 6} ${h * y} Z" fill="#b5553f"/>${Array.from({length: 3}, (_, i) => `<rect x="${w * (x + 0.025 + i * bw * 0.3)}" y="${h * (y + 0.08)}" width="${w * 0.025}" height="${h * 0.06}" fill="#fff4e4"/>`).join('')}`).join('')}
    <rect x="${w * 0.3}" y="${h * 0.68}" width="${w * 0.36}" height="${h * 0.18}" rx="${h * 0.03}" fill="#f2c230"/><rect x="${w * 0.33}" y="${h * 0.71}" width="${w * 0.3}" height="${h * 0.06}" fill="#fff8e0"/>
    <path d="M0 ${h * 0.9} H${w}" stroke="#8a7a6a" stroke-width="6"/>`),
  // a mechanical watch face
  watch: (w, h) => svg(w, h, rad('face', '#fdfaf3', '#e5dccb'),
    `<rect width="${w}" height="${h}" fill="#2b3a4a"/><circle cx="${w * 0.5}" cy="${h * 0.5}" r="${h * 0.4}" fill="#c9a86a"/><circle cx="${w * 0.5}" cy="${h * 0.5}" r="${h * 0.35}" fill="url(#face)"/>
    ${Array.from({length: 12}, (_, i) => `<rect x="${w * 0.5 - 3}" y="${h * 0.18}" width="6" height="${h * 0.04}" fill="#2b3a4a" transform="rotate(${i * 30} ${w * 0.5} ${h * 0.5})"/>`).join('')}
    <circle cx="${w * 0.5}" cy="${h * 0.64}" r="${h * 0.08}" fill="none" stroke="#c9a86a" stroke-width="4" stroke-dasharray="6 5"/>
    <path d="M${w * 0.5} ${h * 0.5} L${w * 0.5} ${h * 0.26}" stroke="#2b3a4a" stroke-width="8" stroke-linecap="round"/><path d="M${w * 0.5} ${h * 0.5} L${w * 0.64} ${h * 0.44}" stroke="#2b3a4a" stroke-width="10" stroke-linecap="round"/><circle cx="${w * 0.5}" cy="${h * 0.5}" r="10" fill="#d9534f"/>`),
  // a ferry on the open sea
  ferry: (w, h) => svg(w, h, lin('sky', '#a8d8ea', '#e8f6fb') + lin('sea', '#3f8fb0', '#245f7d'),
    `<rect width="${w}" height="${h}" fill="url(#sky)"/><rect y="${h * 0.58}" width="${w}" height="${h * 0.42}" fill="url(#sea)"/>
    <path d="M${w * 0.62} ${h * 0.58} Q${w * 0.8} ${h * 0.46} ${w} ${h * 0.52} L${w} ${h * 0.58} Z" fill="#7aa58c"/>
    <path d="M${w * 0.22} ${h * 0.6} L${w * 0.6} ${h * 0.6} L${w * 0.55} ${h * 0.7} L${w * 0.26} ${h * 0.7} Z" fill="#2f4f6f"/>
    <rect x="${w * 0.28}" y="${h * 0.5}" width="${w * 0.26}" height="${h * 0.1}" rx="6" fill="#fbfbf8"/><rect x="${w * 0.33}" y="${h * 0.43}" width="${w * 0.14}" height="${h * 0.07}" rx="5" fill="#fbfbf8"/>
    <rect x="${w * 0.42}" y="${h * 0.36}" width="${w * 0.03}" height="${h * 0.07}" fill="#e2574c"/>${Array.from({length: 6}, (_, i) => `<rect x="${w * (0.3 + i * 0.04)}" y="${h * 0.53}" width="${w * 0.022}" height="${h * 0.03}" rx="3" fill="#7fb7d6"/>`).join('')}
    <path d="M${w * 0.2} ${h * 0.72} Q${w * 0.1} ${h * 0.74} 0 ${h * 0.73}" stroke="#ffffff" stroke-width="5" opacity=".6" fill="none"/>`),
  // abstract shapes for a code repo or a talk (on the app's own colours)
  shapes: (w, h, o = {}) => {
    const c = o.colors ?? ['#4361ee', '#4cc9f0', '#f72585', '#9c8cf2'];
    return svg(w, h, lin('bg', c[0], c[1], false),
      `<rect width="${w}" height="${h}" fill="url(#bg)"/><circle cx="${w * 0.3}" cy="${h * 0.6}" r="${h * 0.3}" fill="${c[2]}" opacity=".85"/>
      <rect x="${w * 0.5}" y="${h * 0.2}" width="${h * 0.42}" height="${h * 0.42}" rx="${h * 0.06}" fill="${c[3]}" opacity=".9" transform="rotate(12 ${w * 0.6} ${h * 0.4})"/>
      <path d="M${w * 0.1} ${h * 0.18} H${w * 0.42}" stroke="#ffffff" stroke-width="${h * 0.03}" stroke-linecap="round" opacity=".8"/><path d="M${w * 0.1} ${h * 0.28} H${w * 0.3}" stroke="#ffffff" stroke-width="${h * 0.03}" stroke-linecap="round" opacity=".6"/>`);
  },
  // a loaf on a board, scored across the top; seeds on a rye
  loaf: (w, h, o = {}) => {
    const cx = w * 0.5, cy = h * 0.52, rx = w * 0.3, ry = h * 0.3;
    const r = rng(o.seed ?? 4);
    const seeds = o.seeds ? Array.from({length: 70}, () => {
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 0.9;
      return `<ellipse cx="${cx + Math.cos(a) * d * rx}" cy="${cy + Math.sin(a) * d * ry}" rx="${h * 0.012}" ry="${h * 0.006}" fill="#f3e6c8" transform="rotate(${r() * 180} ${cx + Math.cos(a) * d * rx} ${cy + Math.sin(a) * d * ry})"/>`;
    }).join('') : '';
    return svg(w, h, lin('bg', o.bg ?? '#e9dfd0', '#d8c9b4') + rad('crust', ...(o.crust ?? ['#e3a956', '#a9622a'])),
      `<rect width="${w}" height="${h}" fill="url(#bg)"/><rect x="${w * 0.1}" y="${h * 0.14}" width="${w * 0.8}" height="${h * 0.76}" rx="${h * 0.06}" fill="#a9794f"/>
      <ellipse cx="${cx}" cy="${cy + h * 0.025}" rx="${rx * 1.02}" ry="${ry * 1.02}" fill="#6e4a2c" opacity=".45"/><ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#crust)"/>${seeds}
      ${[-0.5, -0.15, 0.2, 0.55].map(x => `<path d="M${cx + rx * x - w * 0.03} ${cy - ry * 0.55} Q${cx + rx * x + w * 0.05} ${cy} ${cx + rx * x - w * 0.03} ${cy + ry * 0.55}" stroke="${o.score ?? '#f6e3bd'}" stroke-width="${h * 0.02}" fill="none" stroke-linecap="round"/>`).join('')}`);
  },
  // seeded crackers laid out on a dark plate
  crackers: (w, h) => {
    const r = rng(7), size = h * 0.21;
    const pieces = Array.from({length: 9}, (_, i) => {
      const x = w * 0.2 + (i % 3) * size * 1.5, y = h * 0.14 + Math.floor(i / 3) * size * 1.2;
      const dots = Array.from({length: 12}, () => `<circle cx="${x + r() * size}" cy="${y + r() * size * 0.8}" r="${h * 0.007}" fill="#5c3b1e"/>`).join('');
      return `<g transform="rotate(${(r() - 0.5) * 14} ${x + size / 2} ${y + size / 2})"><rect x="${x}" y="${y}" width="${size * 1.2}" height="${size * 0.95}" rx="${h * 0.012}" fill="#cf9a5e"/>${dots}</g>`;
    }).join('');
    return svg(w, h, lin('bg', '#34404d', '#222b35'), `<rect width="${w}" height="${h}" fill="url(#bg)"/>${pieces}`);
  },
};

// name -> [scene, width, height, options]
export const PICTURES = {
  'cliff-article': ['coast', 1200, 750, {seed: 9, sky: ['#ffd6b0', '#fff4e6'], sun: '#ff9a52'}],
  'focaccia': ['focaccia', 1200, 750, {}],
  'noodles': ['bowl', 1200, 750, {seed: 5}],
  'chickpeas': ['bowl', 1200, 750, {seed: 8, broth: '#e6b35c', noodle: '#f7e3b0', bowl: '#8a4f7d', bg: '#f3e9e1'}],
  'soup': ['bowl', 1200, 750, {seed: 12, broth: '#d9a441', noodle: '#f3e6bf', bowl: '#2f6f5e', bg: '#efe7d8'}],
  'salad': ['bowl', 1200, 750, {seed: 21, broth: '#86b85c', noodle: '#e3f2b6', bowl: '#e9dcc7', bg: '#f5efe6'}],
  'ridge': ['hills', 1200, 750, {}],
  'azores': ['hills', 1200, 750, {sky: ['#bfe6ff', '#f2fbff'], hills: ['#7fbf8f', '#4f9b6a', '#2f7a52'], sun: '#ffffff'}],
  'cabin': ['cabin', 1200, 750, {}],
  'ferry': ['ferry', 1200, 750, {}],
  'lisbon': ['city', 1200, 750, {}],
  'plant': ['plant', 1200, 750, {}],
  'synth': ['synth', 1200, 750, {}],
  'type': ['type', 1200, 750, {}],
  'watch': ['watch', 1200, 750, {}],
  'boring': ['desk', 1200, 750, {}],
  'local-first': ['desk', 1200, 750, {bg: ['#0f766e', '#134e4a']}],
  'sync-repo': ['shapes', 1200, 750, {}],
  'batard': ['loaf', 1200, 750, {}],
  'seeded-rye': ['loaf', 1200, 750, {seed: 6, seeds: true, crust: ['#a56a3c', '#5e3a20'], bg: '#dfe5e2', score: '#e5cfa6'}],
  'crackers': ['crackers', 1200, 750, {}],
};

// hoursAgo is before the run. The first four wait in New to sort, newest first.
export const LINKS = [
  {id: 'cliff-path', url: 'https://coastwalks.example/cliff-path', title: 'The cliff path from the old harbour', domain: 'coastwalks.example', source: 'telegram', status: 'inbox',
    hoursAgo: 1, categories: ['travel'], picture: 'cliff-article', description: 'Nine kilometres from the harbour wall to the lighthouse, with one steep climb.'},
  {id: 'ferry', url: 'https://ferries.example/islands/summer', title: 'Ferry times for the islands', domain: 'ferries.example', source: 'whatsapp', status: 'inbox',
    hoursAgo: 3, categories: ['travel'], picture: 'ferry', description: 'Summer timetable, every crossing and the last boat back.'},
  {id: 'focaccia', url: 'https://kitchen-notes.example/overnight-focaccia', title: 'Overnight focaccia that forgives everything', domain: 'kitchen-notes.example', source: 'browser', status: 'inbox',
    hoursAgo: 26, categories: ['food-drink'], picture: 'focaccia', description: 'A wet dough, a cold fridge and twelve hours of doing nothing.'},
  {id: 'cabin', url: 'https://cabins.example/compare/forest', title: 'Cabin rentals to compare', domain: 'cabins.example', source: 'manual', status: 'inbox',
    hoursAgo: 50, categories: ['travel'], picture: 'cabin', description: 'Six cabins under the pines, side by side.'},
  // follow-up due today
  {id: 'boring', url: 'https://slowweb.example/boring-software', title: 'The case for boring software', domain: 'slowweb.example', source: 'browser', status: 'to-review',
    hoursAgo: 120, categories: ['technology'], picture: 'boring', followUpToday: true, description: 'Why the tools that last are the ones nobody writes launch posts about.'},
  // kept, on shelves
  {id: 'noodles', url: 'https://kitchen-notes.example/weeknight-noodles', title: 'Weeknight noodles in twenty minutes', domain: 'kitchen-notes.example', source: 'telegram', status: 'reference',
    hoursAgo: 200, categories: ['food-drink'], picture: 'noodles'},
  {id: 'chickpeas', url: 'https://panfried.example/crispy-chickpeas', title: 'Crispy chickpeas from the pan', domain: 'panfried.example', source: 'whatsapp', status: 'reference',
    hoursAgo: 260, categories: ['food-drink'], picture: 'chickpeas'},
  {id: 'soup', url: 'https://kitchen-notes.example/winter-soup', title: 'A winter soup for the whole week', domain: 'kitchen-notes.example', source: 'browser', status: 'reference',
    hoursAgo: 340, categories: ['food-drink'], picture: 'soup'},
  {id: 'salad', url: 'https://greenbowl.example/crunchy-salad', title: 'The crunchy salad that keeps', domain: 'greenbowl.example', source: 'telegram', status: 'reference',
    hoursAgo: 420, categories: ['food-drink'], picture: 'salad'},
  {id: 'islands', url: 'https://slowtravel.example/a-slow-week', title: 'A slow week on the islands', domain: 'slowtravel.example', source: 'browser', status: 'reference',
    hoursAgo: 230, categories: ['travel'], picture: 'azores', favorite: true},
  {id: 'ridge', url: 'https://trailhead.example/ridge-packing-list', title: 'Three days on the ridge: a packing list', domain: 'trailhead.example', source: 'telegram', status: 'reference',
    hoursAgo: 300, categories: ['travel'], picture: 'ridge'},
  {id: 'oldtown', url: 'https://citywalks.example/old-town-morning', title: 'Old town walk before breakfast', domain: 'citywalks.example', source: 'whatsapp', status: 'reference',
    hoursAgo: 380, categories: ['travel'], picture: 'lisbon'},
  {id: 'local-first', url: 'https://talks.example/local-first-apps', title: 'Talk: local-first apps', domain: 'talks.example', source: 'browser', status: 'reference',
    hoursAgo: 280, categories: ['technology'], picture: 'local-first', useOften: true},
  {id: 'sync', url: 'https://code.example/offline-sync', title: 'Repo: offline-first sync', domain: 'code.example', source: 'manual', status: 'reference',
    hoursAgo: 360, categories: ['technology'], picture: 'sync-repo', useOften: true},
  {id: 'type', url: 'https://typenotes.example/thread-on-type', title: 'A thread on type design', domain: 'typenotes.example', source: 'telegram', status: 'reference',
    hoursAgo: 240, categories: ['arts-culture'], picture: 'type'},
  {id: 'synth', url: 'https://patchbook.example/first-patch', title: 'Synth patch walkthrough', domain: 'patchbook.example', source: 'browser', status: 'reference',
    hoursAgo: 310, categories: ['arts-culture'], picture: 'synth'},
  {id: 'watch', url: 'https://watchworks.example/how-it-ticks', title: 'How mechanical watches keep time', domain: 'watchworks.example', source: 'whatsapp', status: 'reference',
    hoursAgo: 400, categories: ['arts-culture'], picture: 'watch'},
  {id: 'plant', url: 'https://greenroom.example/care-sheet', title: 'Houseplant care sheet', domain: 'greenroom.example', source: 'manual', status: 'reference',
    hoursAgo: 450, categories: ['other'], picture: 'plant'},
];

// Only in the screenshots, so the GIF's library stays as it is. Handles and post numbers are invented. Social posts
// have real sites' addresses because the app draws them from the address: no request goes to those sites. Most have
// no picture, so the app draws them in their site's colours.
const social = (id, url, platform, title, hoursAgo, categories, extra = {}) => ({id, url, title, platform, domain: new URL(url).hostname.replace(/^www\./, ''),
  source: 'browser', status: 'reference', hoursAgo, categories, ...extra});
const kit = {author: 'Bakehouse Kit'};
export const SHOT_LINKS = [
  social('toppings', 'https://www.instagram.com/reel/CtopFoc3a/', 'instagram', 'Three focaccia toppings in 30 seconds', 8, ['food-drink']),
  social('digest', 'https://t.me/slowdesignnotes/482', 'web', undefined, 30, ['arts-culture'], {source: 'telegram'}),
  social('boule', 'https://www.youtube.com/watch?v=sampleBoule', 'youtube', 'How to shape a boule, the slow version', 60, ['food-drink'], {author: 'Laminate Daily'}),
  social('slowweb', 'https://x.com/slowwebnotes/status/18512201', 'x', undefined, 75, ['technology']),
  social('riceclip', 'https://www.tiktok.com/@cook.with.lia/video/7300000000000000301', 'tiktok', 'Crispy rice salad in 60 seconds', 90, ['food-drink']),
  social('invite', 'https://chat.whatsapp.com/SampleInvite0001', 'web', undefined, 100, ['travel'], {source: 'whatsapp'}),
  social('firstloaf', 'https://www.reddit.com/r/TinyOvens/comments/abc123/my_first_overnight_focaccia/', 'reddit', 'My first overnight focaccia', 110, ['food-drink'], {author: 'u/ryetoast'}),
  social('pantry', 'https://www.pinterest.com/pin/1234567890123/', 'pinterest', 'Small-kitchen pantry ideas', 130, ['food-drink']),
  // one post saved at two addresses, for Clean up & undo; four posts by one creator
  social('batard', 'https://x.com/bakehouse_kit/status/18512101', 'x', 'Shaping a batard in 30 seconds', 140, ['food-drink'], {...kit, tags: ['bread'], picture: 'batard'}),
  social('batard-again', 'https://twitter.com/bakehouse_kit/status/18512101?s=20', 'x', 'Bakehouse Kit on X', 165, ['food-drink'], kit),
  social('seeded-rye', 'https://x.com/bakehouse_kit/status/18512102', 'x', 'Seeded rye, step by step', 190, ['food-drink'], {...kit, tags: ['rye'], picture: 'seeded-rye'}),
  social('rye-ratios', 'https://x.com/bakehouse_kit/status/18512103', 'x', 'Rye ratios, explained', 215, ['food-drink'], {...kit, tags: ['rye']}),
  social('kit-gram', 'https://www.instagram.com/p/CkitBake1/', 'instagram', 'bakehouse.kit on Instagram', 150, ['food-drink'], {tags: ['bread']}),
  social('crumb', 'https://x.com/crumblab/status/18512104', 'x', 'Why your crumb is gummy', 170, ['food-drink'], {author: 'Crumb Lab'}),
  social('walks', 'https://www.tiktok.com/@trailmix.tv/video/7300000000000000302', 'tiktok', 'Ten walks near the city', 250, ['travel']),
  social('packing', 'https://x.com/anafield/status/18512105', 'x', 'Packing light for the ridge', 270, ['travel'], {author: 'Ana Field'}),
  // the search: #bread or #rye, and one link the search leaves out
  {id: 'fast-focaccia', url: 'https://kitchen-notes.example/fast-focaccia', title: 'Focaccia, the fast version', domain: 'kitchen-notes.example', source: 'browser', status: 'reference',
    hoursAgo: 290, categories: ['food-drink'], picture: 'focaccia', tags: ['bread']},
  {id: 'rye-crackers', url: 'https://kitchen-notes.example/rye-crackers', title: 'Seeded rye crackers', domain: 'kitchen-notes.example', source: 'browser', status: 'reference',
    hoursAgo: 320, categories: ['food-drink'], picture: 'crackers', tags: ['rye'], userNotes: 'Try with caraway next time.'},
  {id: 'sourdough', url: 'https://kitchen-notes.example/sourdough-explained', title: 'Sourdough, explained slowly', domain: 'kitchen-notes.example', source: 'browser', status: 'reference',
    hoursAgo: 330, categories: ['food-drink'], picture: 'batard', tags: ['bread']},
];

// A post that arrives after the owner last looked at its creator.
export const NEW_POST = social('new-loaf', 'https://x.com/bakehouse_kit/status/18512106', 'x', 'A new loaf for the weekend', 0, ['food-drink'], {...kit, tags: ['bread']});

// A shelf big enough to be offered "By website": 110 links here and the four technology links above. A site's row shows
// its newest six; the rest of the titles are never on screen. The sites are named as text on purpose: the screenshot's
// captions name them, and these addresses are made up too.
const BIG_SHELF = {
  'github.com': {count: 46, url: i => `https://github.com/sample-tools/tool-${i}`, pictures: ['sync-repo', 'local-first', 'boring', 'type', 'synth', 'watch'], titles: [
    'sample-tools/tool-1: sync that works on a train', 'sample-tools/tool-2: one small CLI for backups', 'sample-tools/tool-3: a calm static site builder',
    'sample-tools/tool-4: read-it-later in one file', 'sample-tools/tool-5: plain-text time tracking', 'sample-tools/tool-6: a tiny feed reader']},
  'medium.com': {count: 33, url: i => `https://medium.com/@sample.writer/note-${i}`, pictures: ['ridge', 'plant', 'lisbon', 'azores', 'cabin', 'ferry'], titles: [
    'Notes on building calm software', 'Why small teams ship less and last longer', 'What a year of plain text taught me',
    'The quiet joy of finished projects', 'Writing software you can leave alone', 'A short history of the bookmark']},
  'youtube.com': {count: 31, url: i => `https://www.youtube.com/watch?v=sample${String(i).padStart(5, '0')}`, titles: [
    'Talk: the case for fewer features', 'Talk: local data, long life', 'Talk: when not to add a server',
    'Talk: boring tools win', 'Talk: designing for one person', 'Talk: the web that lasts']},
};
export const WEBSITE_LINKS = Object.entries(BIG_SHELF).flatMap(([domain, site]) => Array.from({length: site.count}, (_, i) => ({
  id: `site-${domain}-${i}`, url: site.url(i + 1), title: site.titles[i] ?? `${site.titles[i % 6]}, part ${i}`, domain, source: 'browser', status: 'reference', hoursAgo: 500 + i, categories: ['technology'],
  ...(domain === 'github.com' ? {platform: 'github'} : domain === 'youtube.com' ? {platform: 'youtube'} : {}), ...(site.pictures?.[i] ? {picture: site.pictures[i]} : {}),
})));

// The recipe page the app saves a copy of for the saved-copy shot. Plain HTML: the app's own queue fetches it from a
// stand-in for the site and keeps it.
export const COPY = {
  link: 'focaccia', host: 'kitchen-notes.example', path: '/overnight-focaccia', picture: 'focaccia', picturePath: '/overnight-focaccia/focaccia.jpg',
  html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Overnight focaccia that forgives everything</title>
<meta name="description" content="A wet dough, a cold fridge and twelve hours of doing nothing.">
<style>body{margin:0;background:#fdf7ee;color:#2a2622;font:19px/1.65 Georgia,serif}
header{border-bottom:1px solid #eadfcd;padding:22px 36px;display:flex;justify-content:space-between;align-items:center;font:500 15px/1 system-ui,sans-serif;color:#6b645a}
header b{font:700 22px/1 Georgia,serif;color:#7a4a1c}nav{display:flex;gap:24px}
main{max-width:700px;margin:0 auto;padding:36px 24px}.kicker{font:700 13px/1 system-ui,sans-serif;letter-spacing:.14em;color:#b1702c;text-transform:uppercase}
h1{font-size:44px;line-height:1.1;margin:14px 0 12px}.by{font:500 15px/1 system-ui,sans-serif;color:#7a7268;margin-bottom:24px}
img{width:100%;border-radius:12px;display:block}figure{margin:0}figcaption{font:400 14px/1.4 system-ui,sans-serif;color:#7a7268;margin:8px 0 22px}</style></head>
<body><header><b>Kitchen Notes</b><nav><span>Recipes</span><span>Bread</span><span>Techniques</span><span>Newsletter</span></nav></header>
<main><div class="kicker">Bread · Weekend baking</div><h1>Overnight focaccia that forgives everything</h1><div class="by">By Nora Hale · 6 min read</div>
<figure><img src="/overnight-focaccia/focaccia.jpg" alt="A tray of focaccia, dimpled and oiled"><figcaption>Dimpled, oiled and salted, straight from a cold fridge.</figcaption></figure>
<p>A wet dough, a cold fridge and twelve hours of doing nothing. This is the bread for people who forget about bread.</p>
<p>Stir everything together the night before, oil the tray in the morning, and let the dough come back to room temperature before it meets the oven.</p>
<p>Press your fingers right down to the tray: the dimples are where the oil and the salt collect.</p></main></body></html>`,
};

// What the extension reads on an X search: a page of our own, with only the attributes its reader looks for, at X's
// address because the reader checks the address. It is never on screen: the shot is of the app's Save window.
export const FEED = {
  url: 'https://x.com/search?q=sourdough&src=typed_query', title: 'sourdough - Search',
  // already saved, under the other spelling of the address
  saved: social('bread-lab', 'https://twitter.com/BreadLabNotes/status/1851200000000000302', 'x', 'Bread Lab Notes on X', 400, ['food-drink'], {author: 'Bread Lab Notes'}),
  ticked: ['Mara Quinn', 'Tomás Ferreira'], tags: 'sourdough',
  posts: [
    {id: '1851200000000000301', name: 'Mara Quinn', handle: 'maraquinn', hoursAgo: 26, text: 'Day 3 of the rye starter: finally bubbly.', pictures: ['MaraOne', 'MaraTwo']},
    {id: '1851200000000000302', name: 'Bread Lab Notes', handle: 'breadlabnotes', hoursAgo: 50, text: 'Why your sourdough is flat: a short guide to proofing times at room temperature'},
    {id: '1851200000000000303', name: 'Tomás Ferreira', handle: 'tferreira', hoursAgo: 52, text: 'Overnight loaf, 78% hydration, baked in a cast-iron pot. Sound on for the crust.', video: true},
    {id: '1851200000000000304', name: 'Juniper Wells', handle: 'juniperbakes', hoursAgo: 75, text: 'Rye crackers from leftover starter. Recipe card attached.', pictures: ['JuniperCard']},
  ],
};
export const feedPage = now => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${FEED.title}</title></head><body><main role="main">${FEED.posts.map(post => `
<article data-testid="tweet" role="article"><div data-testid="User-Name"><a href="/${post.handle}"><span>${post.name}</span></a><br><a href="/${post.handle}"><span>@${post.handle}</span></a></div>
<a href="/${post.handle}/status/${post.id}"><time datetime="${new Date(now - post.hoursAgo * 3600e3).toISOString()}">${post.hoursAgo}h</time></a>
<div data-testid="tweetText" lang="en"><span>${post.text}</span></div>
${(post.pictures ?? []).map(name => `<div data-testid="tweetPhoto"><img alt="" src="https://pbs.twimg.com/media/${name}?format=jpg&amp;name=small"></div>`).join('')}${post.video ? '<div data-testid="videoPlayer"></div>' : ''}</article>`).join('')}
</main></body></html>`;
