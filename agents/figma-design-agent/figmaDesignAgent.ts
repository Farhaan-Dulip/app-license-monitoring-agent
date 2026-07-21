import { optionalEnv, slugify } from '../../services/runtime/runtime.js';
import { writeGeneratedArtifactViaMcp } from '../../services/mcp/deliveryMcp.js';
import type {
  DesignBrief,
  DesignBriefResults,
  FigmaDesignResults
} from '../../types/types.js';

// Builds the Figma plugin code that can materialize the generated design brief into real Figma nodes.
function buildFigmaPluginCode(brief: DesignBrief): string {
  const sectionData = JSON.stringify(brief.sections, null, 2);
  const palette = JSON.stringify(brief.colorPalette, null, 2);

  return `const sections = ${sectionData};
const palette = ${palette};

async function main() {
  const frame = figma.createFrame();
  frame.name = ${JSON.stringify(brief.brandName)} + ' - Generated Experience';
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
  title.characters = ${JSON.stringify(brief.brandName)};
  title.fills = [{ type: 'SOLID', color: hexToRgb(palette[0] || '#101820') }];
  frame.appendChild(title);

  const subtitle = figma.createText();
  subtitle.name = 'Hero subtitle';
  subtitle.fontName = { family: 'Inter', style: 'Regular' };
  subtitle.fontSize = 28;
  subtitle.characters = ${JSON.stringify(brief.mood)};
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

main();`;
}

// Creates Figma design artifacts from the LLM brief and writes the plugin payload through MCP.
export async function createFigmaDesignFromBrief(input: DesignBriefResults): Promise<FigmaDesignResults> {
  const slug = slugify(input.designBrief.brandName);
  const designSpecPath = `generated-artifacts/figma/${slug}-design-spec.json`;
  const pluginPayloadPath = `generated-artifacts/figma/${slug}-plugin-code.js`;
  const designSystem = {
    palette: input.designBrief.colorPalette,
    typography: input.designBrief.typography,
    spacingScale: ['8px', '12px', '16px', '24px', '32px', '48px', '72px', '96px'],
    cornerRadius: ['8px', '12px', '20px', '28px'],
    elevation: ['subtle card shadow', 'hero media shadow', 'sticky nav blur']
  };
  const layoutBlueprint = {
    desktop: '1440px responsive experience with clear navigation, high-impact hero, intentional section hierarchy, supporting content blocks, conversion-focused panels, and a polished footer.',
    tablet: 'Selective two-column layouts that collapse gracefully while preserving hierarchy and spacing rhythm.',
    mobile: 'Single-column flow with readable typography, full-width CTAs, stacked cards, and no content overlap.',
    qualityBar: 'The generated React implementation should feel production-ready and domain-appropriate, not a wireframe or plain form.'
  };
  const interactionNotes = [
    'Primary CTA needs hover, active, and focus-visible states.',
    'Inputs/selects/buttons must be custom styled if the design includes a form.',
    'Cards should have intentional spacing, hierarchy, and responsive dimensions.',
    'Avoid browser-default controls and sparse one-panel layouts.'
  ];
  const nodes = [
    {
      name: 'Landing Page Frame',
      type: 'frame' as const,
      description: `${input.designBrief.pageType} desktop frame with responsive design guidance, brand palette, typographic hierarchy, and conversion-focused content sections.`
    },
    ...input.designBrief.sections.map((section) => ({
      name: section,
      type: 'section' as const,
      description: `High-fidelity section for ${section}. Include layout intent, visual hierarchy, spacing, CTA behavior, and responsive treatment.`
    }))
  ];

  await writeGeneratedArtifactViaMcp({
    path: designSpecPath,
    content: JSON.stringify({ brief: input.designBrief, designSystem, layoutBlueprint, interactionNotes, nodes }, null, 2)
  });
  await writeGeneratedArtifactViaMcp({
    path: pluginPayloadPath,
    content: buildFigmaPluginCode(input.designBrief)
  });

  return {
    ...input,
    figmaDesign: {
      fileName: `${input.designBrief.brandName} Landing Page`,
      frameName: `${input.designBrief.brandName} - Generated Experience`,
      figmaUrl: optionalEnv('FIGMA_FILE_URL') ?? null,
      pluginPayloadPath,
      designSpecPath,
      nodes
    }
  };
}
