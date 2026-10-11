const canvas = document.querySelector('#anemone');
const ctx = canvas.getContext('2d');
const waveButton = document.querySelector('#reef-wave');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
let width = 0, height = 0, frame, previous = 0, visible = true, rippleUntil = 0;
let pointer;
const strands = Array.from({ length: 110 }, (_, i) => {
  const seed = Math.sin(i * 78.233 + 13) * 43758.5453;
  const random = seed - Math.floor(seed);
  const angle = (i / 109) * Math.PI;
  return { x: .02 + i / 109 * .8, y: .83 - Math.sin(angle) * (.3 + random * .18), random, offset: 0, velocity: 0, front: i % 3 === 0 };
});
const moving = () => document.body.dataset.motion === 'on' && !reduced.matches;

function fish(x, y, size, time, facing = 1, kind = 'clown') {
  ctx.save(); ctx.translate(x, y); ctx.scale(size * facing, size);
  ctx.rotate(Math.sin(time * .7) * .025);
  const orange = ctx.createLinearGradient(0, -1, 0, 1);
  const colors = kind === 'blue' ? ['#94f4ff', '#269bdd', '#2047b5', '#132258'] : kind === 'yellow' ? ['#fffbb3', '#ffe941', '#e4a619', '#b97911'] : ['#ffe591', '#ffb82f', '#ff6814', '#ba3816'];
  colors.forEach((color, i) => orange.addColorStop([0, .32, .7, 1][i], color));
  ctx.fillStyle = orange; ctx.strokeStyle = '#502437'; ctx.lineWidth = .045;
  ctx.beginPath(); ctx.moveTo(-.9, 0); ctx.lineTo(-1.55, -.6); ctx.quadraticCurveTo(-1.75, 0, -1.55, .6); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = orange;
  ctx.beginPath(); ctx.ellipse(0, 0, 1.12, .63, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.save(); ctx.clip();
  for (const sx of kind === 'clown' ? [-.8, -.1, .57] : []) {
    ctx.strokeStyle = '#7a3324'; ctx.lineWidth = .28; ctx.beginPath(); ctx.moveTo(sx, -.8); ctx.quadraticCurveTo(sx - .22, 0, sx + .05, .8); ctx.stroke();
    ctx.strokeStyle = '#fffbe5'; ctx.lineWidth = .19; ctx.stroke();
  }
  ctx.fillStyle = '#ffffff40'; ctx.beginPath(); ctx.ellipse(-.08, -.32, .65, .12, -.08, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  ctx.fillStyle = kind === 'blue' ? '#ffe150' : kind === 'yellow' ? '#ffe879' : '#f98022'; ctx.beginPath(); ctx.moveTo(-.18, .03); ctx.quadraticCurveTo(-.7, .65, -.53, .76); ctx.quadraticCurveTo(.03, .55, .08, .15); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.ellipse(.72, -.19, .23, .27, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#351f36'; ctx.beginPath(); ctx.ellipse(.79, -.16, .12, .17, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(.83, -.22, .045, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#7d2c26'; ctx.lineWidth = .025; ctx.beginPath(); ctx.arc(.98, .1, .1, .2, 1.8); ctx.stroke();
  ctx.restore();
}

function strand(s, time, dt, animate, scale, baseY) {
  const tipX = s.x * width;
  const tipY = baseY - (.83 - s.y) * scale;
  let force = 0;
  if (animate && pointer) {
    const dx = tipX + s.offset - pointer.x, dy = tipY - pointer.y;
    const distance = Math.hypot(dx, dy);
    if (distance < scale * .2) force = (dx >= 0 ? 1 : -1) * (1 - distance / (scale * .2)) * scale * .14;
  }
  if (animate && performance.now() < rippleUntil) force += Math.sin(time * 5 + s.x * 12) * scale * .065;
  if (animate) {
    s.velocity += ((force - s.offset) * .06 - s.velocity * .2) * dt;
    s.offset += s.velocity * dt;
  } else { s.offset = 0; s.velocity = 0; }
  const sway = animate ? Math.sin(time * .75 + s.random * 6) * scale * .009 : 0;
  const endX = tipX + s.offset + sway;
  const rootX = width * .39 + (s.x - .39) * width * .35;
  const gradient = ctx.createLinearGradient(rootX, baseY, endX, tipY);
  gradient.addColorStop(0, '#832953'); gradient.addColorStop(.38, s.front ? '#ca6f9e' : '#9275b9'); gradient.addColorStop(.8, s.front ? '#ffd3b6' : '#dbbcf0'); gradient.addColorStop(1, '#fff0dd');
  ctx.strokeStyle = gradient; ctx.lineWidth = scale * (.008 + s.random * .008); ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(rootX, baseY);
  ctx.bezierCurveTo(rootX - 15, baseY - scale * .17, tipX + s.offset * .4 - 15, tipY + scale * .14, endX, tipY); ctx.stroke();
  ctx.save(); ctx.strokeStyle = '#fff4'; ctx.lineWidth *= .18; ctx.stroke(); ctx.restore();
  ctx.fillStyle = '#ffe2e0b0'; ctx.beginPath(); ctx.arc(endX - 1, tipY - 1, ctx.lineWidth * .24, 0, Math.PI * 2); ctx.fill();
}

function draw(timestamp = 0) {
  frame = undefined;
  const animate = moving() && visible && !document.hidden;
  const dt = Math.min(2, Math.max(.1, (timestamp - previous) / 16.67)); previous = timestamp;
  const time = animate ? timestamp / 1000 : 0;
  ctx.clearRect(0, 0, width, height);
  const mobile = width < 760;
  const scale = mobile ? 900 : height * 1.7;
  const baseY = mobile ? 495 : height * 1.06;
  ctx.save();
  // Sun shafts sit behind the living reef.
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = '#b1fffa0b'; ctx.beginPath(); ctx.moveTo(width * (.12 + i * .15), 0); ctx.lineTo(width * (.32 + i * .18), mobile ? 370 : height); ctx.lineTo(width * (.18 + i * .18), mobile ? 370 : height); ctx.closePath(); ctx.fill();
  }
  const rock = ctx.createRadialGradient(width * .36, baseY, 10, width * .36, baseY, width * .35);
  rock.addColorStop(0, '#727aa3'); rock.addColorStop(.6, '#29386b'); rock.addColorStop(1, '#0b2350');
  ctx.fillStyle = rock; ctx.beginPath(); ctx.ellipse(width * .36, baseY + scale * .07, width * .34, scale * .15, -.08, 0, Math.PI * 2); ctx.fill();
  fish(width * .16, mobile ? 65 : height * .15, mobile ? 18 : 27, time, 1, 'yellow');
  fish(width * .49, mobile ? 115 : height * .19, mobile ? 26 : 40, time, -1, 'blue');
  fish(width * .62, mobile ? 48 : height * .1, mobile ? 16 : 25, time, -1, 'yellow');
  strands.filter(s => !s.front).forEach(s => strand(s, time, dt, animate, scale, baseY));
  strands.filter(s => s.front).forEach(s => strand(s, time, dt, animate, scale, baseY));
  const fishY = baseY - scale * .36;
  const bob = animate ? Math.sin(time * .8) * scale * .008 : 0;
  fish(width * .27, fishY + bob, mobile ? 36 : scale * .056, time, 1);
  fish(width * .47, fishY + scale * .075 - bob, mobile ? 25 : scale * .038, time, -1);
  for (let i = 0; i < 14; i++) {
    const x = width * (.08 + (i * .077) % .65);
    const y = animate ? ((baseY - time * (9 + i * 2) + i * 39) % (baseY + 50) + baseY + 50) % (baseY + 50) : baseY - i * 30;
    ctx.strokeStyle = '#bcffff70'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y, 3 + i % 4 * 2, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#fff8'; ctx.beginPath(); ctx.arc(x - 2, y - 2, 1, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  if (animate) frame = requestAnimationFrame(draw);
}
function start() { if (!frame) frame = requestAnimationFrame(draw); }
new ResizeObserver(() => {
  width = canvas.clientWidth; height = canvas.clientHeight;
  const ratio = Math.min(devicePixelRatio || 1, 2);
  canvas.width = width * ratio; canvas.height = height * ratio;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0); start();
}).observe(canvas);
new MutationObserver(() => { waveButton.disabled = !moving(); start(); }).observe(document.body, { attributes: true, attributeFilter: ['data-motion'] });
new IntersectionObserver(entries => { visible = entries[0].isIntersecting; if (visible) start(); else if (frame) { cancelAnimationFrame(frame); frame = undefined; } }).observe(canvas);
document.addEventListener('visibilitychange', start);
reduced.addEventListener('change', start);
canvas.addEventListener('pointermove', event => { const rect = canvas.getBoundingClientRect(); pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top }; start(); });
canvas.addEventListener('pointerleave', () => { pointer = undefined; });
canvas.addEventListener('pointerup', event => { if (event.pointerType !== 'mouse') pointer = undefined; });
waveButton.addEventListener('click', () => { rippleUntil = performance.now() + 2200; start(); });
waveButton.disabled = !moving();
