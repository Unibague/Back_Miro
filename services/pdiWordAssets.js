const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');
const {
    Paragraph,
    ImageRun,
    Header,
    AlignmentType,
    HorizontalPositionRelativeFrom,
    VerticalPositionRelativeFrom,
} = require('docx');

const ASSETS_DIR = path.join(__dirname, '../assets/pdi');
const FRONT_PUBLIC_ASSETS_DIR = path.resolve(__dirname, '../../Front_Miro/public/assets');
const PAGE_WIDTH_PX = 794;
const DEFAULT_PAGE_HEIGHT_PX = Math.round(PAGE_WIDTH_PX * 3300 / 2550);
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const HEADER_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header';
const FOOTER_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer';
const IMAGE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const HEADER_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml';
const FOOTER_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml';
const MEDIA_CONTENT_TYPES = {
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png',
};

function resolveConfiguredPath(value) {
    const candidate = String(value || '').trim();
    if (!candidate) return null;
    return path.isAbsolute(candidate)
        ? candidate
        : path.resolve(__dirname, '..', candidate);
}

function findFirstExisting(paths = []) {
    for (const candidate of paths) {
        if (candidate && fs.existsSync(candidate)) return candidate;
    }
    return null;
}

function getMembreteDocxPath() {
    const configuredPath = resolveConfiguredPath(process.env.PDI_MEMBRETE_DOCX_PATH);
    return findFirstExisting([
        configuredPath,
        path.join(FRONT_PUBLIC_ASSETS_DIR, 'Membrete PDI.docx'),
        path.join(ASSETS_DIR, 'Membrete PDI.docx'),
        path.join(ASSETS_DIR, 'membrete-pdi.docx'),
        path.join(ASSETS_DIR, 'membrete.docx'),
    ]);
}

function hasMembreteDocxTemplate() {
    return Boolean(getMembreteDocxPath());
}

function getImageType(filePath, buffer) {
    const ext = path.extname(filePath || '').toLowerCase();
    if (ext === '.png') return 'png';
    if (ext === '.jpg' || ext === '.jpeg') return 'jpg';
    if (buffer?.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
    if (buffer?.[0] === 0xff && buffer?.[1] === 0xd8) return 'jpg';
    return null;
}

function getPngSize(buffer) {
    if (!buffer || buffer.length < 24) return null;
    const isPng = buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (!isPng) return null;
    return {
        width: buffer.readUInt32BE(16),
        height: buffer.readUInt32BE(20),
    };
}

function getJpegSize(buffer) {
    if (!buffer || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

    let offset = 2;
    while (offset < buffer.length) {
        if (buffer[offset] !== 0xff) {
            offset += 1;
            continue;
        }

        while (buffer[offset] === 0xff) offset += 1;
        const marker = buffer[offset];
        offset += 1;

        if (marker === 0xd9 || marker === 0xda) break;
        if (offset + 2 > buffer.length) break;

        const length = buffer.readUInt16BE(offset);
        if (length < 2 || offset + length > buffer.length) break;

        const isStartOfFrame =
            (marker >= 0xc0 && marker <= 0xc3) ||
            (marker >= 0xc5 && marker <= 0xc7) ||
            (marker >= 0xc9 && marker <= 0xcb) ||
            (marker >= 0xcd && marker <= 0xcf);

        if (isStartOfFrame && length >= 7) {
            return {
                width: buffer.readUInt16BE(offset + 5),
                height: buffer.readUInt16BE(offset + 3),
            };
        }

        offset += length;
    }

    return null;
}

function getImageSize(buffer, type) {
    if (type === 'png') return getPngSize(buffer);
    if (type === 'jpg') return getJpegSize(buffer);
    return getPngSize(buffer) || getJpegSize(buffer);
}

function readScaledImage(filePath, fallbackHeight = DEFAULT_PAGE_HEIGHT_PX) {
    if (!filePath || !fs.existsSync(filePath)) return null;

    const data = fs.readFileSync(filePath);
    const type = getImageType(filePath, data);
    if (!type) return null;

    const size = getImageSize(data, type);
    const height = size?.width && size?.height
        ? Math.round(PAGE_WIDTH_PX * size.height / size.width)
        : fallbackHeight;

    return {
        data,
        type,
        width: PAGE_WIDTH_PX,
        height,
        sourcePath: filePath,
    };
}

function getAssetImage({ envKey, candidates, fallbackHeight }) {
    const configuredPath = resolveConfiguredPath(process.env[envKey]);
    const filePath = findFirstExisting([
        configuredPath,
        ...candidates.flatMap((name) => [
            path.join(FRONT_PUBLIC_ASSETS_DIR, name),
            path.join(ASSETS_DIR, name),
        ]),
    ]);

    return readScaledImage(filePath, fallbackHeight);
}

function getMembreteImage() {
    if (hasMembreteDocxTemplate()) return null;
    return getAssetImage({
        envKey: 'PDI_MEMBRETE_PATH',
        candidates: [
            'membrete-header.jpeg',
            'membrete-header.jpg',
            'membrete-header.png',
            'membrete.jpeg',
            'membrete.jpg',
            'membrete.png',
        ],
        fallbackHeight: DEFAULT_PAGE_HEIGHT_PX,
    });
}

function getPortadaImage() {
    return getAssetImage({
        envKey: 'PDI_PORTADA_PATH',
        candidates: [
            'Portada.jpeg',
            'Portada.jpg',
            'Portada.png',
            'portada.jpeg',
            'portada.jpg',
            'portada.png',
        ],
        fallbackHeight: DEFAULT_PAGE_HEIGHT_PX,
    });
}

function escapeXmlAttr(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function parseRelationships(relsXml = '') {
    return [...relsXml.matchAll(/<Relationship\b([^>]*?)\/>/g)].map((match) => {
        const attrs = match[1];
        const get = (name) => attrs.match(new RegExp(`${name}="([^"]*)"`, 'i'))?.[1] || '';
        return {
            raw: match[0],
            id: get('Id'),
            type: get('Type'),
            target: get('Target'),
        };
    });
}

function getNextRelationshipId(relsXml = '') {
    const ids = [...relsXml.matchAll(/\bId="rId(\d+)"/g)]
        .map((match) => Number(match[1]))
        .filter(Number.isFinite);
    return (ids.length ? Math.max(...ids) : 0) + 1;
}

function appendRelationship(relsXml, relationship) {
    const entry = `<Relationship Id="${escapeXmlAttr(relationship.id)}" Type="${escapeXmlAttr(relationship.type)}" Target="${escapeXmlAttr(relationship.target)}"/>`;
    if (relsXml.includes('</Relationships>')) {
        return relsXml.replace('</Relationships>', `${entry}</Relationships>`);
    }
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${RELS_NS}">${entry}</Relationships>`;
}

function ensureContentTypeOverride(xml, partName, contentType) {
    if (xml.includes(`PartName="${partName}"`)) return xml;
    const entry = `<Override PartName="${escapeXmlAttr(partName)}" ContentType="${escapeXmlAttr(contentType)}"/>`;
    return xml.replace('</Types>', `${entry}</Types>`);
}

function ensureDefaultContentType(xml, extension, contentType) {
    const normalized = String(extension || '').replace(/^\./, '').toLowerCase();
    if (!normalized || xml.includes(`Extension="${normalized}"`)) return xml;
    const entry = `<Default Extension="${escapeXmlAttr(normalized)}" ContentType="${escapeXmlAttr(contentType)}"/>`;
    return xml.replace('</Types>', `${entry}</Types>`);
}

function updateMediaTargetsInPartRels({ templateZip, targetZip, relsPath, mediaTargetMap, contentTypes }) {
    const relsFile = templateZip.file(relsPath);
    if (!relsFile) return contentTypes;

    let relsXml = relsFile.asText();
    const relationships = parseRelationships(relsXml);

    for (const rel of relationships) {
        if (rel.type !== IMAGE_REL_TYPE || !rel.target || rel.target.startsWith('http')) continue;

        const sourcePath = `word/${rel.target.replace(/^\/?word\//, '')}`;
        const sourceFile = templateZip.file(sourcePath);
        if (!sourceFile) continue;

        if (!mediaTargetMap.has(rel.target)) {
            const ext = path.extname(rel.target).toLowerCase() || '.jpeg';
            const baseName = path.basename(rel.target, ext).replace(/[^a-zA-Z0-9_-]/g, '_') || 'image';
            let candidate = `media/pdi_membrete_${baseName}${ext}`;
            let index = 1;
            while (targetZip.file(`word/${candidate}`)) {
                candidate = `media/pdi_membrete_${baseName}_${index}${ext}`;
                index += 1;
            }
            targetZip.file(`word/${candidate}`, sourceFile.asNodeBuffer());
            mediaTargetMap.set(rel.target, candidate);

            const contentType = MEDIA_CONTENT_TYPES[ext.replace('.', '')];
            if (contentType) {
                contentTypes = ensureDefaultContentType(contentTypes, ext, contentType);
            }
        }

        relsXml = relsXml.replace(`Target="${rel.target}"`, `Target="${mediaTargetMap.get(rel.target)}"`);
    }

    targetZip.file(relsPath, relsXml);
    return contentTypes;
}

function getTemplateSectPr(templateZip) {
    const documentXml = templateZip.file('word/document.xml')?.asText();
    if (!documentXml) return null;
    const sections = [...documentXml.matchAll(/<w:sectPr[\s\S]*?<\/w:sectPr>/g)].map((match) => match[0]);
    return sections[sections.length - 1] || null;
}

function ensureTitlePageSection(sectPr) {
    if (!sectPr || !sectPr.includes('w:type="first"') || sectPr.includes('<w:titlePg')) return sectPr;
    if (sectPr.includes('<w:pgSz')) return sectPr.replace('<w:pgSz', '<w:titlePg/><w:pgSz');
    return sectPr.replace('</w:sectPr>', '<w:titlePg/></w:sectPr>');
}

function applySectionTemplate(documentXml, sectPr) {
    if (!documentXml || !sectPr) return documentXml;
    const sectionRegex = /<w:sectPr[\s\S]*?<\/w:sectPr>/g;
    const matches = [...documentXml.matchAll(sectionRegex)];
    if (matches.length) {
        const last = matches[matches.length - 1];
        return `${documentXml.slice(0, last.index)}${sectPr}${documentXml.slice(last.index + last[0].length)}`;
    }
    return documentXml.replace('</w:body>', `${sectPr}</w:body>`);
}

function applyMembreteDocxTemplate(buffer) {
    const templatePath = getMembreteDocxPath();
    if (!templatePath || !buffer) return buffer;

    const targetZip = new PizZip(buffer);
    const templateZip = new PizZip(fs.readFileSync(templatePath));
    const templateRelsXml = templateZip.file('word/_rels/document.xml.rels')?.asText();
    const targetRelsPath = 'word/_rels/document.xml.rels';
    let targetRelsXml = targetZip.file(targetRelsPath)?.asText()
        || `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${RELS_NS}"></Relationships>`;
    let contentTypes = targetZip.file('[Content_Types].xml')?.asText();
    let sectPr = getTemplateSectPr(templateZip);

    if (!templateRelsXml || !contentTypes || !sectPr) return buffer;

    const templateRelationships = parseRelationships(templateRelsXml)
        .filter((rel) => (rel.type === HEADER_REL_TYPE || rel.type === FOOTER_REL_TYPE) && rel.target);
    if (!templateRelationships.length) return buffer;

    const idMap = new Map();
    const mediaTargetMap = new Map();
    let nextRelationshipId = getNextRelationshipId(targetRelsXml);

    for (const rel of templateRelationships) {
        const target = rel.target.replace(/^\/?word\//, '');
        const sourcePath = `word/${target}`;
        const sourceFile = templateZip.file(sourcePath);
        if (!sourceFile) continue;

        targetZip.file(sourcePath, sourceFile.asText());
        idMap.set(rel.id, `rId${nextRelationshipId++}`);
        targetRelsXml = appendRelationship(targetRelsXml, {
            id: idMap.get(rel.id),
            type: rel.type,
            target,
        });

        const partName = `/word/${target}`;
        contentTypes = ensureContentTypeOverride(
            contentTypes,
            partName,
            rel.type === HEADER_REL_TYPE ? HEADER_CONTENT_TYPE : FOOTER_CONTENT_TYPE
        );

        const relsPath = `word/_rels/${path.basename(target)}.rels`;
        contentTypes = updateMediaTargetsInPartRels({
            templateZip,
            targetZip,
            relsPath,
            mediaTargetMap,
            contentTypes,
        });
    }

    for (const [oldId, newId] of idMap.entries()) {
        sectPr = sectPr.replace(new RegExp(`r:id="${oldId}"`, 'g'), `r:id="${newId}"`);
    }
    sectPr = ensureTitlePageSection(sectPr);

    const documentXml = targetZip.file('word/document.xml')?.asText();
    if (!documentXml) return buffer;

    targetZip.file('word/document.xml', applySectionTemplate(documentXml, sectPr));
    targetZip.file(targetRelsPath, targetRelsXml);
    targetZip.file('[Content_Types].xml', contentTypes);

    return targetZip.generate({ type: 'nodebuffer' });
}

function buildMembreteHeader() {
    const membrete = getMembreteImage();
    if (!membrete) return null;

    return new Header({
        children: [
            new Paragraph({
                children: [
                    new ImageRun({
                        type: membrete.type,
                        data: membrete.data,
                        transformation: { width: membrete.width, height: membrete.height },
                        floating: {
                            horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: 0 },
                            verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: 0 },
                            behindDocument: true,
                            allowOverlap: true,
                        },
                    }),
                ],
            }),
        ],
    });
}

function buildPortadaSection() {
    const portada = getPortadaImage();
    if (!portada) return null;

    return {
        properties: { page: { margin: { top: 0, right: 0, bottom: 0, left: 0, header: 0 } } },
        children: [
            new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { before: 0, after: 0 },
                children: [
                    new ImageRun({
                        type: portada.type,
                        data: portada.data,
                        transformation: { width: portada.width, height: portada.height },
                    }),
                ],
            }),
        ],
    };
}

module.exports = {
    buildMembreteHeader,
    buildPortadaSection,
    applyMembreteDocxTemplate,
    hasMembreteDocxTemplate,
};
