import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';

async function addFolderToZip(zip: JSZip, folderPath: string, rootPath: string, exclude: string[] = []) {
  const entries = fs.readdirSync(folderPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(folderPath, entry.name);
    const relPath = path.relative(rootPath, fullPath);

    if (exclude.some(ex => relPath.startsWith(ex) || entry.name === ex)) {
      continue;
    }

    if (entry.isDirectory()) {
      await addFolderToZip(zip, fullPath, rootPath, exclude);
    } else {
      const content = fs.readFileSync(fullPath);
      zip.file(relPath.replace(/\\/g, '/'), content);
    }
  }
}

async function createZips() {
  if (!fs.existsSync('public')) {
    fs.mkdirSync('public', { recursive: true });
  }

  // 1. Create dist zip (Ready to deploy directly to Netlify!)
  if (fs.existsSync('dist')) {
    const distZip = new JSZip();
    await addFolderToZip(distZip, 'dist', 'dist');
    const distBuffer = await distZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    fs.writeFileSync(path.join('public', 'dongfeng-vigo-dist.zip'), distBuffer);
    console.log('Created public/dongfeng-vigo-dist.zip (Size:', (distBuffer.length / 1024).toFixed(1), 'KB)');
  }

  // 2. Create source code zip
  const srcZip = new JSZip();
  await addFolderToZip(srcZip, '.', '.', ['node_modules', '.git', '.aistudio', 'public/dongfeng-vigo-dist.zip', 'public/dongfeng-vigo-source.zip', 'dongfeng-vigo-ev.tar.gz']);
  const srcBuffer = await srcZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(path.join('public', 'dongfeng-vigo-source.zip'), srcBuffer);
  console.log('Created public/dongfeng-vigo-source.zip (Size:', (srcBuffer.length / 1024).toFixed(1), 'KB)');
}

createZips().catch(console.error);
