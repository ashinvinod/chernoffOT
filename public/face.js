/**
 * Renders a Chernoff face as an SVG string in a "Comic Book" style.
 * All input parameters should be normalized to 0-1 range.
 *
 * @param {Object} params
 * @param {number} params.mouth - 0 = sad, 1 = happy
 * @param {number} params.eyeSize - 0 = slitted, 1 = popped
 * @param {number} params.browAngle - 0 = angry, 1 = chill
 * @param {number} params.health - 0 = critical, 1 = healthy
 * @returns {string} SVG string
 */
export function renderFace({
  mouth = 1,
  eyeSize = 0,
  browAngle = 1,
  health = 1,
}) {
  const VIEWBOX_SIZE = 200;
  const CENTER_X = VIEWBOX_SIZE / 2;
  const CENTER_Y = VIEWBOX_SIZE / 2;

  // --- Comic Colors ---
  // We use discrete buckets or vibrant interpolation? 
  // Let's use discrete buckets for that "printed" look.
  let fill, bgPattern;
  if (health > 0.66) {
      fill = "#4ade80"; // Comic Green
  } else if (health > 0.33) {
      fill = "#facc15"; // Comic Yellow
  } else {
      fill = "#fb7185"; // Comic Red
  }

  const strokeColor = "#000000";
  const strokeWidth = 5;

  // --- Features ---

  // Brows
  const browYInner = 70 + (1 - browAngle) * 20; 
  const browYOuter = 70 - (1 - browAngle) * 10; 

  // Eyes
  // 0 -> Slitted/Squinting (Width normal, Height small)
  // 1 -> Popped (Width large, Height large)
  // Let's make it more cartoonish.
  const eyeRadiusX = 12 + eyeSize * 10; 
  const eyeRadiusY = 12 + eyeSize * 15; 
  const pupilRadius = 4 + eyeSize * 3; 

  // Mouth
  // 0 -> Frown
  // 1 -> Smile
  const mouthY = 145;
  const mouthWidth = 60;
  const mouthXStart = CENTER_X - mouthWidth / 2;
  const mouthXEnd = CENTER_X + mouthWidth / 2;
  
  // Exaggerate curve
  const mouthCurve = (mouth - 0.5) * 80; // More curve
  const mouthControlY = mouthY + mouthCurve;

  // Sweat Drop (if low health)
  let extras = "";
  if (health < 0.3) {
      extras += `
        <path d="M 160 50 Q 150 40 160 30 Q 170 40 160 50 Z" fill="#60a5fa" stroke="black" stroke-width="3" />
        <path d="M 40 60 Q 30 50 40 40 Q 50 50 40 60 Z" fill="#60a5fa" stroke="black" stroke-width="3" />
      `;
  }

  return `
    <svg viewBox="0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}" xmlns="http://www.w3.org/2000/svg" class="chernoff-face">
      <defs>
        <!-- Halftone pattern for texture -->
        <pattern id="dots" x="0" y="0" width="10" height="10" patternUnits="userSpaceOnUse">
          <circle cx="2" cy="2" r="1.5" fill="#000" opacity="0.1"/>
        </pattern>
      </defs>

      <!-- Head Shadow (Offset) -->
      <circle cx="${CENTER_X + 5}" cy="${CENTER_Y + 5}" r="90" fill="black" />

      <!-- Head Base -->
      <circle cx="${CENTER_X}" cy="${CENTER_Y}" r="90" fill="${fill}" stroke="${strokeColor}" stroke-width="${strokeWidth}" />
      
      <!-- Texture Overlay -->
      <circle cx="${CENTER_X}" cy="${CENTER_Y}" r="90" fill="url(#dots)" opacity="1" pointer-events="none" />

      <!-- Shine/Highlight (Comic style) -->
      <path d="M ${CENTER_X + 40} ${CENTER_Y - 50} Q ${CENTER_X + 60} ${CENTER_Y - 60} ${CENTER_X + 70} ${CENTER_Y - 30}" 
            stroke="white" stroke-width="8" stroke-linecap="round" fill="none" opacity="0.6" />

      <!-- Extras -->
      ${extras}

      <!-- Ears (Little bumps) -->
      <path d="M ${CENTER_X - 90} ${CENTER_Y - 10} Q ${CENTER_X - 100} ${CENTER_Y} ${CENTER_X - 90} ${CENTER_Y + 10}" fill="${fill}" stroke="${strokeColor}" stroke-width="${strokeWidth}" />
      <path d="M ${CENTER_X + 90} ${CENTER_Y - 10} Q ${CENTER_X + 100} ${CENTER_Y} ${CENTER_X + 90} ${CENTER_Y + 10}" fill="${fill}" stroke="${strokeColor}" stroke-width="${strokeWidth}" />

      <!-- Eyebrows -->
      <!-- Left -->
      <path d="M 60 ${browYOuter} Q 75 ${browYInner - 10} 90 ${browYInner}" 
            stroke="${strokeColor}" stroke-width="${strokeWidth+2}" fill="none" stroke-linecap="round" />
      <!-- Right -->
      <path d="M 140 ${browYOuter} Q 125 ${browYInner - 10} 110 ${browYInner}" 
            stroke="${strokeColor}" stroke-width="${strokeWidth+2}" fill="none" stroke-linecap="round" />

      <!-- Eyes -->
      <!-- Left -->
      <ellipse cx="75" cy="95" rx="${eyeRadiusX}" ry="${eyeRadiusY}" fill="white" stroke="${strokeColor}" stroke-width="4" />
      <circle cx="75" cy="95" r="${pupilRadius}" fill="black" />
      
      <!-- Right -->
      <ellipse cx="125" cy="95" rx="${eyeRadiusX}" ry="${eyeRadiusY}" fill="white" stroke="${strokeColor}" stroke-width="4" />
      <circle cx="125" cy="95" r="${pupilRadius}" fill="black" />

      <!-- Nose (Simple Checkmark or Triangle) -->
      <path d="M ${CENTER_X} 105 L ${CENTER_X - 10} 125 L ${CENTER_X + 5} 120" stroke="${strokeColor}" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>

      <!-- Mouth -->
      <path d="M ${mouthXStart} ${mouthY} Q ${CENTER_X} ${mouthControlY} ${mouthXEnd} ${mouthY}" 
            stroke="${strokeColor}" stroke-width="${strokeWidth+2}" fill="none" stroke-linecap="round" />
            
    </svg>
  `;
}
