#version 300 es
/* ============================================================================
 * blackhole.frag.glsl
 *
 * Physically motivated Schwarzschild black hole.
 *
 * Units and conventions
 * ---------------------
 *   r_s = 1  (Schwarzschild radius),  M = r_s / 2 = 0.5,  G = c = 1.
 *   Black hole at the origin, accretion disk in the XZ plane (normal +Y).
 *   Camera up is +Y, camera sits at |ro| ~ 22 r_s with the disk nearly edge on.
 *
 * Photon geodesic
 * ---------------
 * A photon moving in Schwarzschild spacetime stays in the plane spanned by the
 * camera position `ro` and its direction `rd`. With u = 1/r and derivatives
 * taken with respect to the orbital angle phi, the null geodesic obeys
 *
 *      u'' = -u + 3 M u^2                                       (1)
 *
 * (equivalently u'' + u = 3 M u^2; the +3Mu^2 term is what bends the light
 * towards the hole, weak field deflection is alpha ~ 4M/b).
 *
 * Basis of the orbital plane (per pixel):
 *
 *      e1 = normalize(ro)                    (unit radial direction at camera)
 *      n  = normalize(cross(ro, rd))         (orbit normal)
 *      e2 = cross(n, e1)                     (in-plane, "forward" direction)
 *
 * Initial conditions at the camera (r0 = |ro|, u0 = 1/r0):
 *
 *      du/dphi = -u0 * dot(rd, e1) / dot(rd, e2)                 (2)
 *
 * 3D position along the path:
 *
 *      p(phi) = (1/u) * (cos(phi) * e1 + sin(phi) * e2)          (3)
 *
 * Note dot(rd, e2) >= 0 by construction (see e2 above), so phi always grows
 * along the traced (backwards) ray.
 *
 * Integration: classical RK4 on the state (u, du) with the adaptive step
 *
 *      dphi = clamp(0.02 / max(u, 0.05), 0.008, 0.06)            (4)
 *
 * (small steps close to the hole where the curvature of the orbit is large).
 *
 * Ray tracing order (backwards from the camera):
 *   camera -> disk slab (front to back) -> horizon (captured) or far field
 *   (escaped: sample the procedural star atlas along the bent direction).
 *
 * Disk (narrow stratified emissive slab)
 * --------------------------------------
 * The disk is a thin plasma slab with scale height (not a uniform cylinder)
 *
 *      h(rho) = uDiskThickness * (0.012 + 0.030 * rho)            (5)
 *
 * composed of a narrow Gaussian core plus a weak wider corona:
 *
 *      vertical(y,h) = 0.82 exp(-(y/h)^2) + 0.18 exp(-(y/(2.35h))^2)
 *
 * and a smooth radial envelope (smooth inner edge * smooth outer edge). A
 * segment contributes only while it is within |y| < 5h and
 * rho in [R_IN*0.90, R_OUT*1.10]. The vertical profile over each segment is
 * integrated with Simpson weights, so a face-on ray cannot alias the thin
 * sheet and an edge-on ray accumulates a smooth long column. In cinematic mode
 * the RK4 step is shortened to dphi <= 0.030 near the disk plane for extra
 * vertical samples; the geodesic equation, the conserved impact parameter and
 * the shadow are untouched by that (only dphi varies).
 *
 * Front-to-back emission/absorption:
 *
 *      dTau   = vert * radial * noise * ds * SLAB_EXTINCTION
 *      alpha  = 1 - exp(-dTau)
 *      col   += trans * emission * alpha
 *      trans *= 1 - alpha
 *
 * The source function is normalised by the vertical column (2.2 h + bias), so
 * moving the thickness slider does not linearly multiply the emergent
 * brightness: the face-on surface brightness stays roughly constant. A soft
 * per-sample cap (SLAB_EMISSION_CAP) bounds the saturated edge-on source, and
 * the ray stops at transmittance TRANS_MIN (tau ~ 3.9), so a grazing ray can
 * never turn the disk into an overexposed white bar.
 *
 * Physics: Keplerian shear Omega ~ rho^-1.5, T ~ rho^-0.75, relativistic
 * Doppler beaming (exponent approaching delta^4) concentrated near the ISCO,
 * gravitational redshift sqrt(1 - r_s/rho), blackbody chromaticity and three
 * compact hotspots orbiting at their own local Keplerian angular velocities.
 *
 * Turbulence is value-noise fBm sampled in the sheared frame. The angular
 * coordinate is embedded as (cos, sin) on a circle so there is no seam at
 * phi = +-PI; a second, radially stretched noise field supplies the visible
 * plasma filaments that survive the edge-on projection.
 * ========================================================================== */

precision highp float;
precision highp int;

in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform float uTime;              // seconds since view creation
uniform vec3  uCamPos;            // camera position in r_s
uniform mat4  uInvViewProj;       // inverse(viewProjection), column major
uniform float uDiskTemperature;   // peak temperature at r_in, Kelvin
uniform float uDiskBrightness;    // emission multiplier
uniform float uDiskThickness;     // slab thickness multiplier (0.3 .. 2.5)
uniform sampler2D uStarAtlas;     // equirectangular RGBA sky (straight alpha)
uniform float uStarAtlasGain;     // HDR gain applied to the atlas composite
uniform float uShowStars;         // 0/1: sample the star atlas
uniform float uLensing;           // 0/1: lens the background
uniform float uStepBudget;        // max RK4 steps per pixel
uniform float uQuality;           // 1 = cinematic, 0 = fast

const float M          = 0.5;     // mass: r_s = 2M = 1
const float R_HORIZON  = 1.0;     // r_s
const float R_IN       = 3.0;     // ISCO = 6M
const float R_OUT      = 11.0;    // outer disk radius
const float R_ESCAPE   = 40.0;    // far field: the ray is straight here
const float PI         = 3.141592653589793;
const float TAU        = 6.283185307179586;

/* Slab geometry, see (5) above. */
const float SLAB_FLOOR = 0.012;      // scale height at rho = 0
const float SLAB_SLOPE = 0.030;      // scale height growth per r_s
const float SLAB_REACH = 5.0;        // sample while |y| < SLAB_REACH * h
const float SLAB_EXTINCTION = 1.05;  // optical depth per unit length
const float SLAB_GAIN = 0.42;        // emission normalisation
const float SLAB_PATH_BIAS = 0.16;   // finite brightness at h -> 0
const float SLAB_EMISSION_CAP = 1.55;// soft cap on the saturated source
const float CORONA_WEIGHT = 0.18;    // fraction of the broad vertical halo
const float CORONA_SCALE = 2.35;     // broad halo scale, in units of h
const float TAU_MAX = 6.0;           // hard optical-depth cap per ray
const float TRANS_MIN = 0.02;        // stop integrating below this transmittance
const float SHEAR_RATE = 2.4;        // visual time scale on Omega ~ rho^-1.5
const float BEAM_FALLOFF = 2.6;      // Doppler beaming decays within ~2 r_in

/* -------------------------------------------------------------------------- */
/* Hashing / value noise                                                       */
/* -------------------------------------------------------------------------- */

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

float valueNoise3(vec3 x) {
  vec3 i = floor(x);
  vec3 f = x - i;
  f = f * f * (3.0 - 2.0 * f);     // smoothstep interpolation

  float n000 = hash13(i);
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));

  float x00 = mix(n000, n100, f.x);
  float x10 = mix(n010, n110, f.x);
  float x01 = mix(n001, n101, f.x);
  float x11 = mix(n011, n111, f.x);

  return mix(mix(x00, x10, f.y), mix(x01, x11, f.y), f.z);
}

/** fBm used for the disk turbulence (3 octaves, or 2 on the "fast" quality
 * level: the third octave is invisible under the bloom but costs a quarter of
 * the noise samples in the volumetric march). Normalised to roughly [0,1]. */
float fbmDisk(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 3; i++) {
    if (i > 1 && uQuality < 0.5) break;
    sum += amp * valueNoise3(p);
    norm += amp;
    p = p * 2.03 + vec3(17.3, 9.1, 5.7);
    amp *= 0.5;
  }
  return sum / max(norm, 1e-5);
}

/* -------------------------------------------------------------------------- */
/* Blackbody -> RGB                                                            */
/* -------------------------------------------------------------------------- */

/* Tanner Helland / Neil Bartlett fit of the Planckian locus, normalised so that
 * 6500 K renders as pure white: the result carries chromaticity only, the
 * physical intensity is applied separately as shift^p (p -> 4 near the ISCO). */
vec3 blackbodyRGB(float kelvin) {
  float t = clamp(kelvin, 1000.0, 40000.0) / 100.0;
  float r;
  float g;
  float b;

  if (t <= 66.0) {
    r = 255.0;
    g = 99.4708025861 * log(t) - 161.1195681661;
    b = (t <= 19.0) ? 0.0 : 138.5177312231 * log(t - 10.0) - 305.0447927307;
  } else {
    r = 329.698727446 * pow(t - 60.0, -0.1332047592);
    g = 288.1221695283 * pow(t - 60.0, -0.0755148492);
    b = 255.0;
  }

  vec3 c = clamp(vec3(r, g, b) / 255.0, vec3(0.0), vec3(1.0));
  vec3 ref6500 = vec3(1.0, 0.99648, 1.0);          // blackbodyRGB(6500)
  return clamp(c / max(ref6500, vec3(1e-3)), vec3(0.0), vec3(1.0));
}

/* -------------------------------------------------------------------------- */
/* Star atlas                                                                  */
/* -------------------------------------------------------------------------- */

/* The sky is a single procedural equirectangular RGBA texture generated once
 * by StarAtlas.ts (see staratlas.frag.glsl + starquad.*.glsl). It stores
 * straight alpha: RGB is the spectral colour, alpha is the soft cloud/star
 * coverage. Compositing over black is therefore `rgb * alpha`, which keeps the
 * untouched background exactly (0, 0, 0). Sampling happens along the final
 * bent direction after the geodesic integration, so the same catalogue of
 * stars produces the Einstein arcs around the shadow.
 *
 * Longitude matches the generator: u = atan(z, x) / TAU + 0.5. Latitude uses
 * asin(y), with v = 0 at the south pole and v = 1 at the north pole. */
vec3 skyColor(vec3 dir) {
  if (uShowStars < 0.5) return vec3(0.0);

  float lon = atan(dir.z, dir.x);
  float lat = asin(clamp(dir.y, -1.0, 1.0));
  vec2 uv = vec2(lon * (1.0 / TAU) + 0.5, lat * (1.0 / PI) + 0.5);

  vec4 atlas = texture(uStarAtlas, uv);
  return atlas.rgb * atlas.a * uStarAtlasGain;
}

/* -------------------------------------------------------------------------- */
/* Accretion disk (stratified emissive slab)                                   */
/* -------------------------------------------------------------------------- */

/* Vertical density profile: a narrow Gaussian core plus a weak, wider corona.
 * Both components are 1 at y = 0, so the column normalisation below stays
 * meaningful when the thickness slider moves. */
float slabVertical(float y, float h) {
  float c = y / h;
  float w = y / (h * CORONA_SCALE);
  return mix(exp(-c * c), exp(-w * w), CORONA_WEIGHT);
}

/* Compact hotspot at radius rSpot. It orbits with the local Keplerian angular
 * velocity Omega(rSpot) = SHEAR_RATE * rSpot^-1.5, so the three spots shear
 * against the disk and against each other instead of turning as one rigid
 * pattern. `sharp` controls the azimuthal width in cos(dphi)^sharp. */
float hotspot(float rho, float phiD, float rSpot, float width, float sharp,
              float phase) {
  float omega = SHEAR_RATE * pow(rSpot, -1.5);
  float dphi = phiD - uTime * omega - phase;
  float angular = pow(max(0.0, cos(dphi)), sharp);
  /* x*x instead of pow(x, 2.0): pow() is undefined for a negative base even
   * when the exponent is integral. */
  float dr = (rho - rSpot) / width;
  float radial = exp(-dr * dr);
  return angular * radial;
}

/* Samples the slab interior. Returns the emissivity per unit length along the
 * ray; `densityShapeOut` is the extinction profile (radial envelope times the
 * turbulence, ~0.2 .. ~1.5) that the caller multiplies by the vertical
 * profile.
 *
 * `rho` is the cylindrical radius sqrt(x^2 + z^2), `phiD` the azimuth,
 * `dirToObserver` the unit vector from the sample towards the camera, `windPhi`
 * how far the traced ray has wound around the hole, `h` the local scale
 * height. */
vec3 diskEmission(float rho, float phiD, vec3 dirToObserver, float windPhi,
                  float h, out float densityShapeOut) {
  /* --- differential (Keplerian) rotation --------------------------------- */
  float omega = SHEAR_RATE * pow(rho, -1.5);      // Omega ~ rho^-1.5
  float theta = phiD - uTime * omega;

  /* Coarse turbulence, embedded on a circle so the pattern is continuous
   * across phi = +-PI. z carries log(rho), so structures are stretched along
   * the flow and thin across it. */
  vec3 q = vec3(cos(theta) * 3.4, sin(theta) * 3.4,
                log(rho) * 7.0 + uTime * 0.015);
  float n = fbmDisk(q);
  float wisps = smoothstep(0.24, 0.80, n);

  /* Fine radial filaments: high azimuthal frequency, low radial frequency, so
   * they read as thin streaks stretched outward. This is the component that
   * keeps the plasma visible when the disk is seen almost edge-on. */
  float fine = valueNoise3(vec3(cos(theta) * 10.5, sin(theta) * 10.5,
                                log(rho) * 2.4));
  float filament = smoothstep(0.38, 0.92, n * 0.62 + fine * 0.38);

  /* Thin, slightly wavy rings: the disk reads as a stack of orbits rather
   * than a smooth glow. */
  float bands = 0.82 + 0.18 * sin(log(rho) * 24.0 + n * 8.0);

  /* Three compact clumps at different radii. Their angular velocities follow
   * the local Keplerian shear, so the inner spot visibly laps the outer ones.
   * They also give the lensed secondary image something to repeat. */
  float spotA = hotspot(rho, phiD, 3.65, 0.42, 52.0, 0.0);
  float spotB = hotspot(rho, phiD, 5.20, 0.60, 46.0, 2.1);
  float spotC = hotspot(rho, phiD, 7.60, 0.85, 40.0, 4.2);
  float hotspots = spotA * 1.75 + spotB * 1.15 + spotC * 0.80;

  /* --- radial envelope --------------------------------------------------- */
  float innerFade = smoothstep(R_IN * 0.94, R_IN * 1.06, rho);
  float outerFade = 1.0 - smoothstep(R_OUT * 0.62, R_OUT * 1.02, rho);
  float edge = innerFade * outerFade;
  float falloff = pow(R_IN / rho, 1.55);          // emissivity drops outward

  /* --- temperature, Doppler beaming, gravitational redshift -------------- */
  float tEmit = max(uDiskTemperature * pow(R_IN / rho, 0.75), 1200.0);

  float beta = min(sqrt(M / rho), 0.85);          // v = sqrt(M/r), c = 1
  float gamma = 1.0 / sqrt(1.0 - beta * beta);
  vec3 tHat = vec3(-sin(phiD), 0.0, cos(phiD));   // orbital direction
  float mu = dot(tHat, dirToObserver);
  float doppler = 1.0 / max(gamma * (1.0 - beta * mu), 1e-3);

  float gRed = sqrt(max(1.0 - R_HORIZON / rho, 0.02));
  float shift = doppler * gRed;

  float tObs = tEmit * shift;
  vec3 chroma = blackbodyRGB(tObs);
  /* Beaming is strongest at the ISCO and decays within ~2 r_in: the exponent
   * runs from ~3.8 (delta^4-like) at r_in down to 0.5 in the outer disk.
   * Applying delta^4 everywhere turns the outer disk into a lopsided lamp. */
  float beamWeight = exp(-BEAM_FALLOFF * max(rho - R_IN, 0.0) / R_IN);
  float beaming = pow(clamp(shift, 0.55, 2.2), mix(0.50, 3.8, beamWeight));

  /* --- photon ring bias --------------------------------------------------
   * Rays that have already wound more than ~2*pi around the hole are the ones
   * producing the secondary image of the disk. The slab already brightens them
   * by itself (the ray grazes the material for a long path), so this stays a
   * gentle bias rather than a drawn ring. */
  float woundGain = 1.0 + 0.22 * smoothstep(TAU, TAU * 1.75, windPhi);

  /* --- extinction profile of the slab ------------------------------------ */
  densityShapeOut = edge * (0.34 + 0.36 * wisps + 0.30 * filament
                            + 0.45 * hotspots);

  /* --- source function ---------------------------------------------------- */
  vec3 source = chroma * beaming
              * (0.55 + 0.55 * filament + 0.20 * wisps) * bands * falloff
              * uDiskBrightness * woundGain * (1.0 + 0.85 * hotspots);

  /* Path normalisation: the integrated vertical profile of a face-on ray is
   * 2.203 h (the corona is included in the vertical integral). Dividing by it
   * keeps the emergent face-on surface brightness stable when the thickness
   * slider moves; the additive bias stops the razor-thin setting from going
   * completely dark.
   *
   * In the optically thick limit the emergent intensity tends to `emission`,
   * so the soft cap bounds the edge-on brightness by SLAB_EMISSION_CAP no
   * matter how long the grazing column is. */
  vec3 emission = source * (SLAB_GAIN / (2.2 * h + SLAB_PATH_BIAS));
  float peak = max(emission.r, max(emission.g, emission.b));
  float capped = SLAB_EMISSION_CAP * (1.0 - exp(-peak / SLAB_EMISSION_CAP));
  return emission * (capped / max(peak, 1e-5));
}

/* -------------------------------------------------------------------------- */
/* Geodesic integration                                                        */
/* -------------------------------------------------------------------------- */

vec3 traceGeodesic(vec3 ro, vec3 rd) {
  vec3 col = vec3(0.0);
  float trans = 1.0;
  float tauRay = 0.0;

  float r0 = length(ro);
  float rMin = r0;                     // closest approach, for the redshift
  vec3 e1 = ro / r0;

  /* Orbital plane basis. cross(ro, rd) degenerates for a perfectly radial ray;
   * such a photon never crosses the disk slab and simply falls in or escapes
   * straight, so handle it analytically. */
  vec3 cr = cross(ro, rd);
  float crLen = length(cr);
  if (crLen < 1e-6) {
    return (dot(rd, e1) > 0.0) ? skyColor(rd) : vec3(0.0);
  }

  vec3 nrm = cr / crLen;
  vec3 e2 = cross(nrm, e1);            // unit: e1 _|_ nrm, both unit length
  float vPhi = dot(rd, e2);            // >= 0 by construction
  if (vPhi < 1e-6) {
    return (dot(rd, e1) > 0.0) ? skyColor(rd) : vec3(0.0);
  }

  float u = 1.0 / r0;
  float du = -u * dot(rd, e1) / vPhi;  // (2)

  float phi = 0.0;
  vec3 pPrev = ro;
  vec3 lastDir = rd;
  vec3 bendDir = rd;
  bool escaped = false;

  int steps = int(clamp(uStepBudget, 8.0, 400.0));

  for (int i = 0; i < steps; i++) {
    float dphi = clamp(0.02 / max(u, 0.05), 0.008, 0.06);   // (4)

    /* Reserve resolution for the thin slab in cinematic mode. Near the disk
     * plane the step is shortened so the vertical profile gets several samples
     * even for a face-on ray; far from the plane the curvature-driven step is
     * kept. This changes only how finely the same geodesic is sampled, not the
     * geodesic itself or the conserved impact parameter. */
    float rhoPrev = length(pPrev.xz);
    if (uQuality > 0.5
        && rhoPrev > R_IN * 0.85 && rhoPrev < R_OUT * 1.12) {
      float hPrev = uDiskThickness * (SLAB_FLOOR + SLAB_SLOPE * rhoPrev);
      if (abs(pPrev.y) < 8.0 * hPrev) {
        dphi = min(dphi, 0.030);
      }
    }

    /* RK4 for u'' = -u + 3 M u^2 (1). */
    float k1u = du;
    float k1d = -u + 3.0 * M * u * u;

    float ua = u + 0.5 * dphi * k1u;
    float da = du + 0.5 * dphi * k1d;
    float k2u = da;
    float k2d = -ua + 3.0 * M * ua * ua;

    float ub = u + 0.5 * dphi * k2u;
    float db = du + 0.5 * dphi * k2d;
    float k3u = db;
    float k3d = -ub + 3.0 * M * ub * ub;

    float uc = u + dphi * k3u;
    float dc = du + dphi * k3d;
    float k4u = dc;
    float k4d = -uc + 3.0 * M * uc * uc;

    u  += (dphi / 6.0) * (k1u + 2.0 * k2u + 2.0 * k3u + k4u);
    du += (dphi / 6.0) * (k1d + 2.0 * k2d + 2.0 * k3d + k4d);
    phi += dphi;

    /* Captured: crossed the horizon (u > 1/r_s). Keep the disk light
     * accumulated so far. */
    if (u > 1.0 / R_HORIZON) {
      break;
    }

    /* u <= 0 means r has run off to infinity (a single step can jump over
     * r = R_ESCAPE, so this is an escape, not a capture). */
    if (u <= 0.0) {
      bendDir = lastDir;
      escaped = true;
      break;
    }

    float r = 1.0 / u;
    rMin = min(rMin, r);
    float cp = cos(phi);
    float sp = sin(phi);
    vec3 p = r * (cp * e1 + sp * e2);              // (3)

    /* Far field: once the ray is past the disk annulus and heading outward, it
     * is straight enough (remaining deflection < 0.02 rad) to stop here. This
     * is the early-out that keeps the step budget for the interesting rays. */
    vec3 seg = p - pPrev;
    if (r > R_ESCAPE && dot(p, seg) > 0.0) {
      bendDir = normalize(seg);
      escaped = true;
      break;
    }

    float ds = length(seg);
    vec3 stepDir = ds > 1e-6 ? seg / ds : lastDir;
    lastDir = stepDir;

    /* ---- stratified disk slab ------------------------------------------- */
    /* Sample at the segment midpoint (emission varies slowly over one step)
     * and integrate the vertical profile at both endpoints and the midpoint
     * with Simpson weights. This is what keeps the thin sheet from aliasing
     * when the ray is nearly face-on. */
    vec3 mid = pPrev + 0.5 * seg;
    float rho = length(mid.xz);
    if (rho > R_IN * 0.90 && rho < R_OUT * 1.10) {
      float h = uDiskThickness * (SLAB_FLOOR + SLAB_SLOPE * rho);
      float yMax = max(abs(pPrev.y), max(abs(mid.y), abs(p.y)));
      if (yMax < SLAB_REACH * h) {
        float vert = (slabVertical(pPrev.y, h)
                    + 4.0 * slabVertical(mid.y, h)
                    + slabVertical(p.y, h)) * (1.0 / 6.0);
        float phiD = atan(mid.z, mid.x);
        float densityShape = 0.0;
        /* The traced ray points away from the camera, so the observer sits at
         * -stepDir. */
        vec3 emission = diskEmission(rho, phiD, -stepDir, phi, h, densityShape);

        /* Cap the optical depth per ray; the source cap in diskEmission already
         * bounds the saturated brightness, so a long grazing column cannot
         * become a white bar. */
        float dTau = vert * densityShape * ds * SLAB_EXTINCTION;
        dTau = min(dTau, max(TAU_MAX - tauRay, 0.0));
        tauRay += dTau;
        float alpha = 1.0 - exp(-dTau);

        col += trans * emission * alpha;            // front-to-back
        trans *= (1.0 - alpha);
        if (trans < TRANS_MIN) {
          break;
        }
      }
    }

    pPrev = p;
  }

  if (escaped) {
    /* Sample the atlas by the final bent direction. The star atlas is the
     * only sky source: captured rays never reach this branch, so the shadow
     * stays perfectly black. */
    vec3 skyDir = normalize(mix(rd, bendDir, clamp(uLensing, 0.0, 1.0)));
    vec3 sky = skyColor(skyDir);

    /* Gravitational redshift of the background close to the photon sphere.
     * A ray that grazes r_ph has g = sqrt(1 - r_s/r_min) < 1; applying the
     * tint only for r_min below ~5 r_s keeps the rest of the sky untouched,
     * while the Einstein-ring images become dimmer and redder. */
    float nearRing = 1.0 - smoothstep(1.6, 5.0, rMin);
    if (nearRing > 0.0) {
      float gRed = sqrt(max(1.0 - R_HORIZON / max(rMin, R_HORIZON + 1e-3), 0.0));
      vec3 tint = vec3(pow(gRed, 0.35), pow(gRed, 0.85), pow(gRed, 1.70));
      sky *= mix(vec3(1.0), tint * pow(gRed, 1.5), nearRing);
    }

    col += trans * sky;
  }

  return col;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

/* Reconstruct a world space ray from the camera through the pixel. */
vec3 cameraRay(vec2 uv) {
  vec2 ndc = uv * 2.0 - 1.0;
  vec4 nearH = uInvViewProj * vec4(ndc, -1.0, 1.0);
  vec4 farH = uInvViewProj * vec4(ndc, 1.0, 1.0);
  vec3 nearP = nearH.xyz / nearH.w;
  vec3 farP = farH.xyz / farH.w;
  return normalize(farP - nearP);
}

void main() {
  vec3 ro = uCamPos;
  vec3 rd = cameraRay(vUv);

  vec3 col = traceGeodesic(ro, rd);

  /* Clamp fireflies so a single hot pixel cannot dominate the bloom. */
  col = min(col, vec3(64.0));
  fragColor = vec4(col, 1.0);
}
