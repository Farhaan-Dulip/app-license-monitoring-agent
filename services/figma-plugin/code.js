figma.showUI(__html__, { width: 440, height: 360 });

figma.ui.onmessage = async (message) => {
  if (message.type !== 'create-design') {
    return;
  }

  try {
    const node = await createDesignFromAgentSession(message.baseUrl, message.requestId);
    figma.ui.postMessage({
      type: 'success',
      message: `Created live Figma frame "${node.name}" with node id ${node.id}.`
    });
  } catch (error) {
    figma.ui.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error)
    });
  }
};

async function createDesignFromAgentSession(baseUrl, requestId) {
  const cleanBaseUrl = String(baseUrl || '').replace(/\/$/, '');
  if (!cleanBaseUrl) {
    throw new Error('Enter the Railway or local app base URL.');
  }

  const cleanRequestId = String(requestId || 'latest').trim() || 'latest';
  const response = await fetch(`${cleanBaseUrl}/api/figma/session/${encodeURIComponent(cleanRequestId)}`);
  const payload = await response.json();

  if (!response.ok || payload.status !== 'ok') {
    throw new Error(payload.message || `Agent returned ${response.status}.`);
  }

  const brief = payload.designSpec.brief;
  const palette = brief.colorPalette || ['#101820', '#f7efe2', '#c94f3d', '#d7a86e', '#355e4b'];

  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });

  const frame = figma.createFrame();
  frame.name = `${brief.brandName} - AI Generated Landing Page`;
  frame.resize(1440, 1800);
  frame.layoutMode = 'VERTICAL';
  frame.primaryAxisSizingMode = 'AUTO';
  frame.counterAxisSizingMode = 'FIXED';
  frame.itemSpacing = 32;
  frame.paddingTop = 56;
  frame.paddingRight = 72;
  frame.paddingBottom = 56;
  frame.paddingLeft = 72;
  frame.fills = [{ type: 'SOLID', color: hexToRgb(palette[1]) }];

  const hero = figma.createFrame();
  hero.name = 'Hero';
  hero.resize(1296, 620);
  hero.layoutMode = 'VERTICAL';
  hero.primaryAxisSizingMode = 'AUTO';
  hero.counterAxisSizingMode = 'FIXED';
  hero.itemSpacing = 22;
  hero.paddingTop = 72;
  hero.paddingRight = 72;
  hero.paddingBottom = 72;
  hero.paddingLeft = 72;
  hero.cornerRadius = 28;
  hero.fills = [{ type: 'SOLID', color: hexToRgb(palette[0]) }];

  hero.appendChild(createText('Page type', brief.pageType.toUpperCase(), 18, 'Bold', palette[3]));
  hero.appendChild(createText('Brand headline', brief.brandName, 88, 'Bold', palette[1]));
  hero.appendChild(createText('Hero copy', `${brief.mood} dining for ${brief.audience}.`, 30, 'Regular', '#ffffff'));
  hero.appendChild(createButton(brief.primaryCta, palette[2]));
  frame.appendChild(hero);

  const sectionGrid = figma.createFrame();
  sectionGrid.name = 'Generated Sections';
  sectionGrid.resize(1296, 1);
  sectionGrid.layoutMode = 'VERTICAL';
  sectionGrid.primaryAxisSizingMode = 'AUTO';
  sectionGrid.counterAxisSizingMode = 'FIXED';
  sectionGrid.itemSpacing = 18;
  sectionGrid.fills = [];

  for (const sectionName of brief.sections || []) {
    sectionGrid.appendChild(createSectionCard(sectionName, palette));
  }

  frame.appendChild(sectionGrid);
  figma.currentPage.appendChild(frame);
  figma.viewport.scrollAndZoomIntoView([frame]);

  return frame;
}

function createText(name, characters, fontSize, style, color) {
  const text = figma.createText();
  text.name = name;
  text.fontName = { family: 'Inter', style };
  text.fontSize = fontSize;
  text.characters = characters;
  text.fills = [{ type: 'SOLID', color: hexToRgb(color) }];
  text.textAutoResize = 'WIDTH_AND_HEIGHT';
  return text;
}

function createButton(label, color) {
  const button = figma.createFrame();
  button.name = 'Primary CTA';
  button.layoutMode = 'HORIZONTAL';
  button.primaryAxisSizingMode = 'AUTO';
  button.counterAxisSizingMode = 'AUTO';
  button.paddingTop = 14;
  button.paddingRight = 22;
  button.paddingBottom = 14;
  button.paddingLeft = 22;
  button.cornerRadius = 999;
  button.fills = [{ type: 'SOLID', color: hexToRgb(color) }];
  button.appendChild(createText('CTA label', label, 18, 'Bold', '#ffffff'));
  return button;
}

function createSectionCard(sectionName, palette) {
  const card = figma.createFrame();
  card.name = sectionName;
  card.resize(1296, 190);
  card.layoutMode = 'VERTICAL';
  card.primaryAxisSizingMode = 'AUTO';
  card.counterAxisSizingMode = 'FIXED';
  card.itemSpacing = 12;
  card.paddingTop = 28;
  card.paddingRight = 28;
  card.paddingBottom = 28;
  card.paddingLeft = 28;
  card.cornerRadius = 22;
  card.fills = [{ type: 'SOLID', color: hexToRgb('#ffffff') }];
  card.strokes = [{ type: 'SOLID', color: hexToRgb('#e6dfd1') }];
  card.strokeWeight = 1;
  card.appendChild(createText('Section title', sectionName, 32, 'Bold', palette[0]));
  card.appendChild(createText('Section copy', 'Generated from the LLM design brief and ready for visual refinement.', 20, 'Regular', palette[4]));
  return card;
}

function hexToRgb(hex) {
  const clean = String(hex || '#101820').replace('#', '');
  const value = parseInt(clean.length === 3 ? clean.split('').map((char) => char + char).join('') : clean, 16);
  return {
    r: ((value >> 16) & 255) / 255,
    g: ((value >> 8) & 255) / 255,
    b: (value & 255) / 255
  };
}
