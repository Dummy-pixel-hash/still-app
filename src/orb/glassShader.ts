// Original shader from the user-approved B study in ../orb-mockups/orbs.js.
// A dark analytic lens with folded internal light, not a voice visualizer.
export const glassVertex = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`

export const glassFragment = `
precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform float uActivity;
uniform float uPulse;
uniform float uFinish;
uniform vec3 uPrimary;
uniform vec3 uSecondary;
uniform vec3 uPearl;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float radius = 0.714;
  float r = length(p);
  float aa = 2.0 / uResolution.x;
  if (r > radius + aa) { gl_FragColor = vec4(0.0); return; }
  float mask = 1.0 - smoothstep(radius - aa, radius + aa, r);
  vec2 q = p / radius;
  float z = sqrt(max(0.0, 1.0 - dot(q, q)));
  vec3 normal = normalize(vec3(q, z));
  float fresnel = pow(1.0 - z, 3.4);
  float time = uTime * 0.31;
  float bodyLight = max(0.0, dot(normal, normalize(vec3(-0.65, 0.65, 0.35))));
  vec3 color = vec3(0.014, 0.019, 0.034) + vec3(0.038, 0.046, 0.068) * bodyLight;
  color += mix(uPrimary, uSecondary, 0.45) * 0.035 * pow(1.0 - z, 1.3);

  vec2 lens = q * (0.86 + 0.14 * z);
  float edge = pow(max(0.0, 1.0 - lens.x * lens.x), 0.65);
  float topFold = (0.23 + 0.095 * sin(time * 0.9)) * cos(lens.x * 2.25 + 0.25 * sin(time)) - 0.005;
  float bottomFold = -0.09 + 0.085 * sin(lens.x * 3.7 + time * 0.65);
  float thickness = 0.045 + 0.06 * edge * (0.70 + uActivity * 0.30);
  float bandA = exp(-pow((lens.y - topFold) / thickness, 2.0));
  float bandB = exp(-pow((lens.y - bottomFold) / (0.085 + 0.055 * edge), 2.0));
  float veil = exp(-pow((lens.y - (topFold + bottomFold) * 0.5) / (0.16 * edge + 0.015), 2.0));
  float extent = 1.0 - smoothstep(0.77, 0.99, abs(lens.x));
  float ribbonAlpha = edge * extent;
  vec3 upper = mix(uSecondary, uPearl, smoothstep(-0.5, 0.7, lens.x));
  vec3 lower = mix(uSecondary, uPrimary, smoothstep(-0.7, 0.45, lens.x));
  color += upper * bandA * ribbonAlpha * 1.09;
  color += lower * bandB * ribbonAlpha * 0.90;
  color += mix(lower, upper, 0.35) * veil * ribbonAlpha * 0.13;
  color += lower * exp(-pow((lens.y + 0.19) / 0.30, 2.0)) * edge * 0.065;
  color *= 1.0 + uPulse * 0.20 + uFinish * 0.10;

  float angle = atan(q.y, q.x);
  float rim = exp(-pow((r - (radius - 0.010)) / 0.010, 2.0));
  float topArc = pow(max(0.0, cos(angle - 2.03)), 6.0);
  float lowerArc = pow(max(0.0, cos(angle + 1.16)), 4.0);
  color += vec3(0.92, 0.96, 1.0) * rim * (topArc * 1.03 + lowerArc * 0.25 + 0.035);
  color += vec3(0.20, 0.26, 0.36) * fresnel * (0.11 + lowerArc * 0.3);
  float reflection = pow(max(0.0, dot(normal, normalize(vec3(-0.40, 0.77, 0.49)))), 85.0);
  color += vec3(0.84, 0.88, 0.94) * reflection * 0.24;
  float alpha = mask * 0.985;
  gl_FragColor = vec4(clamp(color, 0.0, 1.0) * alpha, alpha);
}`
