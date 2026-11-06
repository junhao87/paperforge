// Test fixture for the precise Word layout used by PDF -> Word.
// Run with the Codex bundled Node runtime; optional arg is the output DOCX.
const fs = require('fs');
const path = require('path');
const docx = require(path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'docx'));
const JSZip = require('../vendor/jszip.min.js');
const output = process.argv[2] || '/tmp/paperforge-pages.docx';
const mode = process.argv[3] || 'inline';
const img = fs.readFileSync(path.join(__dirname, '../assets/paperforge-icon-192.png'));

async function run() {
  const paragraphs = [];
  const anchors = [];
  for (let n = 0; n < 3; n++) {
    if (n && mode !== 'inline' && mode !== 'sections') {
      paragraphs.push(new docx.Paragraph({text: '', pageBreakBefore: true,
        spacing: {before: 0, after: 0, line: mode === 'separate' ? 20 : 1, lineRule: 'exact'}}));
      anchors.push(false);
    }
    paragraphs.push(new docx.Paragraph({
      pageBreakBefore: n > 0 && mode === 'inline',
      children: [new docx.ImageRun({type: 'png', data: img, transformation: {width: 794, height: 1123}})],
      spacing: {before: 0, after: 0},
    }));
    anchors.push(true);
  }
  const pageProps = {page: {size: {width: 11906, height: 16838},
    margin: {top: 0, bottom: 0, left: 0, right: 0}}};
  const sectionDefinitions = mode === 'sections'
    ? paragraphs.map((p) => ({properties: {...pageProps, type: docx.SectionType.NEXT_PAGE}, children: [p]}))
    : [{properties: pageProps, children: paragraphs}];
  const document = new docx.Document({sections: sectionDefinitions});
  const zip = await JSZip.loadAsync(await docx.Packer.toBuffer(document));
  let xml = await zip.file('word/document.xml').async('string');
  let anchored = 0;
  xml = xml.replace(/<w:p>.*?<\/w:p>/gs, (paragraph) => {
    if (!paragraph.includes('<w:drawing>')) return paragraph;
    anchored++;
    return paragraph.replace('<w:pPr>', '<w:pPr><w:framePr w:x="0" w:y="0" w:w="11906" w:h="16838" w:hAnchor="page" w:vAnchor="page" w:wrap="none"/>');
  });
  if (anchored !== 3) throw new Error('Failed to anchor three pages: ' + anchored);
  zip.file('word/document.xml', xml);
  fs.writeFileSync(output, await zip.generateAsync({type: 'nodebuffer'}));
  process.stdout.write(output + '\n');
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
