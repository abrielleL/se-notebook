// Brand values shared by every Word export (POV, account summary, deal review).
// Every typography / color / spacing value below is extracted from pov-template.docx
// (word/styles.xml, word/document.xml, word/theme/theme1.xml) so the exported POV
// matches the template. See `unpacked-template/` for the source values.
const FONT = 'Simplon Norm'; // Normal style rFonts (ascii/hAnsi); 'Simplon Norm Medium' is used for headings/emphasis in the template

// Theme palette (theme1.xml clrScheme) + style colors (styles.xml).
const C = {
  navy: '111F42',     // accent1 — heading1 text + cover hero fill
  navyDk: '0C1731',   // Heading1 base color (accent1 shade BF)
  blue: '2672FB',     // accent4 — heading rule, section numbers, heading2 text
  blueLink: '1F56BC', // Hyperlink color
  white: 'FFFFFF',    // background1/2 (lt1 / lt2)
  ink: '000000',      // pBody text color
  dark: '000000',     // alias for body runs (was 1A1A1A)
  heading3: '191918', // heading3 (headings) color
  emphasis: '282828', // Emphasis color
  lightBlue: '86A7E8',// accent2 tint used for cover sub-labels
  // The template defines no tables; these are brand-consistent choices:
  headerFill: '111F42', // table header row — navy, matches heading color
  greyRow: 'EEF2FB',    // zebra row — light tint of accent blue
  border: '000000',     // TableGrid border (single, sz 4, color auto -> black)
  green: '1F7A1F', greenScope: '1F7A1F', redScope: '791F1F', redUrgent: 'E24B4A',
  muted: '6B6B6B', lightGrey: 'BFBFBF', internal: 'C00000'
};

// Font sizes in points, taken from styles.xml / document.xml sz values (sz / 2 = pt).
const PT = {
  body: 11,        // pBody (sz 22)
  small: 9.5,      // p3_small (sz 19)
  bullet: 10.5,    // bullet1 (sz 21)
  h1: 20,          // heading1headings (sz 40)
  h2: 12.5,        // heading2 (sz 25)
  h3: 11.5,        // heading3 (sz 23)
  coverTitle: 48,  // cover title (sz 96)
  coverSub: 28,    // cover subtitle (sz 56)
  coverDate: 16,   // cover date (sz 32)
  provided: 18,    // "Provided for/by" (sz 36)
  caption: 9,      // Caption (sz 18)
  footer: 8        // Footer (sz 16)
};

const half = (pt) => Math.round(pt * 2); // docx sizes are half-points

module.exports = { FONT, C, PT, half };
