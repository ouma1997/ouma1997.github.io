// Plate I: a generative tissue section (spatial cell segmentation with transcript
// spots) threaded with serpentine mesh electronics. An autonomous agent plans and
// runs a closed loop on it: profile cells, segment and annotate spatial domains,
// integrate electrode recordings with cell identity, stimulate, and polymerize
// coatings on genetically targeted cells with light. Every step is written to the
// agent log. The visitor can take over with the cursor and click to act.

const DELAUNAY_URL = "https://cdn.jsdelivr.net/npm/d3-delaunay@6.0.4/+esm";
const TAU = Math.PI * 2;
const TRACE_LENGTH = 120;
const SPIKE = [0.18, -1, -0.62, 0.32, 0.26, 0.12, 0.04];
const SPIKE_SLOW = [0.1, -0.45, -0.75, -0.62, -0.3, 0.12, 0.24, 0.18, 0.08];
const GENES = 10;
const CYCLE = ["profile", "annotate", "record", "stimulate", "baseline", "illuminate", "postrecord"];
const KIND = ["unlabeled", "cluster A", "marker+", "target+"];
const PROFILES = [
  [0.25, 0.2, 0.3, 0.15, 0.35, 0.3, 0.2, 0.25, 0.3, 0.2],
  [0.9, 0.75, 0.85, 0.6, 0.2, 0.15, 0.1, 0.2, 0.35, 0.25],
  [0.3, 0.25, 0.2, 0.2, 0.85, 0.7, 0.2, 0.15, 0.3, 0.25],
  [0.2, 0.15, 0.25, 0.2, 0.25, 0.2, 0.9, 0.8, 0.3, 0.6],
];
const LIGHT_MS = 5000;
const STIM_MS = 1400;
const ANNOTATE_MS = 2600;
const ANNOTATION_LIFE = 90000;
const COMPARE_MS = 12000;
const SAMPLE_MS = 33.3;
const TYPE_MS = 30;
// The scene runs on its own clock at two thirds of real time; cursor control stays real-time
const TEMPO = 2 / 3;

const canvas = document.getElementById("tissue");

if (canvas) {
  import(DELAUNAY_URL)
    .then(({ Delaunay }) => new Plate(canvas, Delaunay))
    .catch(() => {
      // Without the library the plate stays an empty specimen frame.
    });
}

class Plate {
  constructor(canvas, Delaunay) {
    this.canvas = canvas;
    this.frame = canvas.parentElement;
    this.ctx = canvas.getContext("2d");
    this.Delaunay = Delaunay;
    this.reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const css = getComputedStyle(document.documentElement);
    const read = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    this.color = {
      ink: read("--ink", "#121418"),
      ink3: read("--ink-3", "#646a73"),
      plate: read("--plate", "#f8f9f9"),
      accent: read("--accent", "#c2352b"),
      cell: read("--plate-cell", "#1f7a86"),
      light: read("--plate-light", "#4b5fe0"),
      polymer: read("--plate-polymer", "#222c63"),
    };
    this.font = `500 10px "IBM Plex Mono", ui-monospace, monospace`;

    this.mode = "agent";
    this.lastPointer = -Infinity;
    this.cycle = 0;
    this.nextDomain = 0;
    this.log = [];
    this.stepNo = 0;
    this.trace = new Float32Array(TRACE_LENGTH);
    this.traceFlag = new Uint8Array(TRACE_LENGTH);
    this.queue = [];
    this.bars = new Float32Array(GENES);
    this.sampleClock = 0;
    this.hi = 0;
    this.channel = 0;
    this.activation = 0;
    this.visible = true;
    this.running = false;
    this.clock = 0;
    this.last = 0;

    this.build();
    this.prefillTrace();
    this.bindEvents();
    this.note("LOAD", `${this.interiorCells.length} cells · ${this.electrodes.length} ch`, -Infinity);
    this.sense();
    this.bars.set(this.profileOf(this.hi));

    if (this.reduce) {
      this.stage();
      this.render(0);
      document.fonts?.ready.then(() => this.render(0));
    } else {
      this.render(this.clock);
      this.play();
    }
  }

  bindEvents() {
    const toLocal = (event) => {
      const rect = this.canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    this.canvas.addEventListener("pointermove", (event) => {
      this.takeOver(toLocal(event), this.clock);
      if (this.reduce) this.jumpTo(this.target);
    });

    this.canvas.addEventListener("pointerdown", (event) => {
      const p = toLocal(event);
      this.takeOver(p, this.clock);
      this.act(p, this.clock);
      if (this.reduce) this.jumpTo(p);
    });

    this.canvas.addEventListener("pointerleave", () => {
      this.lastPointer = performance.now() - 1800;
    });

    new ResizeObserver(() => {
      if (!this.build()) return;
      this.sense();
      if (this.reduce) this.stage();
      this.render(this.reduce ? 0 : this.clock);
    }).observe(this.frame);

    new IntersectionObserver(([entry]) => {
      this.visible = entry.isIntersecting;
      if (this.visible) this.play();
      else this.pause();
    }).observe(this.frame);

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.pause();
      else this.play();
    });
  }

  play() {
    if (this.reduce || this.running || !this.visible || document.hidden) return;
    this.running = true;
    this.last = this.clock;
    let lastFrame = performance.now();
    const tick = (frame) => {
      if (!this.running) return;
      const real = Math.max(0, Math.min(64, frame - lastFrame));
      lastFrame = frame;
      this.clock += real * TEMPO;
      this.step(this.clock, real);
      this.render(this.clock);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  pause() {
    this.running = false;
  }

  build() {
    const rect = this.frame.getBoundingClientRect();
    const W = Math.round(rect.width);
    const H = Math.round(rect.height);
    if (!W || !H || (W === this.W && H === this.H)) return false;

    this.W = W;
    this.H = H;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(W * dpr);
    this.canvas.height = Math.round(H * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const rand = mulberry32(1997);
    const s = Math.max(22, Math.min(34, Math.sqrt((W * H) / 560)));
    const m = s * 1.5;
    this.s = s;
    this.bounds = [-m, -m, W + m, H + m];

    // Jittered hexagonal seeding, relaxed into an epithelium-like packing
    let pts = [];
    for (let y = -m, row = 0; y <= H + m; y += s * 0.87, row++) {
      for (let x = -m + (row % 2) * s * 0.5; x <= W + m; x += s) {
        pts.push([x + (rand() - 0.5) * s * 0.95, y + (rand() - 0.5) * s * 0.95]);
      }
    }
    for (let k = 0; k < 2; k++) {
      const voronoi = this.Delaunay.from(pts).voronoi(this.bounds);
      pts = pts.map((p, i) => centroid(voronoi.cellPolygon(i)) || p);
    }

    const n = pts.length;
    this.n = n;
    this.base = Float64Array.from(pts.flat());
    this.points = Float64Array.from(this.base);
    this.phase = Float32Array.from({ length: n * 2 }, () => rand() * TAU);
    this.kind = new Uint8Array(n);
    this.radius = new Float32Array(n);
    this.expr = new Float32Array(n * GENES);
    this.coat = new Float32Array(n);
    this.flashAt = new Float64Array(n).fill(-Infinity);

    // Two spatial domains: a transcriptional cluster (A) and a region where a
    // subset of cells is genetically targeted (B)
    const short = Math.min(W, H);
    this.domains = [
      { name: "A", x: 0.68 * W, y: 0.36 * H, r: 0.2 * short, cells: [] },
      { name: "B", x: 0.27 * W, y: 0.74 * H, r: 0.17 * short, cells: [] },
    ];
    const near = (d, x, y) => Math.exp(-((x - d.x) ** 2 + (y - d.y) ** 2) / (d.r * d.r));
    const dots = [];
    for (let i = 0; i < n; i++) {
      const [x, y] = pts[i];
      const a = near(this.domains[0], x, y) + (rand() - 0.5) * 0.3;
      const b = near(this.domains[1], x, y) + (rand() - 0.5) * 0.3;
      let kind = 0;
      if (a > 0.5) {
        kind = 1;
        this.domains[0].cells.push(i);
      } else if (b > 0.38) {
        kind = rand() < 0.62 ? 3 : 0;
        this.domains[1].cells.push(i);
      } else if (rand() < 0.05) {
        kind = 2;
      } else if (rand() < 0.025) {
        kind = 3;
      }
      this.kind[i] = kind;
      this.radius[i] = s * (0.07 + rand() * 0.035);

      const profile = PROFILES[kind];
      for (let g = 0; g < GENES; g++) {
        this.expr[i * GENES + g] = Math.min(1, Math.max(0.04, profile[g] + (rand() - 0.5) * 0.3));
      }

      const counts = [rand() < 0.35 ? 1 : 0, 3 + Math.floor(rand() * 3), 2 + Math.floor(rand() * 2), 1 + Math.floor(rand() * 2)];
      for (let j = 0; j < counts[kind]; j++) {
        const angle = rand() * TAU;
        const r = s * (0.14 + rand() * 0.2);
        dots.push(i, Math.cos(angle) * r, Math.sin(angle) * r);
      }
    }
    this.dots = Float32Array.from(dots);

    this.interiorCells = [];
    this.tagged = [];
    for (let i = 0; i < n; i++) {
      if (inside(pts[i], W, H, 0.08)) this.interiorCells.push(i);
      if (this.kind[i] === 3) this.tagged.push(i);
    }
    const interior = new Set(this.interiorCells);
    this.pools = {
      a: this.domains[0].cells.filter((i) => interior.has(i)),
      b: this.domains[1].cells.filter((i) => interior.has(i)),
      tagged: this.tagged.filter((i) => interior.has(i)),
    };
    this.domains.forEach((d) => {
      d.hull = this.hullOf(d.cells, s * 0.6);
    });

    this.delaunay = new this.Delaunay(this.points);
    this.voronoi = this.delaunay.voronoi(this.bounds);

    // Stretchable mesh electronics: two longitudinal and two transverse
    // serpentine ribbons, straightened where they join.
    const amp = s * 0.26;
    const wave = s * 1.7;
    this.ribbons = [
      [-0.04, 0.24, 1.04, 0.31],
      [-0.04, 0.63, 1.04, 0.55],
      [0.21, -0.04, 0.27, 1.04],
      [0.77, -0.04, 0.71, 1.04],
    ].map(([ax, ay, bx, by]) => baseline(ax * W, ay * H, bx * W, by * H));

    this.nodes = [];
    for (const a of this.ribbons.slice(0, 2)) {
      for (const b of this.ribbons.slice(2)) {
        const hit = intersect(a, b);
        if (!hit) continue;
        a.joints.push(hit.t);
        b.joints.push(hit.u);
        this.nodes.push(hit);
      }
    }
    this.ribbons.forEach((ribbon) => {
      ribbon.path = serpentinePath(ribbon, amp, wave);
    });

    const stops = [
      [0.1, 0.42, 0.58, 0.9],
      [0.1, 0.42, 0.58, 0.9],
      [0.12, 0.44, 0.8],
      [0.12, 0.44, 0.8],
    ];
    this.electrodes = [];
    this.ribbons.forEach((ribbon, r) => {
      stops[r].forEach((u) => {
        const d = Math.round((u * ribbon.len) / (wave / 2)) * (wave / 2);
        this.electrodes.push({ x: ribbon.x0 + ribbon.ux * d, y: ribbon.y0 + ribbon.uy * d });
      });
    });
    this.reachable = [];
    this.electrodes.forEach((e, i) => {
      if (inside([e.x, e.y], W, H, 0.07)) this.reachable.push(i);
    });
    this.electrode = this.reachable[0] ?? 0;

    // Targeted cells around each electrode, for the perturbation experiment
    const reach = s * 2.4;
    this.nearTagged = this.electrodes.map((e) =>
      this.tagged.filter((i) => Math.hypot(this.base[2 * i] - e.x, this.base[2 * i + 1] - e.y) < reach)
    );
    this.optoElectrode = this.electrode;

    // Start the probe on the domain-A cell nearest the domain's center
    const pool = this.pools.a.length ? this.pools.a : this.interiorCells;
    let start = pool[0] ?? 0;
    let best = Infinity;
    for (const i of pool) {
      const d = (pts[i][0] - this.domains[0].x) ** 2 + (pts[i][1] - this.domains[0].y) ** 2;
      if (d < best) {
        best = d;
        start = i;
      }
    }
    this.probe = this.at(start);
    this.target = { ...this.probe };
    this.hi = start;

    this.task = null;
    this.light = null;
    this.stims = [];
    this.pulses = [];
    this.annotations = [];
    this.compare = null;
    this.before = null;
    this.later = [];
    this.trail = [];
    this.lastTrail = 0;
    return true;
  }

  // Convex outline around a domain, padded and rounded, sampled as a polyline
  hullOf(cells, pad) {
    if (cells.length < 3) return null;
    const sub = cells.map((i) => [this.base[2 * i], this.base[2 * i + 1]]);
    const ring = this.Delaunay.from(sub).hullPolygon().slice(0, -1);
    if (ring.length < 3) return null;
    const cx = ring.reduce((sum, p) => sum + p[0], 0) / ring.length;
    const cy = ring.reduce((sum, p) => sum + p[1], 0) / ring.length;
    const grown = ring.map(([x, y]) => {
      const d = Math.hypot(x - cx, y - cy) || 1;
      return [x + ((x - cx) / d) * pad, y + ((y - cy) / d) * pad];
    });

    const pts = [];
    const k = grown.length;
    for (let j = 0; j < k; j++) {
      const p = grown[(j + k - 1) % k];
      const a = grown[j];
      const b = grown[(j + 1) % k];
      const p0 = [(p[0] + a[0]) / 2, (p[1] + a[1]) / 2];
      const p2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      for (let step = 0; step < 6; step++) {
        const t = step / 6;
        const u = 1 - t;
        pts.push([
          u * u * p0[0] + 2 * u * t * a[0] + t * t * p2[0],
          u * u * p0[1] + 2 * u * t * a[1] + t * t * p2[1],
        ]);
      }
    }
    pts.push(pts[0]);

    const lengths = [0];
    for (let j = 1; j < pts.length; j++) {
      lengths.push(lengths[j - 1] + Math.hypot(pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]));
    }
    const top = pts.reduce((highest, p) => (p[1] < highest[1] ? p : highest), pts[0]);
    return { pts, lengths, total: lengths[lengths.length - 1], top };
  }

  prefillTrace() {
    for (let j = 0; j < TRACE_LENGTH; j++) this.trace[j] = (Math.random() - 0.5) * 0.12;
    for (const at of [34, 88]) SPIKE.forEach((v, k) => (this.trace[at + k] += v * 0.7));
  }

  // A still frame that shows the whole loop, for reduced motion
  stage() {
    this.annotations = this.domains.filter((d) => d.hull).map((d) => ({ d, t: 0, still: true }));
    const e = (this.optoElectrode = this.pickOptoElectrode());
    const before = this.record(e, 11);
    this.illuminate(this.electrodes[e].x, this.electrodes[e].y, 0);
    const after = this.record(e, 23);
    this.compare = { e, before, after, until: Infinity };
    this.log = this.log.slice(0, 1);
    this.note("PLAN", "map → annotate → perturb", 0);
    this.note("ANNOTATE", `domain A · ${this.domains[0].cells.length} cells`, 0);
    this.note("RECORD", `ch ${chId(e)} · baseline`, 0);
    this.note("ILLUMINATE", "light · target+ cells", 0);
    this.note("POLYMERIZE", cellCount(this.light.coated.size, "coated"), 0);
    this.note("COMPARE", `spikes ${before.count} → ${after.count}`, 0);
  }

  // Electrode whose surrounding targeted cells are least coated
  pickOptoElectrode() {
    let best = this.optoElectrode;
    let most = -1;
    for (const e of this.reachable) {
      const fresh = this.nearTagged[e].filter((i) => this.coat[i] < 0.3).length;
      if (fresh > most) {
        most = fresh;
        best = e;
      }
    }
    return best;
  }

  // Coating the targeted cells around an electrode lowers their excitability
  excitability(e) {
    const cells = this.nearTagged[e];
    if (!cells.length) return 1;
    let sum = 0;
    for (const i of cells) sum += this.coat[i];
    return 1 - 0.65 * (sum / cells.length);
  }

  // A representative recording window from electrode e at its current excitability
  record(e, seed) {
    const ex = this.excitability(e);
    const rand = mulberry32(seed);
    const trace = new Float32Array(TRACE_LENGTH);
    for (let j = 0; j < TRACE_LENGTH; j++) trace[j] = (rand() - 0.5) * 0.12;
    const count = Math.max(1, Math.round(5 * ex));
    const shape = ex < 0.8 ? SPIKE_SLOW : SPIKE;
    const amp = 0.95 - 0.35 * (1 - ex);
    for (let c = 0; c < count; c++) {
      const at = Math.floor(((c + 0.5) / count) * (TRACE_LENGTH - shape.length) + (rand() - 0.5) * 8);
      const start = Math.max(0, Math.min(TRACE_LENGTH - shape.length, at));
      shape.forEach((v, k) => (trace[start + k] += v * amp));
    }
    return { trace, count };
  }

  note(verb, detail, now) {
    this.stepNo++;
    this.log.push({ n: this.stepNo, verb, detail, t: this.reduce ? -Infinity : now });
    if (this.log.length > 12) this.log.shift();
  }

  at(i) {
    return { x: this.base[2 * i], y: this.base[2 * i + 1] };
  }

  profileOf(i) {
    return this.expr.subarray(i * GENES, (i + 1) * GENES);
  }

  pick(pool) {
    if (!pool.length) return this.hi;
    const reach = Math.min(this.W, this.H) * 0.45;
    let choice = pool[Math.floor(Math.random() * pool.length)];
    for (let tries = 0; tries < 8; tries++) {
      const i = pool[Math.floor(Math.random() * pool.length)];
      const d = Math.hypot(this.base[2 * i] - this.probe.x, this.base[2 * i + 1] - this.probe.y);
      if (d > this.s * 1.5 && d < reach) {
        choice = i;
        break;
      }
    }
    return choice;
  }

  // Locate the probe: the cell under it and the nearest electrode
  sense() {
    this.hi = this.delaunay.find(this.probe.x, this.probe.y, this.hi);
    let best = Infinity;
    this.electrodes.forEach((e, i) => {
      const d = Math.hypot(e.x - this.probe.x, e.y - this.probe.y);
      if (d < best) {
        best = d;
        this.channel = i;
      }
    });
    this.activation = Math.max(0, 1 - best / (this.s * 4)) ** 1.5;
  }

  jumpTo(p) {
    this.probe = { ...p };
    this.sense();
    this.bars.set(this.profileOf(this.hi));
    this.render(0);
  }

  takeOver(p, now) {
    if (this.mode !== "user") {
      this.mode = "user";
      this.task = null;
      this.note("HANDOFF", "manual control", now);
    }
    this.target = p;
    this.lastPointer = performance.now();
  }

  // Visitor click: stimulate near an electrode, otherwise shine light
  act(p, now) {
    let best = Infinity;
    let e = 0;
    this.electrodes.forEach((el, i) => {
      const d = Math.hypot(el.x - p.x, el.y - p.y);
      if (d < best) {
        best = d;
        e = i;
      }
    });
    if (best < this.s * 1.4) {
      const count = this.stimulate(e, now);
      this.note("STIMULATE", `ch ${chId(e)} · manual`, now);
      this.later.push({ at: now + 1800, verb: "VERIFY", detail: () => `evoked · ${count} cells` });
    } else {
      this.illuminate(p.x, p.y, now);
      this.note("ILLUMINATE", "manual · light", now);
      const light = this.light;
      this.later.push({ at: now + LIGHT_MS, verb: "POLYMERIZE", detail: () => cellCount(light.coated.size, "coated") });
    }
    if (this.reduce) {
      this.later.forEach((l) => this.note(l.verb, l.detail(), now));
      this.later = [];
    }
  }

  nextTask(now) {
    const index = this.cycle % CYCLE.length;
    if (index === 0) this.note("PLAN", "map → annotate → perturb", now);
    this.cycle++;

    const type = CYCLE[index];
    const task = { type, phase: "travel" };
    if (type === "profile") {
      const roll = Math.random();
      const pool = roll < 0.45 ? this.pools.a : roll < 0.7 ? this.pools.b : this.interiorCells;
      task.target = this.at(this.pick(pool.length ? pool : this.interiorCells));
    } else if (type === "annotate") {
      task.domain = this.domains[this.nextDomain];
      this.nextDomain = (this.nextDomain + 1) % this.domains.length;
      task.target = { x: task.domain.x, y: task.domain.y };
    } else if (type === "record") {
      this.electrode = this.reachable[Math.floor(Math.random() * this.reachable.length)] ?? 0;
      task.target = { ...this.electrodes[this.electrode] };
    } else if (type === "stimulate") {
      task.target = { ...this.electrodes[this.electrode] };
    } else {
      if (type === "baseline") this.optoElectrode = this.pickOptoElectrode();
      task.target = { ...this.electrodes[this.optoElectrode] };
    }
    this.task = task;
    this.target = { ...task.target };
  }

  runTask(now) {
    if (!this.task) this.nextTask(now);
    const task = this.task;

    if (task.phase === "travel") {
      if (Math.hypot(task.target.x - this.probe.x, task.target.y - this.probe.y) > 1.2) return;
      task.phase = "work";
      this.sense();
      if (task.type === "profile") {
        this.note("PROFILE", `cell ${cellId(this.hi)} · ${KIND[this.kind[this.hi]]}`, now);
        task.until = now + 4000;
      } else if (task.type === "annotate") {
        this.note("SEGMENT", `domain ${task.domain.name}`, now);
        this.annotate(task.domain, now);
        task.until = now + ANNOTATE_MS + 2500;
      } else if (task.type === "record") {
        this.note("RECORD", `ch ${chId(this.electrode)}`, now);
        task.until = now + 4000;
      } else if (task.type === "stimulate") {
        task.count = this.stimulate(this.electrode, now);
        this.note("STIMULATE", `ch ${chId(this.electrode)} · biphasic`, now);
        task.until = now + 3500;
      } else if (task.type === "baseline") {
        this.note("RECORD", `ch ${chId(this.optoElectrode)} · baseline`, now);
        task.until = now + 3500;
      } else if (task.type === "illuminate") {
        this.illuminate(this.probe.x, this.probe.y, now);
        this.note("ILLUMINATE", "light · target+ cells", now);
        task.until = now + LIGHT_MS + 800;
      } else {
        this.note("RECORD", `ch ${chId(this.optoElectrode)} · post-coat`, now);
        task.until = now + 3500;
      }
      return;
    }

    if (now < task.until) return;
    if (task.type === "annotate") {
      this.note("ANNOTATE", `domain ${task.domain.name} · ${task.domain.cells.length} cells`, now);
    } else if (task.type === "record") {
      this.note("INTEGRATE", `ch ${chId(this.electrode)} ↔ cell ${cellId(this.hi)}`, now);
    } else if (task.type === "stimulate") {
      this.note("VERIFY", `evoked · ${task.count} cells`, now);
    } else if (task.type === "baseline") {
      this.before = this.record(this.optoElectrode, 11);
    } else if (task.type === "illuminate") {
      this.note("POLYMERIZE", cellCount(this.light.coated.size, "coated"), now);
    } else if (task.type === "postrecord") {
      const after = this.record(this.optoElectrode, 23);
      const before = this.before ?? after;
      this.compare = { e: this.optoElectrode, before, after, until: now + COMPARE_MS };
      this.note("COMPARE", `spikes ${before.count} → ${after.count}`, now);
    }
    this.task = null;
  }

  annotate(domain, now) {
    if (!domain.hull) return;
    this.annotations = this.annotations.filter((a) => a.d !== domain);
    this.annotations.push({ d: domain, t: now });
  }

  stimulate(e, now) {
    const el = this.electrodes[e];
    const reach = this.s * 3.2;
    let count = 0;
    for (let i = 0; i < this.n; i++) {
      const d = Math.hypot(this.points[2 * i] - el.x, this.points[2 * i + 1] - el.y);
      if (d < reach) {
        this.flashAt[i] = now + d * 4 + Math.random() * 200;
        count++;
      }
    }
    if (this.reduce) return count;
    this.stims.push({ e, t: now });
    // Stimulation artifact, then a short evoked burst
    const q = [1, 1, -1, -1].map((v) => ({ v: v * 0.9, f: 1 }));
    for (const gap of [4, 8, 6]) {
      for (let k = 0; k < gap; k++) q.push({ v: 0, f: 0 });
      SPIKE.forEach((v) => q.push({ v: v * 0.85, f: 0 }));
    }
    this.queue = q;
    return count;
  }

  illuminate(x, y, now) {
    this.light = { x, y, r: this.s * 2.6, t: now, coated: new Set() };
    if (!this.reduce) return;
    this.light.still = true;
    for (const i of this.tagged) {
      if (Math.hypot(this.base[2 * i] - x, this.base[2 * i + 1] - y) < this.light.r) {
        this.coat[i] = 1;
        this.light.coated.add(i);
      }
    }
  }

  lightLevel(now) {
    const L = this.light;
    if (!L) return 0;
    if (L.still) return 1;
    const age = now - L.t;
    if (age < 0 || age > LIGHT_MS) return 0;
    if (age < 600) return age / 600;
    if (age > LIGHT_MS - 800) return (LIGHT_MS - age) / 800;
    return 1;
  }

  step(now, real) {
    const dt = now - this.last;
    this.last = now;

    // Breathing tissue
    const A = this.s * 0.06;
    const t = now * 0.00035;
    for (let i = 0; i < this.n; i++) {
      this.points[2 * i] = this.base[2 * i] + A * Math.sin(t + this.phase[2 * i]);
      this.points[2 * i + 1] = this.base[2 * i + 1] + A * Math.cos(t * 0.8 + this.phase[2 * i + 1]);
    }
    this.voronoi.update();

    // Control: the agent runs its loop unless the visitor holds the probe
    if (this.mode === "user" && performance.now() - this.lastPointer > 3500) {
      this.mode = "agent";
      this.task = null;
      this.note("RESUME", "autonomous loop", now);
    }
    if (this.mode === "agent") this.runTask(now);

    const ease = this.mode === "user" ? 1 - Math.pow(0.75, real / 16.67) : 1 - Math.pow(0.978, dt / 16.67);
    this.probe.x += (this.target.x - this.probe.x) * ease;
    this.probe.y += (this.target.y - this.probe.y) * ease;

    const tl = this.trail.length;
    if (
      now - this.lastTrail > 50 &&
      (tl < 2 || Math.hypot(this.trail[tl - 2] - this.probe.x, this.trail[tl - 1] - this.probe.y) > 3)
    ) {
      this.trail.push(this.probe.x, this.probe.y);
      if (this.trail.length > 160) this.trail.splice(0, 2);
      this.lastTrail = now;
    }

    this.sense();

    // Read out the profile of the cell under the probe
    const profile = this.profileOf(this.hi);
    const k = 1 - Math.pow(0.93, dt / 16.67);
    for (let g = 0; g < GENES; g++) this.bars[g] += (profile[g] - this.bars[g]) * k;

    // Light-guided polymerization coats only targeted cells in the beam
    const decay = dt / 40000;
    for (let i = 0; i < this.n; i++) if (this.coat[i] > 0) this.coat[i] = Math.max(0, this.coat[i] - decay);
    const L = this.light;
    if (L && !L.still) {
      const age = now - L.t;
      if (age > 600 && age < LIGHT_MS - 800) {
        for (const i of this.tagged) {
          const d = Math.hypot(this.points[2 * i] - L.x, this.points[2 * i + 1] - L.y);
          if (d < L.r) {
            this.coat[i] = Math.min(1, this.coat[i] + dt / 1800);
            if (this.coat[i] > 0.5) L.coated.add(i);
          }
        }
      }
    }

    this.later = this.later.filter((l) => {
      if (now < l.at) return true;
      this.note(l.verb, l.detail(), now);
      return false;
    });

    this.sampleClock = Math.min(this.sampleClock + dt, 200);
    while (this.sampleClock >= SAMPLE_MS) {
      this.sampleClock -= SAMPLE_MS;
      this.sample(now);
    }
    this.pulses = this.pulses.filter((p) => now - p.t < 1100);
    this.stims = this.stims.filter((p) => now - p.t < STIM_MS);
    this.annotations = this.annotations.filter((a) => a.still || now - a.t < ANNOTATION_LIFE);
  }

  sample(now) {
    const a = this.activation;
    const ex = this.excitability(this.channel);
    if (!this.queue.length && Math.random() < (0.004 + 0.05 * a) * ex) {
      const amp = (0.25 + 0.75 * a) * (1 - 0.35 * (1 - ex));
      this.queue = (ex < 0.8 ? SPIKE_SLOW : SPIKE).map((v) => ({ v: v * amp, f: 0 }));
      if (a > 0.5) {
        this.pulses.push({ e: this.channel, t: now });
        const el = this.electrodes[this.channel];
        this.flashAt[this.delaunay.find(el.x, el.y, this.hi)] = now;
      }
    }
    const q = this.queue.shift();
    this.trace.copyWithin(0, 1);
    this.traceFlag.copyWithin(0, 1);
    this.trace[TRACE_LENGTH - 1] = (Math.random() - 0.5) * 0.12 + (q ? q.v : 0);
    this.traceFlag[TRACE_LENGTH - 1] = q ? q.f : 0;
  }

  render(now) {
    const { ctx, W, H, s, n, points, kind, color } = this;
    const voronoi = this.voronoi;
    const visible = (x, y) => x > -s && x < W + s && y > -s && y < H + s;

    ctx.globalAlpha = 1;
    ctx.fillStyle = color.plate;
    ctx.fillRect(0, 0, W, H);

    const hi = this.hi;
    const near = new Set(voronoi.neighbors(hi));

    // Cells, grouped into batched paths
    const membranes = new Path2D();
    const clusterFill = new Path2D();
    const markerFill = new Path2D();
    const taggedFill = new Path2D();
    const nearFill = new Path2D();
    const nuclei = new Path2D();
    const clusterNuclei = new Path2D();
    const taggedNuclei = new Path2D();
    const flash = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
    const coat = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
    for (let i = 0; i < n; i++) {
      const x = points[2 * i];
      const y = points[2 * i + 1];
      if (!visible(x, y)) continue;
      const poly = voronoi.cellPolygon(i);
      if (!poly) continue;
      cellPath(membranes, poly, x, y);
      if (kind[i] === 1) cellPath(clusterFill, poly, x, y);
      else if (kind[i] === 2) cellPath(markerFill, poly, x, y);
      else if (kind[i] === 3) cellPath(taggedFill, poly, x, y);
      if (near.has(i)) cellPath(nearFill, poly, x, y);

      const age = now - this.flashAt[i];
      if (age >= 0 && age < 3500) {
        cellPath(flash[Math.min(3, Math.floor(Math.exp(-age / 1100) * 4))], poly, x, y);
      }
      if (this.coat[i] > 0.02) cellPath(coat[Math.min(3, Math.floor(this.coat[i] * 4))], poly, x, y);

      const r = this.radius[i];
      const nucleus = kind[i] === 1 ? clusterNuclei : kind[i] === 3 ? taggedNuclei : nuclei;
      nucleus.moveTo(x + r, y);
      nucleus.arc(x, y, r, 0, TAU);
    }

    ctx.fillStyle = color.cell;
    ctx.globalAlpha = 0.07;
    ctx.fill(markerFill);
    ctx.globalAlpha = 0.15;
    ctx.fill(clusterFill);
    ctx.fillStyle = color.light;
    ctx.globalAlpha = 0.045;
    ctx.fill(taggedFill);
    ctx.fillStyle = color.ink;
    ctx.globalAlpha = 0.045;
    ctx.fill(nearFill);

    ctx.fillStyle = color.polymer;
    coat.forEach((path, b) => {
      ctx.globalAlpha = 0.05 + b * 0.04;
      ctx.fill(path);
    });

    // Light beam
    const level = this.lightLevel(now);
    if (level > 0) {
      const L = this.light;
      const r = L.r * (L.still ? 1 : 0.6 + 0.4 * Math.min(1, (now - L.t) / 600));
      const glow = ctx.createRadialGradient(L.x, L.y, 0, L.x, L.y, r * 1.25);
      glow.addColorStop(0, rgba(color.light, 0.24 * level));
      glow.addColorStop(0.65, rgba(color.light, 0.1 * level));
      glow.addColorStop(1, rgba(color.light, 0));
      ctx.globalAlpha = 1;
      ctx.fillStyle = glow;
      ctx.fillRect(L.x - r * 1.3, L.y - r * 1.3, r * 2.6, r * 2.6);
      L.drawR = r;
    }

    ctx.fillStyle = color.accent;
    flash.forEach((path, b) => {
      ctx.globalAlpha = 0.08 + b * 0.09;
      ctx.fill(path);
    });

    ctx.strokeStyle = color.ink;
    ctx.lineWidth = 0.8;
    ctx.globalAlpha = 0.24;
    ctx.stroke(membranes);
    ctx.globalAlpha = 0.5;
    ctx.stroke(nearFill);

    ctx.strokeStyle = color.polymer;
    coat.forEach((path, b) => {
      ctx.globalAlpha = 0.45 + b * 0.15;
      ctx.lineWidth = 0.9 + b * 0.55;
      ctx.stroke(path);
    });

    const focus = new Path2D();
    cellPath(focus, voronoi.cellPolygon(hi), points[2 * hi], points[2 * hi + 1]);
    ctx.fillStyle = color.accent;
    ctx.globalAlpha = 0.2;
    ctx.fill(focus);
    ctx.strokeStyle = color.accent;
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.3;
    ctx.stroke(focus);

    ctx.fillStyle = color.ink;
    ctx.globalAlpha = 0.4;
    ctx.fill(nuclei);
    ctx.fillStyle = color.cell;
    ctx.globalAlpha = 0.8;
    ctx.fill(clusterNuclei);
    ctx.fillStyle = color.light;
    ctx.globalAlpha = 0.75;
    ctx.fill(taggedNuclei);

    // Transcript spots
    const spots = new Path2D();
    for (let j = 0; j < this.dots.length; j += 3) {
      const i = this.dots[j];
      const x = points[2 * i] + this.dots[j + 1];
      const y = points[2 * i + 1] + this.dots[j + 2];
      if (!visible(x, y)) continue;
      spots.moveTo(x + 1, y);
      spots.arc(x, y, 1, 0, TAU);
    }
    ctx.fillStyle = color.cell;
    ctx.globalAlpha = 0.9;
    ctx.fill(spots);

    // Mesh electronics
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = color.ink;
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 3.6;
    this.ribbons.forEach((ribbon) => ctx.stroke(ribbon.path));
    ctx.strokeStyle = color.plate;
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.9;
    this.ribbons.forEach((ribbon) => ctx.stroke(ribbon.path));

    ctx.fillStyle = color.ink;
    ctx.globalAlpha = 0.85;
    this.nodes.forEach((p) => ctx.fillRect(p.x - 3, p.y - 3, 6, 6));

    ctx.globalAlpha = 1;
    this.electrodes.forEach((e, i) => {
      const active = i === this.channel;
      ctx.beginPath();
      ctx.arc(e.x, e.y, 5, 0, TAU);
      ctx.fillStyle = color.plate;
      ctx.fill();
      ctx.strokeStyle = color.ink;
      ctx.lineWidth = 1.1;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(e.x, e.y, active ? 2.5 : 1.7, 0, TAU);
      ctx.fillStyle = active ? color.accent : color.ink;
      ctx.fill();
    });

    // Recording and stimulation events
    ctx.strokeStyle = color.accent;
    ctx.lineWidth = 1;
    for (const p of this.pulses) {
      const age = (now - p.t) / 1100;
      const e = this.electrodes[p.e];
      ctx.beginPath();
      ctx.arc(e.x, e.y, 6 + age * 18, 0, TAU);
      ctx.globalAlpha = (1 - age) * 0.6;
      ctx.stroke();
    }
    for (const st of this.stims) {
      const age = (now - st.t) / STIM_MS;
      const e = this.electrodes[st.e];
      const reach = s * 3.2;
      const field = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, reach * Math.max(0.05, age));
      field.addColorStop(0, rgba(color.accent, 0.16 * (1 - age)));
      field.addColorStop(1, rgba(color.accent, 0));
      ctx.globalAlpha = 1;
      ctx.fillStyle = field;
      ctx.beginPath();
      ctx.arc(e.x, e.y, reach * Math.max(0.05, age), 0, TAU);
      ctx.fill();
      ctx.lineWidth = 1.2;
      for (const lag of [0, 0.18]) {
        const a = age - lag;
        if (a < 0) continue;
        ctx.beginPath();
        ctx.arc(e.x, e.y, 6 + a * reach, 0, TAU);
        ctx.globalAlpha = (1 - a) * 0.85;
        ctx.stroke();
      }
    }

    if (level > 0) {
      const L = this.light;
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = color.light;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.7 * level;
      ctx.beginPath();
      ctx.arc(L.x, L.y, L.drawR, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Domain annotations drawn by the agent
    ctx.font = this.font;
    for (const a of this.annotations) {
      const hull = a.d.hull;
      const age = now - a.t;
      const progress = a.still ? 1 : Math.min(1, age / ANNOTATE_MS);
      const fade = a.still ? 1 : Math.min(1, (ANNOTATION_LIFE - age) / 3000);
      ctx.strokeStyle = color.cell;
      ctx.lineWidth = 1.2;
      ctx.globalAlpha = 0.9 * fade;
      ctx.setLineDash([5, 4]);
      drawPartial(ctx, hull, progress);
      ctx.setLineDash([]);
      if (progress > 0.35) {
        const label = `DOMAIN ${a.d.name}`;
        const lw = ctx.measureText(label).width + 10;
        const lx = Math.min(W - lw - 4, Math.max(4, hull.top[0] - lw / 2));
        const ly = Math.max(4, hull.top[1] - 9);
        ctx.globalAlpha = 0.94 * fade;
        ctx.fillStyle = color.plate;
        ctx.fillRect(lx, ly, lw, 17);
        ctx.globalAlpha = fade;
        ctx.fillStyle = color.cell;
        ctx.textBaseline = "middle";
        ctx.fillText(label, lx + 5, ly + 9);
      }
    }

    // The agent's planned move and its survey trail
    if (this.mode === "agent" && this.task && this.task.phase === "travel") {
      const tg = this.task.target;
      ctx.strokeStyle = color.accent;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.5;
      ctx.setLineDash([1, 5]);
      ctx.beginPath();
      ctx.moveTo(this.probe.x, this.probe.y);
      ctx.lineTo(tg.x, tg.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        ctx.moveTo(tg.x + sx * 9, tg.y + sy * 5);
        ctx.lineTo(tg.x + sx * 9, tg.y + sy * 9);
        ctx.lineTo(tg.x + sx * 5, tg.y + sy * 9);
      }
      ctx.stroke();
    }

    const trail = this.trail;
    if (trail.length > 4) {
      ctx.strokeStyle = color.accent;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(trail[0], trail[1]);
      for (let j = 2; j < trail.length; j += 2) ctx.lineTo(trail[j], trail[j + 1]);
      ctx.lineTo(this.probe.x, this.probe.y);
      ctx.setLineDash([2, 4]);
      ctx.globalAlpha = 0.45;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Probe
    const { x: px, y: py } = this.probe;
    ctx.strokeStyle = color.accent;
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(px, py, 13, 0, TAU);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.moveTo(px + dx * 17, py + dy * 17);
      ctx.lineTo(px + dx * 25, py + dy * 25);
    }
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(px, py, 1.6, 0, TAU);
    ctx.fillStyle = color.accent;
    ctx.fill();

    this.drawLog(now);
    if (this.compare && now < this.compare.until) this.drawCompare();
    else this.drawProfile();
    ctx.globalAlpha = 1;
  }

  panel(x, y, w, h) {
    const { ctx, color } = this;
    ctx.globalAlpha = 0.94;
    ctx.fillStyle = color.plate;
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 0.32;
    ctx.strokeStyle = color.ink;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = color.ink;
    ctx.fillRect(x + 10, y + 25, w - 20, 1);
    ctx.globalAlpha = 1;
    ctx.font = this.font;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
  }

  drawLog(now) {
    const { ctx, W, color } = this;
    const narrow = W < 520;
    const rows = narrow ? 2 : 5;
    const pw = narrow ? W - 28 : Math.min(296, Math.max(200, W * 0.42));
    const ph = 34 + rows * 15;
    const x = 14;
    const y = 14;
    this.panel(x, y, pw, ph);

    ctx.fillStyle = color.ink;
    ctx.fillText("AGENT LOG", x + 10, y + 17);
    ctx.textAlign = "right";
    ctx.fillStyle = color.ink3;
    ctx.fillText(this.mode === "user" ? "MANUAL" : "AUTONOMOUS", x + pw - 10, y + 17);
    ctx.textAlign = "left";

    const cw = ctx.measureText("M").width;
    const verbX = x + 10 + cw * 4.5;
    const detailX = verbX + cw * 11;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, pw - 6, ph);
    ctx.clip();
    const entries = this.log.slice(-rows);
    entries.forEach((entry, j) => {
      const ly = y + 41 + j * 15;
      const reveal = Math.max(0, (now - entry.t) / TYPE_MS);
      ctx.globalAlpha = 0.4 + (0.6 * (j + 1)) / entries.length;
      ctx.fillStyle = color.ink3;
      ctx.fillText(String(entry.n).padStart(3, "0"), x + 10, ly);
      ctx.fillStyle = color.accent;
      ctx.fillText(entry.verb.slice(0, reveal), verbX, ly);
      ctx.fillStyle = color.ink;
      ctx.fillText(entry.detail.slice(0, Math.max(0, reveal - entry.verb.length)), detailX, ly);
    });
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // Multimodal profile of the cell under the probe: transcripts first,
  // electrophysiology from the nearest electrode as a second modality
  drawProfile() {
    const { ctx, W, H, color } = this;
    const pw = W < 520 ? Math.min(210, W * 0.58) : Math.min(240, Math.max(176, W * 0.34));
    const ph = 90;
    const x = W - pw - 14;
    const y = H - ph - 14;
    this.panel(x, y, pw, ph);

    ctx.fillStyle = color.ink;
    ctx.fillText(`CELL ${cellId(this.hi)}`, x + 10, y + 17);
    ctx.textAlign = "right";
    ctx.fillStyle = color.ink3;
    ctx.fillText(KIND[this.kind[this.hi]].toUpperCase(), x + pw - 10, y + 17);
    ctx.textAlign = "left";

    const x0 = x + 56;
    const x1 = x + pw - 10;
    ctx.fillStyle = color.ink3;
    ctx.fillText("RNA", x + 10, y + 52);
    const step = (x1 - x0) / GENES;
    ctx.fillStyle = color.cell;
    for (let g = 0; g < GENES; g++) {
      const h = Math.max(1, this.bars[g] * 20);
      ctx.fillRect(x0 + g * step, y + 54 - h, step * 0.62, h);
    }

    ctx.fillStyle = color.ink3;
    ctx.fillText(`CH ${chId(this.channel)}`, x + 10, y + 79);
    const mid = y + 75;
    const xAt = (j) => x0 + (j / (TRACE_LENGTH - 1)) * (x1 - x0);
    ctx.beginPath();
    for (let j = 0; j < TRACE_LENGTH; j++) {
      const yy = mid - this.trace[j] * 8;
      if (j) ctx.lineTo(xAt(j), yy);
      else ctx.moveTo(xAt(j), yy);
    }
    ctx.strokeStyle = color.ink;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    for (let j = 1; j < TRACE_LENGTH; j++) {
      if (!this.traceFlag[j]) continue;
      ctx.moveTo(xAt(j - 1), mid - this.trace[j - 1] * 8);
      ctx.lineTo(xAt(j), mid - this.trace[j] * 8);
    }
    ctx.strokeStyle = color.accent;
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  // Recordings from the perturbed electrode before and after coating
  drawCompare() {
    const { ctx, W, H, color } = this;
    const c = this.compare;
    const pw = W < 520 ? Math.min(210, W * 0.58) : Math.min(240, Math.max(176, W * 0.34));
    const ph = 90;
    const x = W - pw - 14;
    const y = H - ph - 14;
    this.panel(x, y, pw, ph);

    ctx.fillStyle = color.ink;
    ctx.fillText(`CH ${chId(c.e)} · COATED`, x + 10, y + 17);
    ctx.textAlign = "right";
    ctx.fillStyle = color.ink3;
    ctx.fillText("SPIKES", x + pw - 10, y + 17);
    ctx.textAlign = "left";

    const x0 = x + 56;
    const x1 = x + pw - 28;
    const xAt = (j) => x0 + (j / (TRACE_LENGTH - 1)) * (x1 - x0);
    const rows = [
      { rec: c.before, label: "PRE", tone: color.ink3, line: color.ink, alpha: 0.55, mid: y + 47 },
      { rec: c.after, label: "POST", tone: color.polymer, line: color.polymer, alpha: 1, mid: y + 73 },
    ];
    for (const row of rows) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = row.tone;
      ctx.fillText(row.label, x + 10, row.mid + 4);
      ctx.textAlign = "right";
      ctx.fillText(String(row.rec.count), x + pw - 10, row.mid + 4);
      ctx.textAlign = "left";
      ctx.beginPath();
      for (let j = 0; j < TRACE_LENGTH; j++) {
        const yy = row.mid - row.rec.trace[j] * 9;
        if (j) ctx.lineTo(xAt(j), yy);
        else ctx.moveTo(xAt(j), yy);
      }
      ctx.strokeStyle = row.line;
      ctx.globalAlpha = row.alpha;
      ctx.lineWidth = 1.1;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}

function cellCount(k, what) {
  return `${k} cell${k === 1 ? "" : "s"} ${what}`;
}

function cellId(i) {
  return String(i).padStart(4, "0");
}

function chId(e) {
  return String(e + 1).padStart(2, "0");
}

function rgba(hex, alpha) {
  const v = parseInt(hex.replace("#", ""), 16);
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${alpha})`;
}

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function centroid(poly) {
  if (!poly) return null;
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length - 1; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[i + 1];
    const f = x0 * y1 - x1 * y0;
    area += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  if (!area) return null;
  return [cx / (3 * area), cy / (3 * area)];
}

function inside([x, y], W, H, margin) {
  return x > W * margin && x < W * (1 - margin) && y > H * margin && y < H * (1 - margin);
}

// Membrane outline: polygon shrunk toward its seed, corners rounded
function cellPath(path, poly, cx, cy) {
  if (!poly) return;
  const n = poly.length - 1;
  if (n < 3) return;
  const k = 0.86;
  const q = [];
  for (let j = 0; j < n; j++) q.push([cx + (poly[j][0] - cx) * k, cy + (poly[j][1] - cy) * k]);
  path.moveTo((q[n - 1][0] + q[0][0]) / 2, (q[n - 1][1] + q[0][1]) / 2);
  for (let j = 0; j < n; j++) {
    const a = q[j];
    const b = q[(j + 1) % n];
    path.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
  }
  path.closePath();
}

// Stroke the first `progress` fraction of a sampled outline
function drawPartial(ctx, hull, progress) {
  const { pts, lengths } = hull;
  const limit = hull.total * progress;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let j = 1; j < pts.length; j++) {
    if (lengths[j] <= limit) {
      ctx.lineTo(pts[j][0], pts[j][1]);
      continue;
    }
    const seg = lengths[j] - lengths[j - 1];
    const f = seg ? (limit - lengths[j - 1]) / seg : 0;
    ctx.lineTo(pts[j - 1][0] + (pts[j][0] - pts[j - 1][0]) * f, pts[j - 1][1] + (pts[j][1] - pts[j - 1][1]) * f);
    break;
  }
  ctx.stroke();
}

function baseline(x0, y0, x1, y1) {
  const len = Math.hypot(x1 - x0, y1 - y0);
  return { x0, y0, ux: (x1 - x0) / len, uy: (y1 - y0) / len, len, joints: [] };
}

function intersect(a, b) {
  const cross = a.ux * b.uy - a.uy * b.ux;
  if (Math.abs(cross) < 1e-6) return null;
  const dx = b.x0 - a.x0;
  const dy = b.y0 - a.y0;
  const t = (dx * b.uy - dy * b.ux) / cross;
  const u = (dx * a.uy - dy * a.ux) / cross;
  if (t < 0 || t > a.len || u < 0 || u > b.len) return null;
  return { x: a.x0 + a.ux * t, y: a.y0 + a.uy * t, t, u };
}

function serpentinePath(line, amp, wave) {
  const path = new Path2D();
  const nx = -line.uy;
  const ny = line.ux;
  for (let d = 0; d <= line.len; d += 1.5) {
    let envelope = 1;
    for (const j of line.joints) envelope = Math.min(envelope, smooth(Math.abs(d - j) / wave));
    const o = amp * envelope * Math.sin((d / wave) * TAU);
    const x = line.x0 + line.ux * d + nx * o;
    const y = line.y0 + line.uy * d + ny * o;
    if (d === 0) path.moveTo(x, y);
    else path.lineTo(x, y);
  }
  return path;
}

function smooth(t) {
  return t >= 1 ? 1 : t * t * (3 - 2 * t);
}
