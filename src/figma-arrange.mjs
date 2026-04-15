import { callMcpTool } from './mcp.mjs';

/**
 * Resolves a list of desired Figma page names to unique ones, creating each
 * page up-front and appending "(2)", "(3)"... if a page with the same name
 * already exists. Returns a map { desired → actual } and creates the pages.
 *
 * Run this ONCE at the start of a batch so every captured frame in the same
 * batch lands on the same newly-created page per module.
 */
export async function resolveAndCreateFreshPages({ fileKey, desiredNames }) {
  const code = `
    const desired = ${JSON.stringify(desiredNames)};
    const existing = new Set(figma.root.children.map(p => p.name));
    const resolved = {};
    const pageIds = {};
    const created = [];
    for (const name of desired) {
      let candidate = name;
      let i = 2;
      while (existing.has(candidate)) {
        candidate = name + " (" + (i++) + ")";
      }
      const page = figma.createPage();
      page.name = candidate;
      existing.add(candidate);
      resolved[name] = candidate;
      pageIds[name] = page.id;
      created.push({ desired: name, actual: candidate, id: page.id });
    }
    return { resolved, pageIds, created };
  `;
  const res = await callMcpTool('use_figma', {
    fileKey,
    code,
    description: `Create fresh Figma pages for batch: ${desiredNames.join(', ')}`,
    skillNames: 'figma-generate-design',
  });
  const text = res?.content?.map((c) => c.text).filter(Boolean).join('\n') ?? '';
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

/**
 * Moves a freshly-captured frame to the desired Figma page, names it, and
 * positions it in a tidy grid. If the page doesn't exist it's created.
 *
 * Grid layout: fills horizontally until the row exceeds `rowWidth` pixels,
 * then wraps to the next row. Each row's y is (rowIndex * rowHeight).
 */
export async function placeCapturedFrame({
  fileKey,
  nodeId,
  newName,
  targetPageName,   // retained for logging only
  targetPageId,     // preferred — the frame was born on this page via nodeId arg
  rowWidth = 14000,
  rowGap = 200,
  colGap = 200,
}) {
  const code = `
    const src = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
    if (!src) throw new Error("Node not found: " + ${JSON.stringify(nodeId)});

    // Prefer locating the page by ID (set by resolveAndCreateFreshPages).
    let page = ${JSON.stringify(targetPageId ?? null)}
      ? await figma.getNodeByIdAsync(${JSON.stringify(targetPageId)})
      : figma.root.children.find(p => p.name === ${JSON.stringify(targetPageName)});
    if (!page || page.type !== 'PAGE') {
      page = figma.createPage();
      page.name = ${JSON.stringify(targetPageName)};
    }

    // The frame should already live on this page (when generate_figma_design
    // was given nodeId=<page.id>). If it isn't — because caller skipped that
    // path — move it now. This avoids touching any other page.
    if (src.parent !== page) {
      page.appendChild(src);
    }
    await figma.setCurrentPageAsync(page);

    src.name = ${JSON.stringify(newName)};

    // Find a clear slot by scanning existing siblings (excluding self).
    // Grid algorithm: walk siblings sorted by y then x, pack new frame into
    // the row with remaining horizontal space, else start a new row.
    const siblings = page.children.filter(c => c.id !== src.id);
    const rows = new Map(); // y -> { maxX, maxH }
    for (const s of siblings) {
      const key = Math.round(s.y / 100) * 100;
      const r = rows.get(key) ?? { y: s.y, maxX: 0, maxH: 0 };
      r.maxX = Math.max(r.maxX, s.x + s.width);
      r.maxH = Math.max(r.maxH, s.height);
      r.y = Math.min(r.y, s.y);
      rows.set(key, r);
    }
    const sortedRows = [...rows.values()].sort((a,b) => a.y - b.y);

    let placed = false;
    for (const r of sortedRows) {
      if (r.maxX + ${colGap} + src.width <= ${rowWidth}) {
        src.x = r.maxX + ${colGap};
        src.y = r.y;
        placed = true;
        break;
      }
    }
    if (!placed) {
      const lastRow = sortedRows[sortedRows.length - 1];
      src.x = 0;
      src.y = lastRow ? (lastRow.y + lastRow.maxH + ${rowGap}) : 0;
    }

    return { id: src.id, pageName: page.name, name: src.name, x: src.x, y: src.y, w: src.width, h: src.height };
  `;

  const res = await callMcpTool('use_figma', {
    fileKey,
    code,
    description: `Place & rename captured frame: ${newName}`,
    skillNames: 'figma-generate-design',
  });

  // Extract structured data from the MCP response if possible.
  const text = res?.content?.map((c) => c.text).filter(Boolean).join('\n') ?? '';
  try { return JSON.parse(text); } catch { return { raw: text }; }
}
