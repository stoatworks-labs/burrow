/**
 * (re)gauss — browser demo.
 *
 * The shaders are not copied here. `shaders.js` is GENERATED from
 * `source/shaders/` by `demo/extract-shaders.mjs`, and `tools/verify.sh` fails
 * if it has drifted — so this page runs the plugin's own GLSL character for
 * character rather than a transcription of it that will one day fall behind.
 *
 * What IS ported by hand is the scalar half: `Field.cpp` (the magnets and the
 * coil), `Masks.cpp` and `Controls.cpp`. Those are C++ the browser cannot link,
 * and every one of the ports below is marked against the function it mirrors.
 *
 * The thing worth understanding before reading any of it: **everything comes
 * from one vector field, read once per electron gun.** The picture leaning is
 * that field's strength; the coloured fringes on every edge are its *gradient*,
 * because the three cathodes sit in different places and their beams fly
 * different paths; the wrong colours are its size measured in shadow-mask
 * pitches. None of the three is drawn. Turn Convergence to zero and the
 * fringing goes while the stain and the lean stay, because all three beams are
 * now on the same path through the same field.
 */

import { mountDemo } from './vendor/demo.js';
import { Program, PassBuffer, bindTexture } from './vendor/gl.js';
import { VERTEX, BEAM, PHOSPHOR, BLOOM, BLUR, SCREEN } from './shaders.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

//===========================================================================
// Port of source/Field.cpp
//===========================================================================

/**
 * The integer hash, not `fract(sin(x) * 43758.5453)`.
 *
 * It has to give the same pole positions here as in the plugin, so it is the
 * same PCG step done in the same 32-bit arithmetic. `Math.imul` and the
 * `>>> 0` are not decoration: JavaScript's `*` on two large integers goes
 * through a double and loses the low bits, which would put every seeded magnet
 * somewhere else than the plugin puts it.
 */
function pcg(v) {
  const state = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const shift = ((state >>> 28) + 4) >>> 0;
  const word = Math.imul(((state >>> shift) ^ state) >>> 0, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}

const hash01 = (v) => pcg(v) / 4294967296;
const hash11 = (v) => hash01(v) * 2 - 1;

/** Layout base positions, in HALF-WIDTHS. See Field.cpp for why. */
const LAYOUTS = [
  // Speaker Left: a big ring magnet just off the left edge, and its unshielded
  // partner across the room contributing almost nothing.
  [[-1.20, 0.20, 1.00], [-1.34, -0.12, -0.85], [1.48, 0.06, 0.16], [1.60, -0.18, -0.13]],
  // Corner Magnet: tight pair, fast falloff, vicious gradient. This is the one
  // that fringes.
  [[0.82, 0.78, 0.95], [1.02, 0.94, -0.88], [-0.90, -0.86, 0.10], [-1.02, -0.96, -0.08]],
  // Ring Magnet: a purity ring knocked round on the neck.
  [[0.00, 1.14, 0.80], [1.14, 0.00, -0.80], [0.00, -1.14, 0.80], [-1.14, 0.00, -0.80]],
  // Wandering: four moderate poles that orbit. Wants Wander turned up.
  [0, 1, 2, 3].map((i) => {
    const a = 1.5707963 * i + 0.4;
    return [1.05 * Math.cos(a), 1.05 * Math.sin(a), i % 2 === 0 ? 0.70 : -0.70];
  }),
  // Earth's Field: far away and correspondingly strong, so the field across the
  // face is near enough uniform — geometry error with no fringing at all.
  [[-4.20, 2.60, 7.00], [4.20, -2.60, -7.00], [-4.60, -2.90, 1.20], [4.60, 2.90, -1.20]],
];

/** Port of regauss::poles(). */
function poles(layout, seed, wander, time, aspect) {
  const base = LAYOUTS[Math.min(Math.max(layout | 0, 0), LAYOUTS.length - 1)];
  const set = base.map((p) => [p[0], p[1], p[2]]);

  // Into square units. Only the layout's own x — the jitter and the drift below
  // are physical movements of a real object, and a real object does not travel
  // further sideways on a wider television.
  const safeAspect = aspect > 0.01 ? aspect : 1;
  for (const p of set) p[0] *= safeAspect;

  const seedWord = (Math.imul(Math.trunc(seed * 4096) >>> 0, 2654435761) + Math.imul(layout, 40503)) >>> 0;
  const reach = (layout === 3 ? 0.85 : 0.22) * wander;

  for (let i = 0; i < set.length; ++i) {
    const h = (seedWord + Math.imul(i, 0x9e3779b9)) >>> 0;

    set[i][0] += hash11(h) * 0.18;
    set[i][1] += hash11((h + 1) >>> 0) * 0.18;
    set[i][2] *= 0.80 + hash01((h + 2) >>> 0) * 0.40;

    // Rates deliberately not harmonically related: two poles at 0.10 and 0.20
    // Hz repeat every ten seconds and the eye finds the loop immediately.
    const rate = 0.043 + hash01((h + 3) >>> 0) * 0.081;
    const phase = hash01((h + 4) >>> 0) * 6.2831853;

    set[i][0] += reach * Math.cos(time * rate * 6.2831853 + phase);
    set[i][1] += reach * Math.sin(time * rate * 4.6831853 + phase * 1.7);
  }

  return set;
}

/**
 * Port of regauss::coil().
 *
 * A real automatic degausser is a coil in series with a PTC thermistor: cold at
 * switch-on, passing a large mains-frequency current, heating, and dying away
 * over a second or two. The decay is what actually demagnetises the mask — the
 * field has to pass through every amplitude on its way down.
 */
function coil(since, duration, intensity) {
  if (since < 0) return { ac: 0, retained: 1, sag: 0 };

  // 4.6 is ln(100): down to one per cent after exactly `duration` seconds, so
  // the control means what its label says.
  const k = 4.6 / (duration > 0.05 ? duration : 0.05);
  const envelope = Math.exp(-since * k);

  return {
    ac: envelope * intensity,
    retained: envelope,
    // The HT recovers faster than the field dies: the thermistor's resistance
    // is climbing, so the current falls faster than the field it produces.
    sag: Math.exp(-since * k * 1.9) * intensity,
  };
}

const acFrequency = (p) => 10 + clamp01(p) * 110;

const scheduledTrigger = (now, grid) =>
  grid <= 0 || now < 0 ? -1 : Math.floor(now / grid) * grid;

//===========================================================================
// Port of source/Masks.cpp
//
// The gains are MEASURED, not derived — see the note in that file. spill and
// gain are optical; staggers and triangularGun are mechanical, and they are why
// this is a table rather than a switch in the shader.
//===========================================================================

const MASKS = [
  { name: 'None', spill: 0.00, gain: 1.000, staggers: false, triangularGun: false },
  { name: 'Shadow Mask', spill: 0.35, gain: 2.235, staggers: true, triangularGun: true },
  { name: 'Aperture Grille', spill: 0.28, gain: 2.171, staggers: false, triangularGun: false },
  { name: 'Slot Mask', spill: 0.32, gain: 2.099, staggers: true, triangularGun: false },
  { name: 'RGB Stripe', spill: 0.15, gain: 2.314, staggers: false, triangularGun: false },
];

//===========================================================================
// Port of source/Controls.cpp
//===========================================================================

/**
 * The two sensitivities.
 *
 * Separate for a physical reason. How far a field bends the beam is set by the
 * yoke and the anode voltage; how much colour error that bend causes is set by
 * the mask pitch and the gun-to-mask distance. Different hardware, and their
 * real ratio puts nearly everything interesting at one end — a magnet too weak
 * to move the geometry will still rotate the colours completely.
 */
const DEFLECT_SCALE = 0.5;
const PURITY_SCALE = 4.0;
const REFERENCE_PITCH = 4.0;
const POLE_HEIGHT = 0.55;

/** Geometric, so a duration slider has equal resolution per octave. */
const geometric = (p, lo, hi) => lo * Math.pow(hi / lo, clamp01(p));

const Deflection = (p) => clamp01(p) * DEFLECT_SCALE;
const MaskPitchPixels = (p) => lerp(2, 14, clamp01(p));
const LineCount = (p) => lerp(120, 960, clamp01(p));
const GunSeparation = (p) => clamp01(p) * 0.30;
const Interval = (p) => geometric(p, 0.25, 30);
const Duration = (p) => geometric(p, 0.15, 6);
const Intensity = (p) => clamp01(p) * 3;
const Recovery = (p) => geometric(p, 0.2, 60);
const Overscan = (p) => lerp(1, 1.15, clamp01(p));

/** Port of regauss::controls::drive(). */
function drive(s, mask, now, lastTrigger, outW, outH) {
  const sinceTrigger = lastTrigger >= 0 ? now - lastTrigger : -1;
  const c = coil(sinceTrigger, Duration(s.duration), Intensity(s.intensity));

  const aspect = outW / Math.max(outH, 1);
  const d = { poles: poles(s.layout, s.seed, clamp01(s.wander), now, aspect) };

  // Two things compete: the coil walking the magnetisation down, and time
  // letting it creep back. `max` rather than a sum, so the handover is
  // monotonic and the total can never exceed what the operator asked for.
  const recovered = sinceTrigger < 0 ? 1 : 1 - Math.exp(-sinceTrigger / Recovery(s.recovery));
  d.staticAmp = clamp01(s.magnetisation) * Math.max(c.retained, recovered);

  d.acAmp = clamp01(s.interference) + c.ac;
  d.frequency = acFrequency(s.frequency);

  d.deflection = Deflection(s.deflection);

  const pitch = MaskPitchPixels(s.maskPitch);
  d.purityGainX = clamp01(s.purity) * PURITY_SCALE * (REFERENCE_PITCH / pitch);

  // A vertical landing error only costs colour on a mask whose triads stagger
  // row to row. An aperture grille's stripes run the full height of the tube,
  // so a vertical error slides the beam along its own stripe and changes
  // nothing — a genuine advantage of the design, falling out of the table.
  //
  // 1.732 is 1.5 / 0.866: one row step on a hexagonal lattice is 0.866 of a
  // phosphor width vertically and staggers the triad by half of one.
  d.purityGainY = mask.staggers
    ? d.purityGainX * (outH / Math.max(outW, 1)) * 1.7320508
    : 0;

  // A mask with no phosphor structure has nothing for the beam to fall between,
  // so there is no purity error to have. That is a monochrome tube.
  if (s.maskPattern <= 0) {
    d.purityGainX = 0;
    d.purityGainY = 0;
  }

  d.gunSeparation = GunSeparation(s.convergence);
  d.gunTriangular = mask.triangularGun ? 1 : 0;

  const sag = clamp01(c.sag) * clamp01(s.coilSag);
  d.sag = sag;
  // Less anode voltage means slower electrons, and slower electrons are bent
  // further by the same yoke current. The picture swells while it degausses.
  d.swell = sag * 0.06;

  d.overscan = Overscan(s.overscan);

  return d;
}

//===========================================================================
// The renderer. A port of ProcessOpenGL in source/Regauss.cpp.
//===========================================================================

function createRenderer(gl, quad) {
  const beamShader = new Program(gl, VERTEX, BEAM, 'beam');
  const phosphorShader = new Program(gl, VERTEX, PHOSPHOR, 'phosphor');
  const bloomShader = new Program(gl, VERTEX, BLOOM, 'bloom');
  const blurShader = new Program(gl, VERTEX, BLUR, 'blur');
  const screenShader = new Program(gl, VERTEX, SCREEN, 'screen');

  const beamBuffer = new PassBuffer(gl);
  const phosphorBuffer = [new PassBuffer(gl), new PassBuffer(gl)];
  const bloomBuffer = [new PassBuffer(gl), new PassBuffer(gl), new PassBuffer(gl)];

  let phosphorIndex = 0;

  // When the coil last fired, in the page's own seconds, or negative for "not
  // yet". The plugin keeps the same one thing.
  let manualTrigger = -1;
  let lastDegaussValue = 0;
  let lastTime = 0;
  let scanPeriod = 1 / 60;

  return {
    render({ input, params, width, height, time }) {
      const RGBA16F = gl.RGBA16F;

      // How long the beam takes to paint one raster, measured rather than
      // assumed. It decides whether mains interference stands still or rolls: a
      // 50 Hz field on a set scanning at 50 Hz puts every line at the same
      // phase and the bend does not move at all.
      if (time > lastTime) {
        const delta = Math.min(Math.max(time - lastTime, 1 / 240), 1 / 10);
        scanPeriod += (delta - scanPeriod) * 0.15;
      }
      lastTime = time;

      // The plugin's Degauss is an FF_TYPE_EVENT, which a host draws as a
      // button. The demo kit has no such control, so it is a toggle here and
      // ANY flip fires the coil — see `differences`.
      const degauss = params.get('degauss');
      if (degauss !== lastDegaussValue) {
        manualTrigger = time;
        lastDegaussValue = degauss;
      }

      const maskIndex = Math.round(params.get('maskPattern'));
      const mask = MASKS[maskIndex];
      const interferenceOnly = Math.round(params.get('mode')) === 1;

      // The most recent scheduled firing, or the manual one, whichever is later.
      const autoMode = Math.round(params.get('auto'));
      let scheduled = -1;
      if (autoMode === 1) {
        scheduled = scheduledTrigger(time, Interval(params.get('interval')));
      } else if (autoMode === 2 || autoMode === 3) {
        // The plugin recovers the bar line from the host's own transport. The
        // page has none, so it counts bars at a fixed 120 bpm — see
        // `differences`.
        const barSeconds = 240 / 120;
        scheduled = scheduledTrigger(time, autoMode === 2 ? barSeconds / 4 : barSeconds);
      }
      const lastTrigger = Math.max(scheduled, manualTrigger);

      const d = drive(
        {
          layout: Math.round(params.get('layout')),
          magnetisation: params.get('magnetisation'),
          seed: params.get('seed'),
          wander: params.get('wander'),
          interference: params.get('interference'),
          frequency: params.get('frequency'),
          deflection: params.get('deflection'),
          purity: params.get('purity'),
          convergence: params.get('convergence'),
          overscan: params.get('overscan'),
          duration: params.get('duration'),
          intensity: params.get('intensity'),
          coilSag: params.get('coilSag'),
          recovery: params.get('recovery'),
          maskPitch: params.get('maskPitch'),
          maskPattern: maskIndex,
        },
        mask,
        time,
        lastTrigger,
        width,
        height,
      );

      const bloomW = Math.max(1, Math.floor(width / 4));
      const bloomH = Math.max(1, Math.floor(height / 4));

      const usePhosphor = params.get('persistence') > 0.001;
      const useHalation = !interferenceOnly && params.get('halation') > 0.001;

      // 16-bit float rather than 8-bit: the persistence pass reads its own
      // output back every frame, and quantising a decaying trail to 256 levels
      // bands it into visible steps within a second.
      beamBuffer.ensure(width, height, RGBA16F);
      phosphorBuffer[0].ensure(width, height, RGBA16F);
      phosphorBuffer[1].ensure(width, height, RGBA16F);
      bloomBuffer[0].ensure(bloomW, bloomH, RGBA16F);
      bloomBuffer[1].ensure(bloomW, bloomH, RGBA16F);
      bloomBuffer[2].ensure(bloomW, bloomH, RGBA16F);

      gl.disable(gl.BLEND);

      //------------------------------------------------------------------
      // 1. Where the beam landed.
      //------------------------------------------------------------------
      beamBuffer.bind();
      beamShader.use();
      bindTexture(gl, 0, input.texture);
      beamShader.setSampler('InputTexture', 0);
      beamShader.set('MaxUV', 1, 1);
      beamShader.set('InputSize', input.width, input.height);
      beamShader.set('OutputSize', width, height);

      beamShader.set('Pole0', d.poles[0][0], d.poles[0][1], d.poles[0][2]);
      beamShader.set('Pole1', d.poles[1][0], d.poles[1][1], d.poles[1][2]);
      beamShader.set('Pole2', d.poles[2][0], d.poles[2][1], d.poles[2][2]);
      beamShader.set('Pole3', d.poles[3][0], d.poles[3][1], d.poles[3][2]);
      beamShader.set('PoleHeight', POLE_HEIGHT);

      beamShader.set('Deflection', d.deflection);
      beamShader.set('PurityGainX', d.purityGainX);
      beamShader.set('PurityGainY', d.purityGainY);
      beamShader.set('GunSeparation', d.gunSeparation);
      beamShader.set('GunTriangular', d.gunTriangular);

      beamShader.set('StaticAmp', d.staticAmp);
      beamShader.set('AcAmp', d.acAmp);
      beamShader.set('Frequency', d.frequency);
      beamShader.set('Time', time);
      beamShader.set('ScanPeriod', scanPeriod);

      beamShader.set('Swell', d.swell);
      beamShader.set('Sag', d.sag);
      beamShader.set('Overscan', d.overscan);
      quad.draw();

      //------------------------------------------------------------------
      // 2. Phosphor decay. It sits AFTER the beam pass because the phosphor is
      //    a coating on the glass: it glows where the beam hit, not where it
      //    was aimed. That is what makes a violent degauss read as the picture
      //    being thrown about rather than a still frame with a wobble on it.
      //------------------------------------------------------------------
      let screenTexture = beamBuffer.texture;
      if (usePhosphor) {
        const target = phosphorIndex;
        const history = 1 - phosphorIndex;

        phosphorBuffer[target].bind();
        phosphorShader.use();
        bindTexture(gl, 0, beamBuffer.texture);
        bindTexture(gl, 1, phosphorBuffer[history].texture);
        phosphorShader.setSampler('CurrentTexture', 0);
        phosphorShader.setSampler('HistoryTexture', 1);

        const decay = params.get('persistence') * 0.93;
        // Blue goes out first and green hangs on longest, so a white highlight
        // dragged across the screen leaves a faintly green wake.
        phosphorShader.set('Decay', decay * 0.97, decay, decay * 0.90);
        quad.draw();

        screenTexture = phosphorBuffer[target].texture;
        phosphorIndex = history;
        bindTexture(gl, 1, null);
      }

      //------------------------------------------------------------------
      // 3. Halation, at quarter size.
      //------------------------------------------------------------------
      if (useHalation) {
        bloomBuffer[0].bind();
        bloomShader.use();
        bindTexture(gl, 0, screenTexture);
        bloomShader.setSampler('SourceTexture', 0);
        bloomShader.set('SourceSize', width, height);
        bloomShader.set('Threshold', 0.5);
        quad.draw();

        const blurs = [
          { from: 0, to: 1, dx: 1 / bloomW, dy: 0 },
          { from: 1, to: 2, dx: 0, dy: 1 / bloomH },
        ];
        for (const pass of blurs) {
          bloomBuffer[pass.to].bind();
          blurShader.use();
          bindTexture(gl, 0, bloomBuffer[pass.from].texture);
          blurShader.setSampler('SourceTexture', 0);
          blurShader.set('Direction', pass.dx, pass.dy);
          quad.draw();
        }
      }

      //------------------------------------------------------------------
      // 4. The glass.
      //------------------------------------------------------------------
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);

      screenShader.use();
      bindTexture(gl, 0, screenTexture);
      bindTexture(gl, 1, bloomBuffer[2].texture);
      screenShader.setSampler('ScreenTexture', 0);
      screenShader.setSampler('BloomTexture', 1);
      screenShader.set('OutputSize', width, height);

      screenShader.set('TubeEnabled', interferenceOnly ? 0 : 1);

      screenShader.set('MaskPattern', maskIndex);
      screenShader.set('MaskPitch', MaskPitchPixels(params.get('maskPitch')));
      screenShader.set('MaskStrength', params.get('maskStrength'));
      screenShader.set('MaskSpill', mask.spill);
      screenShader.set('MaskGain', mask.gain);

      screenShader.set('Scanlines', params.get('scanlines'));
      screenShader.set('LineCount', LineCount(params.get('lineCount')));
      screenShader.set('BeamBloom', params.get('beamBloom'));
      screenShader.set('Halation', useHalation ? params.get('halation') * 0.8 : 0);
      screenShader.set('Brightness', params.get('brightness') * 2);
      screenShader.set('Contrast', params.get('contrast') * 2);

      screenShader.set('Curvature', params.get('curvature') * 0.6);
      screenShader.set('CornerRadius', params.get('cornerRadius') * 0.35);
      screenShader.set('PerspectiveX', (params.get('perspectiveX') - 0.5) * 1.8);
      screenShader.set('PerspectiveY', (params.get('perspectiveY') - 0.5) * 1.8);
      screenShader.set('Zoom', lerp(0.5, 1.5, params.get('zoom')));
      screenShader.set('Vignette', params.get('vignette'));
      quad.draw();

      bindTexture(gl, 1, null);
      bindTexture(gl, 0, null);
    },
  };
}

//===========================================================================

const pct = (v) => `${Math.round(v * 100)}%`;
const unity = (v) => `${(v * 2).toFixed(2)}×`;
const secs = (v) => `${v < 1 ? v.toFixed(2) : v.toFixed(1)} s`;

mountDemo({
  name: '(re)gauss',
  pluginId: 'RG01',
  tagline: 'A magnet near a television, and the coil that clears it.',
  repo: 'https://github.com/stoatworks-labs/regauss',
  page: 'https://stoatworks-labs.com/software/regauss/',
  needFloat: true,
  showBackdrop: true,

  params: [
    {
      id: 'mode', name: 'Render', type: 'option', default: 0, group: 'Mode',
      elements: ['Full CRT', 'Interference Only'],
      hint: 'Interference Only applies the magnet and the coil with no television of its own — for stacking on Old Cathode, or on real CRT footage. Purity still works: it uses the mask pitch as an implied scale rather than a drawn one.',
    },

    // ---- Field -----------------------------------------------------------
    {
      id: 'layout', name: 'Layout', type: 'option', default: 0, group: 'Field',
      elements: ['Speaker Left', 'Corner Magnet', 'Ring Magnet', 'Wandering', "Earth's Field"],
      hint: 'A tight pair of poles gives a small hard stain with heavy fringing, because a steep field is a steep gradient. A distant pair gives a broad soft discolouration with none at all — which is exactly what the Earth’s field does to a set someone has turned round.',
    },
    { id: 'magnetisation', name: 'Magnetisation', type: 'standard', default: 0.70, group: 'Field', display: pct, hint: 'How much field the shadow mask is holding. The coil walks this down.' },
    { id: 'seed', name: 'Seed', type: 'standard', default: 0.0, group: 'Field', display: pct },
    { id: 'wander', name: 'Wander', type: 'standard', default: 0.0, group: 'Field', display: pct, hint: 'At zero the magnets are bolted down. A stain that crawls when nobody asked reads as a bug rather than as a magnet in the room.' },
    { id: 'interference', name: 'Interference', type: 'standard', default: 0.0, group: 'Field', display: pct },
    {
      id: 'frequency', name: 'Frequency', type: 'standard', default: 0.364, group: 'Field',
      display: (v) => `${acFrequency(v).toFixed(0)} Hz`,
      hint: 'Near the frame rate every line sees the same phase and the bend stands still. A hertz either side and it crawls up or down the picture — which is the whole mechanism behind a rolling hum bar.',
    },

    // ---- Beam ------------------------------------------------------------
    { id: 'deflection', name: 'Deflection', type: 'standard', default: 0.25, group: 'Beam', display: pct, hint: 'How far the field bends the beam: the geometry error.' },
    { id: 'purity', name: 'Purity', type: 'standard', default: 0.70, group: 'Beam', display: pct, hint: 'How much of a colour error that bend causes. Separate from Deflection because a real tube’s two sensitivities are set by different hardware — a magnet too weak to move the geometry will still rotate the colours completely.' },
    { id: 'convergence', name: 'Convergence', type: 'standard', default: 0.30, group: 'Beam', display: pct, hint: 'How far apart the three cathodes sit. At zero all three beams take the same path and the fringing goes, while the stain and the lean stay.' },
    { id: 'overscan', name: 'Overscan', type: 'standard', default: 0.25, group: 'Beam', display: (v) => `${(Overscan(v) * 100).toFixed(0)}%` },

    // ---- Degauss ---------------------------------------------------------
    { id: 'degauss', name: 'Degauss', type: 'boolean', default: 0, group: 'Degauss', hint: 'Fires the coil. In the plugin this is a button; here it is a toggle, and every flip either way fires it.' },
    {
      id: 'auto', name: 'Auto', type: 'option', default: 0, group: 'Degauss',
      elements: ['Off', 'Interval', 'Beat', 'Bar'],
      hint: 'The plugin takes Beat and Bar from Resolume’s transport. This page has none, so it counts at a fixed 120 bpm.',
    },
    { id: 'interval', name: 'Interval', type: 'standard', default: 0.58, group: 'Degauss', display: (v) => secs(Interval(v)) },
    { id: 'duration', name: 'Duration', type: 'standard', default: 0.62, group: 'Degauss', display: (v) => secs(Duration(v)), hint: 'How long the coil takes to fall to one per cent. The decay is what demagnetises the mask — the field has to pass through every amplitude on its way down.' },
    { id: 'intensity', name: 'Intensity', type: 'standard', default: 0.70, group: 'Degauss', display: pct },
    { id: 'coilSag', name: 'Coil Sag', type: 'standard', default: 0.60, group: 'Degauss', display: pct, hint: 'How far the coil pulls the HT down. The picture dims and swells while it runs, because slower electrons are bent further by the same yoke current.' },
    { id: 'recovery', name: 'Recovery', type: 'standard', default: 0.65, group: 'Degauss', display: (v) => secs(Recovery(v)), hint: 'How long the mask takes to magnetise again after a degauss.' },

    // ---- Tube ------------------------------------------------------------
    {
      id: 'maskPattern', name: 'Mask Pattern', type: 'option', default: 1, group: 'Tube',
      elements: MASKS.map((m) => m.name),
      hint: 'It decides how a landing error becomes a colour error. An aperture grille’s stripes run the full height of the tube, so a vertical error slides the beam along its own stripe and costs nothing — a real advantage of the design. “None” is a monochrome tube: no phosphor structure, so no purity fault is possible.',
    },
    { id: 'maskPitch', name: 'Mask Pitch', type: 'standard', default: 0.30, group: 'Tube', display: (v) => `${MaskPitchPixels(v).toFixed(1)} px` },
    { id: 'maskStrength', name: 'Mask Strength', type: 'standard', default: 0.60, group: 'Tube', display: pct },
    { id: 'scanlines', name: 'Scanlines', type: 'standard', default: 0.50, group: 'Tube', display: pct },
    { id: 'lineCount', name: 'Line Count', type: 'standard', default: 0.429, group: 'Tube', display: (v) => `${LineCount(v).toFixed(0)} lines` },
    { id: 'beamBloom', name: 'Beam Bloom', type: 'standard', default: 0.50, group: 'Tube', display: pct },
    { id: 'persistence', name: 'Persistence', type: 'standard', default: 0.15, group: 'Tube', display: pct },
    { id: 'halation', name: 'Halation', type: 'standard', default: 0.25, group: 'Tube', display: pct },
    { id: 'brightness', name: 'Brightness', type: 'standard', default: 0.50, group: 'Tube', display: unity },
    { id: 'contrast', name: 'Contrast', type: 'standard', default: 0.50, group: 'Tube', display: unity },

    // ---- Geometry --------------------------------------------------------
    { id: 'curvature', name: 'Curvature', type: 'standard', default: 0.28, group: 'Geometry', display: pct },
    { id: 'cornerRadius', name: 'Corner Radius', type: 'standard', default: 0.16, group: 'Geometry', display: pct },
    { id: 'perspectiveX', name: 'Perspective X', type: 'standard', default: 0.5, group: 'Geometry', display: (v) => `${(((v - 0.5) * 1.8 * 180) / Math.PI).toFixed(0)}°` },
    { id: 'perspectiveY', name: 'Perspective Y', type: 'standard', default: 0.5, group: 'Geometry', display: (v) => `${(((v - 0.5) * 1.8 * 180) / Math.PI).toFixed(0)}°` },
    { id: 'zoom', name: 'Zoom', type: 'standard', default: 0.5, group: 'Geometry', display: (v) => `${lerp(0.5, 1.5, v).toFixed(2)}×` },
    { id: 'vignette', name: 'Vignette', type: 'standard', default: 0.35, group: 'Geometry', display: pct },
  ],

  sources: ['scene', 'bars', 'grid', 'detail', 'ramp', 'spot'],

  presets: {
    'Speaker beside it': {},
    'Corner stain': { layout: 1, magnetisation: 0.80, purity: 0.75, convergence: 0.55, deflection: 0.14, maskPitch: 0.26 },
    'Mains hum': { layout: 2, magnetisation: 0.05, interference: 0.35, deflection: 0.30, purity: 0.35, frequency: 0.364, lineCount: 0.543 },
    'Degauss on the bar': { auto: 3, magnetisation: 0.70, deflection: 0.35, intensity: 0.85, coilSag: 0.8, recovery: 0.42, persistence: 0.35, wander: 0.15 },
    'Nothing bolted down': { layout: 3, wander: 0.75, magnetisation: 0.60, deflection: 0.40, purity: 0.65, convergence: 0.50, persistence: 0.45, maskPattern: 3 },
    'Trinitron, magnetised': { maskPattern: 2, maskPitch: 0.20, magnetisation: 0.65, deflection: 0.08, convergence: 0.25, curvature: 0.08, cornerRadius: 0.10, vignette: 0.18, lineCount: 0.62 },
    'Failing yoke': { layout: 2, magnetisation: 0.85, wander: 0.35, interference: 0.30, deflection: 0.55, purity: 0.7, convergence: 0.65, auto: 1, interval: 0.5, intensity: 1.0, coilSag: 1.0, recovery: 0.25, persistence: 0.5, halation: 0.55 },
    'Interference only': { mode: 1, deflection: 0.20, purity: 0.5, maskStrength: 0, scanlines: 0, halation: 0, curvature: 0, cornerRadius: 0, vignette: 0, overscan: 0.10 },
  },

  differences: [
    'The plugin’s Degauss is an FF_TYPE_EVENT — a control the host draws as a button, and one a MIDI or OSC message can fire mid-show. The inspector here has no button, so it is a toggle, and the coil fires on every flip in either direction rather than on a rising edge.',
    'Beat and Bar take their grid from Resolume’s own transport in the plugin: it recovers the current bar line from the tempo and bar phase the host sends every frame, so a firing lands exactly on the music. This page has no transport, so it counts at a fixed 120 bpm from when it loaded.',
    'The plugin asks the host for its clock, so re-rendering a composition gives the same wobble rather than whatever the wall clock said. Here the clock is the page’s own, accumulated from frame deltas — which is why Restart puts the magnets back where they started.',
    'Whether mains interference rolls or stands still depends on the frame period, and the plugin measures that from the host. Here it is measured from the browser’s, so the same Frequency will roll at a different rate on a 60 Hz display than on a 120 Hz one. That is the real behaviour, not an artefact: a 50 Hz field on a set scanning at 50 Hz genuinely does not move.',
    'The plugin has an Audio group: Resolume hands it an FFT every frame, and it drives the field directly — the default layout is a speaker, and a speaker’s stray field is the audio signal. This page has no audio at all, so that group is absent rather than present and dead.',
    'The chain runs in 16-bit float here as it does in the plugin, which needs EXT_color_buffer_float. If your browser lacks it the page says so rather than quietly dropping to 8 bits and banding the persistence trail.',
  ],

  createRenderer,
});
