const sections = [
  "Hero Section with a catchy tagline and stunning visuals of dishes",
  "About Us section detailing the restaurant's story and mission",
  "Menu Preview showcasing selected dishes with descriptions and prices",
  "Reservation section highlighting booking options",
  "Customer Testimonials for social proof",
  "Contact Information with a contact form and map",
  "Footer section with social media links and additional website links"
];
const palette = [
  "#FF5733",
  "#FFC300",
  "#C70039",
  "#581845",
  "#900C3F"
];

async function main() {
  const frame = figma.createFrame();
  frame.name = "HotPot" + ' - Generated Experience';
  frame.resize(1440, 2200);
  frame.fills = [{ type: 'SOLID', color: hexToRgb(palette[1] || '#f7efe2') }];
  frame.layoutMode = 'VERTICAL';
  frame.itemSpacing = 32;
  frame.paddingTop = 64;
  frame.paddingRight = 80;
  frame.paddingBottom = 64;
  frame.paddingLeft = 80;

  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });

  const title = figma.createText();
  title.name = 'Hero title';
  title.fontName = { family: 'Inter', style: 'Bold' };
  title.fontSize = 72;
  title.characters = "HotPot";
  title.fills = [{ type: 'SOLID', color: hexToRgb(palette[0] || '#101820') }];
  frame.appendChild(title);

  const subtitle = figma.createText();
  subtitle.name = 'Hero subtitle';
  subtitle.fontName = { family: 'Inter', style: 'Regular' };
  subtitle.fontSize = 28;
  subtitle.characters = "modern and inviting";
  subtitle.fills = [{ type: 'SOLID', color: hexToRgb(palette[4] || '#355e4b') }];
  frame.appendChild(subtitle);

  for (const sectionName of sections) {
    const section = figma.createFrame();
    section.name = sectionName;
    section.resize(1280, 220);
    section.fills = [{ type: 'SOLID', color: hexToRgb('#ffffff') }];
    section.cornerRadius = 24;
    section.paddingTop = 32;
    section.paddingRight = 32;
    section.paddingBottom = 32;
    section.paddingLeft = 32;

    const label = figma.createText();
    label.fontName = { family: 'Inter', style: 'Bold' };
    label.fontSize = 28;
    label.characters = sectionName;
    label.fills = [{ type: 'SOLID', color: hexToRgb(palette[0] || '#101820') }];
    section.appendChild(label);
    frame.appendChild(section);
  }

  figma.currentPage.appendChild(frame);
  figma.viewport.scrollAndZoomIntoView([frame]);
  figma.closePlugin('Design generated from delivery brief.');
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const value = parseInt(clean, 16);
  return {
    r: ((value >> 16) & 255) / 255,
    g: ((value >> 8) & 255) / 255,
    b: (value & 255) / 255
  };
}

main();