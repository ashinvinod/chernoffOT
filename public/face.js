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
  bodyColor = "#3b82f6" // Default Blue
}) {
  const VIEWBOX_WIDTH = 200;
  const VIEWBOX_HEIGHT = 240; // Reduced height (was 320)
  const CENTER_X = VIEWBOX_WIDTH / 2;
  const HEAD_CY = 100; // Head Center Y

  // --- Comic Colors ---
  let fill;
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

  // Brows (relative to Head Center)
  const browYInner = HEAD_CY - 30 + (1 - browAngle) * 20; 
  const browYOuter = HEAD_CY - 30 - (1 - browAngle) * 10; 

  // Eyes
  const eyeRadiusX = 12 + eyeSize * 10; 
  const eyeRadiusY = 12 + eyeSize * 15; 
  const pupilRadius = 4 + eyeSize * 3; 
  const eyeY = HEAD_CY - 5;

  // Mouth
  const mouthY = HEAD_CY + 45;
  const mouthWidth = 60;
  const mouthXStart = CENTER_X - mouthWidth / 2;
  const mouthXEnd = CENTER_X + mouthWidth / 2;
  
  // Exaggerate curve
  const mouthCurve = (mouth - 0.5) * 80;
  const mouthControlY = mouthY + mouthCurve;

  // Sweat Drop (if low health) - Adjusted position
  let extras = "";
  if (health < 0.3) {
      extras += `
        <path d="M ${CENTER_X + 60} ${HEAD_CY - 50} Q ${CENTER_X + 50} ${HEAD_CY - 60} ${CENTER_X + 60} ${HEAD_CY - 70} Q ${CENTER_X + 70} ${HEAD_CY - 60} ${CENTER_X + 60} ${HEAD_CY - 50} Z" fill="#60a5fa" stroke="black" stroke-width="3" />
        <path d="M ${CENTER_X - 60} ${HEAD_CY - 40} Q ${CENTER_X - 70} ${HEAD_CY - 50} ${CENTER_X - 60} ${HEAD_CY - 60} Q ${CENTER_X - 50} ${HEAD_CY - 50} ${CENTER_X - 60} ${HEAD_CY - 40} Z" fill="#60a5fa" stroke="black" stroke-width="3" />
      `;
  }

  return `
    <svg viewBox="0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}" xmlns="http://www.w3.org/2000/svg" class="chernoff-face">
      <defs>
        <pattern id="dots" x="0" y="0" width="10" height="10" patternUnits="userSpaceOnUse">
          <circle cx="2" cy="2" r="1.5" fill="#000" opacity="0.1"/>
        </pattern>
      </defs>

      <!-- Body (Static) -->
      <!-- Shoulders and Chest -->
      <path d="M ${CENTER_X - 50} ${HEAD_CY + 80} 
               Q ${CENTER_X - 70} ${HEAD_CY + 180} ${CENTER_X - 70} ${VIEWBOX_HEIGHT}
               L ${CENTER_X + 70} ${VIEWBOX_HEIGHT}
               Q ${CENTER_X + 70} ${HEAD_CY + 180} ${CENTER_X + 50} ${HEAD_CY + 80}
               Z" 
            fill="${bodyColor}" stroke="${strokeColor}" stroke-width="${strokeWidth}" />
            
      <!-- Texture Overlay on Body -->
      <path d="M ${CENTER_X - 50} ${HEAD_CY + 80} 
               Q ${CENTER_X - 70} ${HEAD_CY + 180} ${CENTER_X - 70} ${VIEWBOX_HEIGHT}
               L ${CENTER_X + 70} ${VIEWBOX_HEIGHT}
               Q ${CENTER_X + 70} ${HEAD_CY + 180} ${CENTER_X + 50} ${HEAD_CY + 80}
               Z" 
            fill="url(#dots)" opacity="1" pointer-events="none" />

      <!-- Collar / Shirt Detail -->
      <path d="M ${CENTER_X - 25} ${HEAD_CY + 85} L ${CENTER_X} ${HEAD_CY + 115} L ${CENTER_X + 25} ${HEAD_CY + 85}"
            stroke="${strokeColor}" stroke-width="3" fill="white" />

      <!-- Head Shadow (Offset) -->
      <circle cx="${CENTER_X + 5}" cy="${HEAD_CY + 5}" r="90" fill="black" />

      <!-- Head Base -->
      <circle cx="${CENTER_X}" cy="${HEAD_CY}" r="90" fill="${fill}" stroke="${strokeColor}" stroke-width="${strokeWidth}" />
      
      <!-- Texture Overlay -->
      <circle cx="${CENTER_X}" cy="${HEAD_CY}" r="90" fill="url(#dots)" opacity="1" pointer-events="none" />

      <!-- Shine/Highlight -->
      <path d="M ${CENTER_X + 40} ${HEAD_CY - 50} Q ${CENTER_X + 60} ${HEAD_CY - 60} ${CENTER_X + 70} ${HEAD_CY - 30}" 
            stroke="white" stroke-width="8" stroke-linecap="round" fill="none" opacity="0.6" />

      <!-- Extras -->
      ${extras}

      <!-- Ears -->
      <path d="M ${CENTER_X - 90} ${HEAD_CY - 10} Q ${CENTER_X - 100} ${HEAD_CY} ${CENTER_X - 90} ${HEAD_CY + 10}" fill="${fill}" stroke="${strokeColor}" stroke-width="${strokeWidth}" />
      <path d="M ${CENTER_X + 90} ${HEAD_CY - 10} Q ${CENTER_X + 100} ${HEAD_CY} ${CENTER_X + 90} ${HEAD_CY + 10}" fill="${fill}" stroke="${strokeColor}" stroke-width="${strokeWidth}" />

      <!-- Eyebrows -->
      <!-- Left -->
      <path d="M 60 ${browYOuter} Q 75 ${browYInner - 10} 90 ${browYInner}" 
            stroke="${strokeColor}" stroke-width="${strokeWidth+2}" fill="none" stroke-linecap="round" />
      <!-- Right -->
      <path d="M 140 ${browYOuter} Q 125 ${browYInner - 10} 110 ${browYInner}" 
            stroke="${strokeColor}" stroke-width="${strokeWidth+2}" fill="none" stroke-linecap="round" />

      <!-- Eyes -->
      <!-- Left -->
      <ellipse cx="75" cy="${eyeY}" rx="${eyeRadiusX}" ry="${eyeRadiusY}" fill="white" stroke="${strokeColor}" stroke-width="4" />
      <circle cx="75" cy="${eyeY}" r="${pupilRadius}" fill="black" />
      
      <!-- Right -->
      <ellipse cx="125" cy="${eyeY}" rx="${eyeRadiusX}" ry="${eyeRadiusY}" fill="white" stroke="${strokeColor}" stroke-width="4" />
      <circle cx="125" cy="${eyeY}" r="${pupilRadius}" fill="black" />

      <!-- Nose -->
      <path d="M ${CENTER_X} ${HEAD_CY + 5} L ${CENTER_X - 10} ${HEAD_CY + 25} L ${CENTER_X + 5} ${HEAD_CY + 20}" stroke="${strokeColor}" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>

      <!-- Mouth -->
      <path d="M ${mouthXStart} ${mouthY} Q ${CENTER_X} ${mouthControlY} ${mouthXEnd} ${mouthY}" 
            stroke="${strokeColor}" stroke-width="${strokeWidth+2}" fill="none" stroke-linecap="round" />
            
    </svg>
  `;
}
